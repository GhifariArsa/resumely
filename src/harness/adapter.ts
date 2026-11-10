import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterConfig, Config } from "../config";
import { UserError } from "../errors";
import { spawnWithTimeout } from "../proc";

export type { AdapterConfig };

export const PRESETS: Record<"claude" | "codex" | "pi", AdapterConfig> = {
  claude: {
    command: ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits", "--allowedTools", "Read Write Edit Glob"],
    check: ["claude", "--version"],
  },
  codex: {
    command: ["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", "{workspace}", "{prompt}"],
    check: ["codex", "--version"],
  },
  pi: {
    command: ["pi", "-p", "--no-session", "--tools", "read,write,edit", "{prompt}"],
    check: ["pi", "--version"],
  },
};

export function resolveAdapter(name: string, cfg: Config): AdapterConfig {
  const found = cfg.adapters[name] ?? (Object.hasOwn(PRESETS, name) ? PRESETS[name as keyof typeof PRESETS] : undefined);
  if (found) return found;
  const known = [...new Set([...Object.keys(PRESETS), ...Object.keys(cfg.adapters)])].join(", ");
  throw new UserError(`Unknown harness "${name}"`, `Known harnesses: ${known}`);
}

/** Substitute {prompt}/{workspace}/{model} in each argv element (single pass, no shell). */
export function expandCommand(a: AdapterConfig, vars: { prompt: string; workspace: string; model?: string }): string[] {
  const map: Record<string, string> = { prompt: vars.prompt, workspace: vars.workspace, model: vars.model ?? "" };
  return a.command.map((arg) => arg.replace(/\{(prompt|workspace|model)\}/g, (_, k: string) => map[k]!));
}

export type HarnessErrorKind = "not_installed" | "auth" | "rate_limit" | "timeout" | "unknown";

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
    default:
      return lastLine(out.stderr) ?? lastLine(out.stdout);
  }
}

export async function runHarness(
  a: AdapterConfig,
  /** `logSuffix` distinguishes attempts: "" → stdout.log, ".2" → stdout.2.log. */
  opts: { workspace: string; prompt: string; timeoutMs: number; model?: string; name: string; logSuffix?: string },
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const argv = expandCommand(a, opts);
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
