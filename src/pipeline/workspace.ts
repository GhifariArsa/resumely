import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterConfig } from "../config";
import { UserError } from "../errors";
import { runHarness } from "../harness/adapter";
import type { ValidationResult } from "./validate";

export function createRunWorkspace(runsDir: string, step: "parse" | "write", runId?: string): string {
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
}): Promise<T> {
  const { workspace } = opts;
  const maxRetries = opts.maxRetries ?? 2;
  mkdirSync(join(workspace, "out"), { recursive: true });
  writeFileSync(join(workspace, "instructions.md"), opts.instructions);
  for (const [name, content] of Object.entries(opts.files)) writeFileSync(join(workspace, name), content);
  const outPath = join(workspace, "out", opts.outFile);
  const errorsPath = join(workspace, "errors.md");

  let prompt = BASE_PROMPT;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    rmSync(outPath, { force: true });
    await runHarness(opts.adapter, { workspace, prompt, timeoutMs: opts.timeoutMs, name: opts.name });

    let errors: string[];
    if (!existsSync(outPath)) {
      errors = [`out/${opts.outFile} was not written`];
    } else {
      let raw: unknown;
      let parseError: string | undefined;
      try {
        raw = JSON.parse(readFileSync(outPath, "utf8"));
      } catch (e) {
        parseError = `out/${opts.outFile} is not valid JSON: ${(e as Error).message}`;
      }
      if (parseError) {
        errors = [parseError];
      } else {
        const r = opts.validate(raw);
        if (r.ok) return r.value;
        errors = r.errors;
      }
    }
    writeFileSync(errorsPath, errors.map((e) => `- ${e}`).join("\n") + "\n");
    if (attempt < maxRetries) {
      opts.onProgress?.(`${opts.name} output rejected (${errors.length} issue${errors.length === 1 ? "" : "s"}), retrying…`);
      prompt = BASE_PROMPT + RETRY_SUFFIX;
    }
  }
  throw new UserError(`Agent output invalid after ${maxRetries + 1} attempts`, `Inspect ${workspace}`);
}
