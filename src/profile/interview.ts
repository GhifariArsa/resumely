import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig, type Config } from "../config";
import { UserError } from "../errors";
import { expandCommand, HarnessError, PRESETS } from "../harness/adapter";
import { layout } from "../paths";
import { createRunWorkspace } from "../pipeline/workspace";
import { buildAgentPayload } from "./context";
import { inboxDir, listProposals } from "./inbox";
import { loadProfile } from "./load";
import type { Proposal } from "./proposal";

/** Interactive launch argv per harness, checked against each CLI's `--help` on 2026-11-11. */
export const INTERACTIVE_PRESETS: Record<"claude" | "codex" | "pi", string[]> = {
  // A bare positional prompt starts an interactive session; Bash calls go through Claude's own permission prompt.
  claude: ["claude", "{prompt}"],
  // --add-dir makes the review inbox writable from the sandbox.
  codex: ["codex", "-C", "{workspace}", "-s", "workspace-write", "--add-dir", "{inbox}", "{prompt}"],
  pi: ["pi", "--tools", "read,bash", "{prompt}"],
};

export const INTERVIEW_PROMPT = "Read instructions.md in the current directory and follow it. Start the interview now.";

const DEFAULT_FOCUS = "Ask broadly: recent work first, then projects, education, awards.";

export function resolveInteractive(name: string, cfg: Config): string[] {
  const adapter = cfg.adapters[name];
  if (adapter?.interactive_command) return adapter.interactive_command;
  if (Object.hasOwn(INTERACTIVE_PRESETS, name)) return INTERACTIVE_PRESETS[name as keyof typeof INTERACTIVE_PRESETS];
  if (adapter) {
    throw new UserError(`Harness "${name}" has no interactive_command`, `Set [adapters.${name}] interactive_command = [...] in config.toml`);
  }
  const known = [...new Set([...Object.keys(PRESETS), ...Object.keys(cfg.adapters)])].join(", ");
  throw new UserError(`Unknown harness "${name}"`, `Known harnesses: ${known}`);
}

export function expandInteractive(argv: string[], vars: { prompt: string; workspace: string; inbox: string; model?: string }): string[] {
  const command = argv.map((a) => a.replaceAll("{inbox}", () => vars.inbox));
  return expandCommand({ command }, vars);
}

/** How to run this CLI again: the compiled binary itself, or `bun <cli.ts>` when running from source. */
export function selfCommand(): string[] {
  const exe = basename(process.execPath);
  return exe === "bun" || exe === "bun.exe" ? [process.execPath, resolve(import.meta.dir, "../cli.ts")] : [process.execPath];
}

type SpawnFn = (argv: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => Promise<number>;

const spawnInherit: SpawnFn = async (argv, opts) => {
  const p = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return p.exited;
};

const shellQuote = (a: string) => (/\s/.test(a) ? `'${a.replaceAll("'", `'\\''`)}'` : a);

/** Open the harness interactively with instructions to interview the user and stage proposals (never the live profile). */
export async function launchInterview(o: { root: string; harness?: string; focus?: string; spawn?: SpawnFn }): Promise<{ workspace: string; exitCode: number; proposals: Proposal[] }> {
  const l = layout(o.root);
  const config = loadConfig(o.root);
  const name = o.harness ?? config.harness;
  const template = resolveInteractive(name, config);
  const profile = loadProfile(l.profile);
  const inbox = inboxDir(l.profile);
  mkdirSync(inbox, { recursive: true });
  const before = new Set(listProposals(l.profile).map((p) => p.pid));

  const workspace = createRunWorkspace(l.runs, "interview");
  const add = [...selfCommand(), "profile", "add"];
  const instructions = (await Bun.file(join(import.meta.dir, "..", "pipeline", "prompts", "interview.md")).text())
    .replaceAll("{{add_command}}", () => add.map(shellQuote).join(" "))
    .replaceAll("{{focus}}", () => o.focus?.trim() || DEFAULT_FOCUS);
  writeFileSync(join(workspace, "profile.json"), JSON.stringify(buildAgentPayload(profile), null, 2));
  writeFileSync(join(workspace, "resumely.json"), JSON.stringify({ add }, null, 2));
  writeFileSync(join(workspace, "instructions.md"), instructions);

  const argv = expandInteractive(template, { prompt: INTERVIEW_PROMPT, workspace, inbox, model: config.adapters[name]?.model });
  let exitCode: number;
  try {
    exitCode = await (o.spawn ?? spawnInherit)(argv, { cwd: workspace, env: { ...process.env, RESUMELY_HOME: o.root } });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HarnessError(`${name} is not installed`, `Install ${argv[0]} or choose another harness with --harness`, "not_installed");
    }
    throw e;
  }
  return { workspace, exitCode, proposals: listProposals(l.profile).filter((p) => !before.has(p.pid)) };
}
