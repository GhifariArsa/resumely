import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterConfig, Config } from "../config";
import { UserError } from "../errors";

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

export function classifyFailure(
  _exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  spawnErrorCode?: string,
): HarnessErrorKind {
  if (spawnErrorCode === "ENOENT") return "not_installed";
  if (timedOut) return "timeout";
  if (/usage limit|rate.?limit|429|quota/i.test(stderr)) return "rate_limit";
  if (/log ?in|logged out|unauthori[sz]ed|401|auth/i.test(stderr)) return "auth";
  return "unknown";
}

function hintFor(kind: HarnessErrorKind, name: string, bin: string, stderr: string): string | undefined {
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
      return stderr.trim().split("\n").slice(-1)[0] || undefined;
  }
}

export async function runHarness(
  a: AdapterConfig,
  opts: { workspace: string; prompt: string; timeoutMs: number; model?: string; name: string },
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const argv = expandCommand(a, opts);
  const bin = a.command[0] ?? "";
  const fail = (kind: HarnessErrorKind, stderr: string): never => {
    throw new HarnessError(`${opts.name} failed (${kind})`, hintFor(kind, opts.name, bin, stderr), kind);
  };
  const start = Date.now();
  let proc;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.workspace,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: true, // own process group so a timeout can kill the whole tree
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return fail(classifyFailure(null, "", false, code), String((e as Error).message ?? e));
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((res) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      res("timeout");
    }, opts.timeoutMs);
  });
  const work = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let out: [string, string, number] | "timeout";
  try {
    out = await Promise.race([work, timeoutP]);
  } finally {
    clearTimeout(timer);
  }
  if (out === "timeout" || timedOut) {
    work.catch(() => {});
    return fail("timeout", "");
  }
  const [stdout, stderr, exitCode] = out;
  writeFileSync(join(opts.workspace, "stdout.log"), stdout);
  writeFileSync(join(opts.workspace, "stderr.log"), stderr);
  if (exitCode !== 0) return fail(classifyFailure(exitCode, stderr, false), stderr);
  return { stdout, stderr, durationMs: Date.now() - start };
}
