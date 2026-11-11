import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { loadConfig } from "../src/config";
import { UserError } from "../src/errors";
import { HarnessError } from "../src/harness/adapter";
import { layout } from "../src/paths";
import { expandInteractive, INTERACTIVE_PRESETS, INTERVIEW_PROMPT, interviewHint, launchInterview, resolveInteractive } from "../src/profile/interview";

const fx = join(import.meta.dir, "fixtures");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-interview-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = (toml: string) => {
  writeFileSync(layout(root).config, toml);
  return loadConfig(root);
};

describe("resolveInteractive", () => {
  test("codex preset makes the inbox writable", () => {
    const argv = resolveInteractive("codex", config(""));
    expect(argv).toContain("--add-dir");
    expect(argv).toContain("{inbox}");
    expect(argv).toEqual(INTERACTIVE_PRESETS.codex);
  });
  test("a user interactive_command wins over the preset", () => {
    const cfg = config('[adapters.claude]\ncommand = ["x"]\ninteractive_command = ["mine", "{prompt}"]\n');
    expect(resolveInteractive("claude", cfg)).toEqual(["mine", "{prompt}"]);
  });
  test("a configured adapter without interactive_command or preset is a UserError", () => {
    const cfg = config('[adapters.fake]\ncommand = ["x"]\n');
    try {
      resolveInteractive("fake", cfg);
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as UserError).hint).toContain("interactive_command");
    }
  });
  test("an unknown harness is the usual Unknown harness error", () => {
    expect(() => resolveInteractive("nope", config(""))).toThrow('Unknown harness "nope"');
  });
});

test("expandInteractive substitutes inbox, prompt and workspace", () => {
  expect(expandInteractive(["c", "--add-dir", "{inbox}", "{prompt}"], { prompt: "P", workspace: "/w", inbox: "/i" })).toEqual(["c", "--add-dir", "/i", "P"]);
  expect(expandInteractive(["c", "-C", "{workspace}"], { prompt: "P", workspace: "/w", inbox: "/i" })).toEqual(["c", "-C", "/w"]);
});

describe("launchInterview", () => {
  test("injected spawn sees the workspace, env, argv and written files", async () => {
    config('harness = "claude"\n');
    let seen: { argv: string[]; cwd: string; env: Record<string, string | undefined> } | undefined;
    const r = await launchInterview({
      root,
      focus: "Kafka, team leadership",
      spawn: async (argv, opts) => {
        seen = { argv, ...opts };
        return 3;
      },
    });
    expect(r.exitCode).toBe(3);
    expect(r.proposals).toEqual([]);
    expect(seen!.argv.at(-1)).toBe(INTERVIEW_PROMPT);
    expect(seen!.cwd).toBe(r.workspace);
    expect(basename(seen!.cwd)).toBe("interview");
    expect(seen!.env.RESUMELY_HOME).toBe(root);
    const ins = readFileSync(join(r.workspace, "instructions.md"), "utf8");
    expect(ins).toContain("profile add");
    expect(ins).toContain("Kafka, team leadership");
    expect(ins).not.toContain("{{");
    expect(readFileSync(join(r.workspace, "profile.json"), "utf8")).not.toContain("Compensation");
    expect(JSON.parse(readFileSync(join(r.workspace, "resumely.json"), "utf8")).add[0]).toBe(process.execPath);
  });

  test("codex preset gets an existing inbox path", async () => {
    config('harness = "codex"\n');
    let argv: string[] = [];
    await launchInterview({ root, spawn: async (a) => ((argv = a), 0) });
    const inbox = argv[argv.indexOf("--add-dir") + 1]!;
    expect(inbox).toBe(join(layout(root).profile, ".inbox"));
    expect(existsSync(inbox)).toBe(true);
  });

  test("end to end with a fake interactive harness", async () => {
    const proposal = join(root, "proposal.json");
    writeFileSync(proposal, JSON.stringify({ type: "experience", title: "Staff Engineer", org: "Acme Robotics", start: "2024-01", end: "present", bullets: ["Led the platform team"] }));
    config(`harness = "fake"\n[adapters.fake]\ncommand = ["x"]\ninteractive_command = ["bun", "${join(fx, "fake-interactive.ts")}", "{workspace}"]\n`);
    const saved = { p: process.env.FAKE_INTERVIEW_PROPOSAL, a: process.env.FAKE_INTERVIEW_ARGV };
    process.env.FAKE_INTERVIEW_PROPOSAL = proposal;
    process.env.FAKE_INTERVIEW_ARGV = join(root, "argv.log");
    try {
      const r = await launchInterview({ root });
      expect(r.exitCode).toBe(0);
      expect(r.proposals).toHaveLength(1);
      expect(r.proposals[0]!.source.kind).toBe("interview");
    } finally {
      for (const [k, v] of [["FAKE_INTERVIEW_PROPOSAL", saved.p], ["FAKE_INTERVIEW_ARGV", saved.a]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("ENOENT from spawn is a not_installed HarnessError", async () => {
    config('harness = "claude"\n');
    const err = await launchInterview({
      root,
      spawn: async () => {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.kind).toBe("not_installed");
    expect(err.message).toBe("claude is not installed");
  });
});

describe("final review fixes", () => {
  test("I5: the harness runs with RESUMELY_AGENT=interview", async () => {
    config('harness = "claude"\n');
    let env: Record<string, string | undefined> = {};
    await launchInterview({ root, spawn: async (_a, o) => ((env = o.env), 0) });
    expect(env.RESUMELY_AGENT).toBe("interview");
  });

  test("I6: the gap hint single-quotes untrusted text so the shell never expands it", async () => {
    const marker = join(root, "pwned");
    const reqs = [`Rust $(touch ${marker})`, "`touch " + marker + "`", "it's \"fine\" \\ $HOME"];
    const hint = interviewHint(reqs);
    expect(hint.startsWith("resumely interview --focus '")).toBe(true);
    const sh = Bun.spawn(["sh", "-c", `printf '%s' ${hint.slice("resumely interview --focus ".length)}`], { stdout: "pipe" });
    expect(await new Response(sh.stdout).text()).toBe(reqs.join(", "));
    expect(existsSync(marker)).toBe(false);
  });
});
