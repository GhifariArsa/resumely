import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AdapterConfig } from "../config";
import { HarnessError, runHarness } from "../harness/adapter";
import type { HarnessErrorKind } from "../harness/adapter";
import type { ValidationResult } from "./validate";

export function createRunWorkspace(runsDir: string, step: string, runId?: string): string {
  if (!/^[a-z0-9-]+$/.test(step)) throw new Error(`Invalid step name "${step}"`);
  const id = runId ?? newRunId();
  const ws = join(runsDir, id, step);
  mkdirSync(join(ws, "out"), { recursive: true });
  return ws;
}

export function newRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${ts}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

const BASE_PROMPT = "Read instructions.md in the current directory and follow it exactly. Write only the files it asks for.";
const RETRY_SUFFIX = "\n\nYour previous attempt was rejected. Read errors.md and fix every issue.";

export type Fallback = { name: string; adapter: AdapterConfig };

/** Finished agent steps of a run, keyed by step name (the workspace's basename). */
export interface StepCache {
  get(step: string): { harness: string } | null;
  /** `fallback`: a configured fallback harness (not the step's own) produced the output. */
  done(step: string, rec: { harness: string; outFile: string; fallback: boolean }): void;
}

/** Failure kinds where another harness might succeed. `invalid_output` and `unknown` never fall back. */
const FALLBACK_KINDS: HarnessErrorKind[] = ["not_installed", "auth", "rate_limit", "timeout"];

const inlinePrompt = (instructions: string, files: Record<string, string>, outFile: string): string =>
  instructions +
  Object.entries(files)
    .map(([name, content]) => `\n\n## ${name}\n\n\`\`\`\n${content.replace(/\n$/, "")}\n\`\`\``)
    .join("") +
  `\n\nWrite out/${outFile} with your file-writing tool. You do not need to read any files.`;

/** Read, parse and validate an agent's output file. */
function readOutput<T>(outPath: string, outFile: string, validate: (raw: unknown) => ValidationResult<T>): ValidationResult<T> {
  if (!existsSync(outPath)) return { ok: false, errors: [`out/${outFile} was not written`] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(outPath, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`out/${outFile} is not valid JSON: ${(e as Error).message}`] };
  }
  return validate(raw);
}

export async function runAgentStep<T>(opts: {
  adapter: AdapterConfig;
  name: string;
  workspace: string;
  instructions: string;
  files: Record<string, string>;
  outFile: string;
  validate: (raw: unknown) => ValidationResult<T>;
  timeoutMs: number;
  maxRetries?: number;
  onProgress?: (msg: string) => void;
  /** Tried in order when the primary fails with not_installed/auth/rate_limit/timeout. */
  fallbacks?: Fallback[];
  /** "inline" puts the instructions and files in the prompt itself (for agents that cannot read files). */
  promptMode?: "file" | "inline";
  /** A step recorded here whose out file still parses and validates is reused without spawning the agent. */
  checkpoint?: StepCache;
}): Promise<{ value: T; warnings: string[]; harness: string }> {
  const { workspace } = opts;
  const step = basename(workspace);
  const outPath = join(workspace, "out", opts.outFile);
  const cached = opts.checkpoint?.get(step);
  if (cached) {
    const r = readOutput(outPath, opts.outFile, opts.validate);
    if (r.ok) {
      opts.onProgress?.(`${step}: reused from checkpoint`);
      return { value: r.value, warnings: r.warnings, harness: cached.harness };
    }
  }
  const maxRetries = opts.maxRetries ?? 2;
  const inline = opts.promptMode === "inline";
  mkdirSync(join(workspace, "out"), { recursive: true });
  writeFileSync(join(workspace, "instructions.md"), opts.instructions);
  for (const [name, content] of Object.entries(opts.files)) writeFileSync(join(workspace, name), content);
  const errorsPath = join(workspace, "errors.md");
  const basePrompt = inline ? inlinePrompt(opts.instructions, opts.files, opts.outFile) : BASE_PROMPT;
  const candidates: Fallback[] = [{ name: opts.name, adapter: opts.adapter }, ...(opts.fallbacks ?? [])];

  for (const [ci, cand] of candidates.entries()) {
    let prompt = basePrompt;
    const logBase = ci === 0 ? "" : `.${cand.name}`;
    let fellBack = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      rmSync(outPath, { force: true });
      try {
        const logSuffix = attempt === 0 ? logBase : `${logBase}.${attempt + 1}`;
        await runHarness(cand.adapter, { workspace, prompt, timeoutMs: opts.timeoutMs, name: cand.name, logSuffix });
      } catch (e) {
        if (!(e instanceof HarnessError)) throw e;
        const next = candidates[ci + 1];
        if (next && FALLBACK_KINDS.includes(e.kind)) {
          opts.onProgress?.(`${cand.name} failed (${e.kind}); trying ${next.name}…`);
          fellBack = true;
          break;
        }
        throw new HarnessError(e.message, `${e.hint ? `${e.hint} ` : ""}(logs: ${workspace})`, e.kind);
      }

      const r = readOutput(outPath, opts.outFile, opts.validate);
      if (r.ok) {
        opts.checkpoint?.done(step, { harness: cand.name, outFile: opts.outFile, fallback: cand.name !== opts.name });
        return { value: r.value, warnings: r.warnings, harness: cand.name };
      }
      const errors = r.errors;
      const list = errors.map((e) => `- ${e}`).join("\n");
      writeFileSync(errorsPath, list + "\n");
      if (attempt < maxRetries) {
        opts.onProgress?.(`${cand.name} output rejected (${errors.length} issue${errors.length === 1 ? "" : "s"}), retrying…`);
        prompt = inline ? `${basePrompt}\n\nYour previous attempt was rejected:\n${list}` : BASE_PROMPT + RETRY_SUFFIX;
      }
    }
    // Output stayed invalid after every attempt: invalid output never falls back.
    if (!fellBack) break;
  }
  throw new HarnessError(`Agent output invalid after ${maxRetries + 1} attempts`, `Inspect ${workspace}`, "invalid_output");
}
