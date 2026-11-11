import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterConfig, Config } from "../config";
import { UserError } from "../errors";
import { spawnWithTimeout } from "../proc";
import type { Fallback } from "../pipeline/workspace";

export type { AdapterConfig };

export const PRESETS: Record<"claude" | "codex" | "pi", AdapterConfig> = {
  claude: {
    command: ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits", "--allowedTools", "Read Write Edit Glob"],
    research_command: ["claude", "-p", "{prompt}", "--tools", "WebSearch,WebFetch,Write", "--allowedTools", "WebSearch WebFetch Write", "--permission-mode", "acceptEdits", "--strict-mcp-config"],
    check: ["claude", "--version"],
    auth_check: ["claude", "auth", "status"],
  },
  codex: {
    command: ["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", "{workspace}", "{prompt}"],
    research_command: ["codex", "--search", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", "{workspace}", "{prompt}"],
    check: ["codex", "--version"],
    auth_check: ["codex", "login", "status"],
  },
  pi: {
    command: ["pi", "-p", "--no-session", "--tools", "read,write,edit", "{prompt}"],
    check: ["pi", "--version"],
  },
};

export function resolveAdapter(name: string, cfg: Config): AdapterConfig;
export function resolveAdapter(name: string, cfg: Config, opts: { research: true }): AdapterConfig | null;
export function resolveAdapter(name: string, cfg: Config, opts?: { research?: boolean }): AdapterConfig | null;
export function resolveAdapter(name: string, cfg: Config, opts?: { research?: boolean }): AdapterConfig | null {
  const found = cfg.adapters[name] ?? (Object.hasOwn(PRESETS, name) ? PRESETS[name as keyof typeof PRESETS] : undefined);
  if (!found) {
    const known = [...new Set([...Object.keys(PRESETS), ...Object.keys(cfg.adapters)])].join(", ");
    throw new UserError(`Unknown harness "${name}"`, `Known harnesses: ${known}`);
  }
  if (!opts?.research) return found;
  return found.research_command ? { ...found, command: found.research_command } : null;
}

/**
 * Substitute {prompt}/{workspace}/{model} in each argv element (single pass, no shell). With no model,
 * an element that is exactly "{model}" is dropped along with the flag before it (`--model {model}` vanishes).
 */
export function expandCommand(a: AdapterConfig, vars: { prompt: string; workspace: string; model?: string }): string[] {
  const map: Record<string, string> = { prompt: vars.prompt, workspace: vars.workspace, model: vars.model ?? "" };
  const out: string[] = [];
  for (const arg of a.command) {
    if (arg === "{model}" && !vars.model) {
      if (out.length > 1 && out.at(-1)!.startsWith("-")) out.pop();
      continue;
    }
    out.push(arg.replace(/\{(prompt|workspace|model)\}/g, (_, k: string) => map[k]!));
  }
  return out;
}

/** Resolve `fallback_harnesses` to adapters, dropping the primary and duplicates. */
export function resolveFallbacks(cfg: Config, primary: string): Fallback[] {
  const out: Fallback[] = [];
  for (const name of cfg.fallback_harnesses) {
    let adapter: AdapterConfig;
    try {
      adapter = resolveAdapter(name, cfg);
    } catch (e) {
      if (e instanceof UserError) throw new UserError(`Unknown harness "${name}" in fallback_harnesses`, e.hint);
      throw e;
    }
    if (name === primary || out.some((f) => f.name === name)) continue;
    out.push({ name, adapter });
  }
  return out;
}

export type HarnessErrorKind = "not_installed" | "auth" | "rate_limit" | "timeout" | "invalid_output" | "unknown";

export class HarnessError extends UserError {
  constructor(
    message: string,
    hint: string | undefined,
    public kind: HarnessErrorKind,
  ) {
    super(message, hint);
  }
}

/** `output` is everything the harness printed (stdout + stderr): some CLIs report errors on stdout. */
export function classifyFailure(
  _exitCode: number | null,
  output: string,
  timedOut: boolean,
  spawnErrorCode?: string,
): HarnessErrorKind {
  if (spawnErrorCode === "ENOENT") return "not_installed";
  if (timedOut) return "timeout";
  if (/usage limit|rate.?limit|\b429\b|quota/i.test(output)) return "rate_limit";
  if (/log ?in|logged out|unauthori[sz]ed|\b401\b|\bauth(entication|orization)?\b/i.test(output)) return "auth";
  return "unknown";
}

const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);

function hintFor(kind: HarnessErrorKind, name: string, bin: string, out: { stdout: string; stderr: string }): string | undefined {
  switch (kind) {
    case "not_installed":
      return `Install ${bin} or choose another harness with --harness`;
    case "auth":
      return `Log in to ${name} (run it interactively once)`;
    case "rate_limit":
      return "Usage limit reached; retry later or use --harness <other>";
    case "timeout":
      return "Raise timeout_minutes in config.toml";
    case "invalid_output":
      return "The agent's output failed validation; see errors.md in the workspace, or retry with --harness <other>";
    default:
      return lastLine(out.stderr) ?? lastLine(out.stdout);
  }
}

export async function runHarness(
  a: AdapterConfig,
  /** `logSuffix` distinguishes attempts: "" → stdout.log, ".2" → stdout.2.log. */
  opts: { workspace: string; prompt: string; timeoutMs: number; model?: string; name: string; logSuffix?: string },
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const argv = expandCommand(a, { ...opts, model: opts.model ?? a.model });
  const bin = a.command[0] ?? "";
  const fail = (kind: HarnessErrorKind, out: { stdout: string; stderr: string }): never => {
    throw new HarnessError(`${opts.name} failed (${kind})`, hintFor(kind, opts.name, bin, out), kind);
  };
  let r;
  try {
    r = await spawnWithTimeout(argv, { cwd: opts.workspace, env: process.env, timeoutMs: opts.timeoutMs });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return fail(classifyFailure(null, "", false, code), { stdout: "", stderr: String((e as Error).message ?? e) });
  }
  const suffix = opts.logSuffix ?? "";
  writeFileSync(join(opts.workspace, `stdout${suffix}.log`), r.stdout);
  writeFileSync(join(opts.workspace, `stderr${suffix}.log`), r.stderr);
  if (r.timedOut) return fail("timeout", r);
  if (r.exitCode !== 0) return fail(classifyFailure(r.exitCode, `${r.stdout}\n${r.stderr}`, false), r);
  return { stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs };
}
