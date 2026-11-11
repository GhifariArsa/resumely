import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";

const fx = join(import.meta.dir, "fixtures");
const hasLatex = Bun.which("latexmk") !== null;
const load = (f: string) => JSON.parse(readFileSync(join(fx, f), "utf8"));
const parsedJob = { company: "Atlas Freight", role: "Senior Backend Engineer", requirements: ["Rust", "Kafka"], nice_to_haves: [], keywords: ["Go", "PostgreSQL"], language: "en" };
const pass = load("review-pass.json");
const script = {
  parse: [{ "out/parsed-job.json": parsedJob }],
  research: [{ "out/company.json": load("company.json") }],
  "resume-write": [{ "out/resume.json": load("resume-content.json") }],
  "resume-review-1": [{ "out/review.json": pass }],
  "cover-write": [{ "out/cover-letter.json": load("cover-letter.json") }],
  "cover-review-1": [{ "out/review.json": { ...pass, scores: { ...pass.scores, voice: 4 }, templated: false } }],
};
const longResume = structuredClone(load("resume-content.json"));
{
  const b = longResume.sections[0].items[0].bullets;
  for (let i = 0; i < 40; i++) b.push({ ...b[0] });
}
const jobFile = join(fx, "jobs/backend.md");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-cli-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  const cmd = `["bun", "${join(fx, "fake-harness.ts")}", "{workspace}"]`;
  writeFileSync(layout(root).config, `harness = "fake"\n[adapters.fake]\ncommand = ${cmd}\nresearch_command = ${cmd}\n`);
  writeFileSync(join(root, "script.json"), JSON.stringify(script));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function cli(...args: string[]) {
  return cliEnv({}, ...args);
}
async function cliEnv(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, RESUMELY_HOME: root, FAKE_HARNESS_SCRIPT: join(root, "script.json"), ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
const setScript = (over: Record<string, unknown>) => writeFileSync(join(root, "script.json"), JSON.stringify({ ...script, ...over }));
const apps = () => readdirSync(layout(root).applications);

test("--review on a non-TTY exits 1", async () => {
  const r = await cli("apply", jobFile, "--review", "--no-open");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--review needs an interactive terminal");
});

test("apply with no input on a non-TTY exits 1", async () => {
  const r = await cli("apply", "--no-open");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("No job given");
});

test("mv renames an application and prints old → new", async () => {
  const { createApplication } = await import("../src/application/store");
  const app = createApplication(layout(root).applications, parsedJob, { kind: "file", text: "x" }, new Date(2026, 10, 11));
  const r = await cli("mv", app.slug, "--company", "Atlas Freight Inc");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain(`${app.slug} → 2026-11-11-atlas-freight-inc-senior-backend-engineer`);
  expect(apps()).toEqual(["2026-11-11-atlas-freight-inc-senior-backend-engineer"]);
  expect((await cli("mv", "atlas")).stderr).toContain("Nothing to change");
});

test("resume with no runs exits 1", async () => {
  const r = await cli("resume");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("No failed run to resume");
});

test.skipIf(!hasLatex)("a failed apply prints how to resume", async () => {
  const r = await cliEnv({ FAKE_HARNESS_FAIL_STEP: "cover-write" }, "apply", jobFile, "--no-open");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("done: resume v1");
  expect(r.stderr).toContain("failed: cover-letter: ");
  expect(r.stderr).toMatch(/hint: resume with: resumely resume \d{8}-\d{6}-[a-z0-9]{4} \[--harness <other>\]/);
}, 60_000);

test("status rejects an unknown status", async () => {
  const r = await cli("status", "x", "bogus");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('Unknown status "bogus"');
});

describe.skipIf(!hasLatex)("apply flow", () => {
  test("--into adds a version to the named application even when the posting does not match", async () => {
    expect((await cli("apply", jobFile, "--no-open")).code).toBe(0);
    const first = apps()[0]!;
    const otherJob = join(root, "other.md");
    writeFileSync(otherJob, "# Data Engineer at Other Co\nWe need Python.\n");
    setScript({ parse: [{ "out/parsed-job.json": { ...parsedJob, company: "Other Co", role: "Data Engineer" } }] });
    expect((await cli("apply", otherJob, "--no-open", "--no-cover")).code).toBe(0);
    expect(apps().length).toBe(2);
    const other = apps().find((a) => a !== first)!;

    const r = await cli("apply", jobFile, "--into", other, "--no-open", "--no-cover");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("done: resume v2");
    expect(apps().length).toBe(2);
    expect(readdirSync(join(layout(root).applications, other, "resume")).sort()).toEqual(["v1", "v2"]);
    expect(readdirSync(join(layout(root).applications, first, "resume"))).toEqual(["v1"]);
    expect(readdirSync(join(layout(root).applications, other, "job"))).toContain("raw-2.md");
  }, 120_000);

  test("a not-ready document exits 1; status applied needs --force; ls --company filters", async () => {
    setScript({ "resume-write": [{ "out/resume.json": longResume }] });
    const r = await cli("apply", jobFile, "--no-open", "--no-cover");
    expect(r.stderr).toContain("(not ready:");
    expect(r.code).toBe(1);
    const slug = apps()[0]!;
    const refused = await cli("status", slug, "applied");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("resume v1 is not ready");
    expect(refused.stderr).toContain("hint: Fix and re-run, or pass --force");
    const forced = await cli("status", slug, "applied", "--force");
    expect(forced.code).toBe(0);
    const ls = await cli("ls", "--company", "atlas");
    expect(ls.stdout).toContain("v1!");
    expect(ls.stdout).toContain("r1");
    expect((await cli("ls", "--company", "nomatch")).stdout).toContain("No applications match");
  }, 120_000);

  test("apply, duplicate guard, --new, status, ls, note, export", async () => {
    const first = await cli("apply", jobFile, "--no-open");
    expect(first.stderr).toContain("done: resume v1");
    expect(first.stderr).toContain("done: cover letter v1");
    expect(first.stderr.match(/^done:/gm)?.length).toBe(2);
    expect(first.stderr).toContain("(ready)");
    expect(first.code).toBe(0);
    expect(apps().length).toBe(1);

    const dup = await cli("apply", jobFile, "--no-open");
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("hint: Use --into");
    expect(apps().length).toBe(1);

    const slug = apps()[0]!;
    const into = await cli("apply", jobFile, "--into", slug, "--no-open");
    expect(into.code).toBe(0);
    expect(into.stderr).toContain("done: resume v2");
    expect(apps().length).toBe(1);

    const fresh = await cli("apply", jobFile, "--new", "--no-open");
    expect(fresh.code).toBe(0);
    expect(apps().length).toBe(2);

    const st = await cli("status", slug, "applied");
    expect(st.code).toBe(0);
    const ls = await cli("ls");
    expect(ls.stdout).toContain("applied");
    expect(ls.stdout).toContain("r2/c2");
    expect((await cli("ls", "--status", "offer")).stdout).toContain("No applications match");

    const note = await cli("note", slug, "sent", "via", "email");
    expect(note.code).toBe(0);
    expect(readFileSync(join(layout(root).applications, slug, "application.toml"), "utf8")).toContain("sent via email");

    const to = mkdtempSync(join(tmpdir(), "resumely-export-"));
    const ex = await cli("export", slug, "--to", to);
    expect(ex.code).toBe(0);
    expect(readdirSync(to).length).toBe(2);
    expect((await cli("export", slug, "--to", to)).code).toBe(1);
  }, 120_000);
});

describe.skipIf(!hasLatex)("trace and gaps hint", () => {
  test("apply prints the interview hint; trace reads the stored version", async () => {
    const r = await cli("apply", jobFile, "--no-open");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("hint: if any of these are true, add them: resumely interview --focus");
    const slug = apps()[0]!;
    const t = await cli("trace", slug);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain("resume v1");
    expect(t.stdout).toContain("exp-atlas-labs");
    expect((await cli("trace", slug, "--cover")).stdout).toContain("paragraph 1");
    const j = JSON.parse((await cli("trace", slug, "--json")).stdout);
    expect(j.kind).toBe("resume");
    expect(j.rows.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("profile add", () => {
  async function cliIn(stdin: string, ...args: string[]) {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
      env: { ...process.env, RESUMELY_HOME: root },
      stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  }
  const inbox = () => {
    const dir = join(layout(root).profile, ".inbox");
    return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  };

  test("--json - keeps hostile text byte-for-byte and records the source", async () => {
    const title = 'Lead "R&D" — C# $HOME `x`';
    const context = "grew 100%\nsecond line";
    const r = await cliIn(JSON.stringify({ type: "experience", title, org: "Hostile Co", context }), "profile", "add", "--json", "-", "--source", "interview");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^proposed 1-exp-/);
    const [p] = inbox();
    expect(p.entry.title).toBe(title);
    expect(p.entry.context).toBe(context);
    expect(p.source.kind).toBe("interview");
  });

  test("a bad flag is one error line", async () => {
    const r = await cli("profile", "add", "experience", "--title", "X", "--start", "nope");
    expect(r.code).toBe(1);
    const lines = r.stderr.split("\n").filter((l) => l.startsWith("error:"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toStartWith("error: invalid proposal: start");
  });

  test("already-known skills stage nothing", async () => {
    const r = await cli("profile", "add", "skills", "--category", "Languages", "--skill", "Go");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nothing new");
  });
});

describe("profile review", () => {
  const env = () => ({ ...process.env, RESUMELY_HOME: root });
  async function run(stdin: string | undefined, ...args: string[]) {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
      env: env(), stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  }
  const add = (title: string, org: string) => run(JSON.stringify({ type: "experience", title, org, start: "2020-01", end: "2021-01", bullets: ["Did a thing"] }), "profile", "add", "--json", "-");

  test("non-TTY without flags exits 1 with a hint", async () => {
    const r = await run(undefined, "profile", "review");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--accept-all");
  });
  test("--list shows staged proposals; --accept applies", async () => {
    await add("Engineer", "Acme");
    await add("Designer", "Beta Co");
    const l = await run(undefined, "profile", "review", "--list");
    expect(l.stdout).toContain("1-exp-acme");
    expect(l.stdout).toContain("2-exp-beta-co");
    const a = await run(undefined, "profile", "review", "--accept", "1");
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("accepted 1-exp-acme");
    expect((await run(undefined, "profile", "show", "exp-acme")).code).toBe(0);
  });
  test("--accept-all leaves duplicates pending", async () => {
    await add("Engineer", "Acme");
    await run(JSON.stringify({ type: "experience", title: "Senior Software Engineer", org: "Atlas Labs", start: "2023-03", end: "present", bullets: ["x"] }), "profile", "add", "--json", "-");
    const r = await run(undefined, "profile", "review", "--accept-all");
    expect(r.stdout).toContain("accepted 1-exp-acme");
    expect(r.stdout).toContain("needs a decision");
    expect((await run(undefined, "profile", "review", "--list")).stdout).toContain("duplicate");
  });
  test("--as needs exactly one --accept", async () => {
    await add("Engineer", "Acme");
    await add("Designer", "Beta Co");
    const r = await run(undefined, "profile", "review", "--accept", "1", "--accept", "2", "--as", "new");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--as");
  });
});

test("interview on a non-TTY exits 1", async () => {
  const r = await cli("interview");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("interview needs an interactive terminal");
});

describe("new-user path", () => {
  const callsFile = () => join(root, "script.json.calls");
  const proposalsScript = {
    import: [{
      "out/proposals.json": {
        proposals: [
          { kind: "new", entry: { type: "experience", title: "Staff Engineer", org: "Acme Robotics", start: "2025-01", end: "present", skills: ["Rust"], tags: [], bullets: ["Cut fleet downtime 35% across 120 robots"] }, rationale: "New role" },
          { kind: "update", target_id: "exp-atlas-labs", entry: { type: "experience", title: "Senior Software Engineer", org: "Atlas Labs", location: "Montreal, QC", start: "2023-03", end: "present", skills: ["TypeScript"], tags: [], bullets: ["Reduced infra spend by 18%"] }, rationale: "Adds a result" },
        ],
        skills: { Languages: ["Rust"] },
        about: null,
      },
    }],
  };

  test("init prints the next steps", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "resumely-init-"));
    try {
      const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "init"], { env: { ...process.env, RESUMELY_HOME: fresh }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      expect(out).toContain("resumely profile import");
      expect(out).toContain("resumely apply --clip");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("--help has a Getting started block", async () => {
    expect((await cli("--help")).stdout).toContain("Getting started:");
  });

  test("profile import stages proposals; review --accept-all makes them live", async () => {
    setScript(proposalsScript);
    const r = await cli("profile", "import", join(fx, "import", "resume.md"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("staged 3 proposals");
    expect(r.stdout).toContain("exp-acme-robotics");
    expect(r.stdout).toContain("next: resumely profile review");
    expect(r.stderr).toContain("extracting proposals");
    expect((await cli("profile", "review", "--accept-all")).code).toBe(0);
    expect((await cli("profile", "show", "exp-acme-robotics")).code).toBe(0);
  });

  test("profile import with nothing new says so", async () => {
    setScript({ import: [{ "out/proposals.json": { proposals: [], skills: {}, about: null } }] });
    const r = await cli("profile", "import", join(fx, "import", "resume.md"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nothing new found in");
  });

  test("profile import rejects an unsupported file", async () => {
    writeFileSync(join(root, "nope.rtf"), "{\\rtf1 hi}");
    const r = await cli("profile", "import", join(root, "nope.rtf"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("hint: Use .pdf");
  });

  test("profile lint reports, fails on errors, and has --json", async () => {
    const ok = await cli("profile", "lint");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("outcome-less-bullet");
    expect(Array.isArray(JSON.parse((await cli("profile", "lint", "--json")).stdout))).toBe(true);
    writeFileSync(join(layout(root).profile, "projects", "routekit.md"), "---\n: [bad\n---\nbody\n");
    const bad = await cli("profile", "lint");
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("parse-error");
  });

  test("apply refuses an empty profile without calling the agent", async () => {
    for (const sub of ["experience", "projects", "education", "extras"]) {
      const d = join(layout(root).profile, sub);
      for (const f of readdirSync(d)) rmSync(join(d, f), { recursive: true, force: true });
    }
    const r = await cli("apply", jobFile, "--no-open");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("hint: Run: resumely profile import");
    expect(existsSync(callsFile())).toBe(false);
  });

  test("apply on an empty profile with pending proposals points at review", async () => {
    for (const sub of ["experience", "projects", "education", "extras"]) {
      const d = join(layout(root).profile, sub);
      for (const f of readdirSync(d)) rmSync(join(d, f), { recursive: true, force: true });
    }
    const add = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "profile", "add", "--json", "-"], {
      env: { ...process.env, RESUMELY_HOME: root }, stdin: new Blob([JSON.stringify({ type: "experience", title: "Engineer", org: "Zed", start: "2020-01", end: "2021-01", bullets: ["x"] })]), stdout: "pipe", stderr: "pipe",
    });
    await add.exited;
    const r = await cli("apply", jobFile, "--no-open");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("1 profile proposals awaiting review");
    expect(r.stderr).toContain("hint: Run: resumely profile review");
    expect(existsSync(callsFile())).toBe(false);
  });

  test("apply warns about pending proposals", async () => {
    const add = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "profile", "add", "--json", "-"], {
      env: { ...process.env, RESUMELY_HOME: root }, stdin: new Blob([JSON.stringify({ type: "experience", title: "Engineer", org: "Zed", start: "2020-01", end: "2021-01", bullets: ["x"] })]), stdout: "pipe", stderr: "pipe",
    });
    await add.exited;
    const r = await cli("apply", jobFile, "--no-open");
    expect(r.stderr).toContain("1 profile proposals awaiting review");
  });
});

describe("integration A: profile add --update keeps live data", () => {
  test("A1: a bullet-only --update accepted with --accept keeps location, skills and tags", async () => {
    const a = await cli("profile", "add", "experience", "--update", "exp-atlas-labs", "--title", "Senior Software Engineer", "--bullet", "Interview bullet");
    expect(a.code).toBe(0);
    const r = await cli("profile", "review", "--accept", "1");
    expect(r.code).toBe(0);
    const text = readFileSync(join(layout(root).profile, "experience", "atlas-labs.md"), "utf8");
    expect(text).toContain("location: Montreal, QC");
    expect(text).toContain("skills: [TypeScript, React, PostgreSQL]");
    expect(text).toContain("tags: [backend, frontend]");
    expect(text).not.toContain("skills: []");
    expect(text).toContain("- Interview bullet");
  });
});

describe.skipIf(Bun.which("expect") === null)("profile review editor keeps stdin", () => {
  test("the editor receives keystrokes typed after it opens, and review continues", async () => {
    const add = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "profile", "add", "--json", "-"], {
      env: { ...process.env, RESUMELY_HOME: root }, stdin: new Blob([JSON.stringify({ type: "experience", title: "Engineer", org: "Zed", start: "2020-01", end: "2021-01", bullets: ["x"] })]), stdout: "pipe", stderr: "pipe",
    });
    await add.exited;
    const exp = join(root, "pty.exp");
    const log = join(root, "pty.log");
    writeFileSync(exp, `set timeout 20
log_file -noappend ${log}
spawn bun ${join(import.meta.dir, "../src/cli.ts")} profile review
expect "uit: "
send "e\\r"
sleep 2
send "HELLO-FROM-KEYS\\r"
expect "uit: "
send "q\\r"
expect eof
`);
    const p = Bun.spawn(["expect", exp], {
      env: { ...process.env, RESUMELY_HOME: root, EDITOR: `sh ${join(fx, "fake-editor-stdin.sh")}` },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await p.exited;
    const out = readFileSync(log, "utf8");
    expect(out).toContain("<!-- typed: HELLO-FROM-KEYS -->");
    expect(out).toContain("1 still pending");
  }, 40_000);
});

describe("final review fixes", () => {
  const addJson = async (obj: Record<string, unknown>, env: Record<string, string> = {}) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "profile", "add", "--json", "-"], {
      env: { ...process.env, RESUMELY_HOME: root, ...env }, stdin: new Blob([JSON.stringify(obj)]), stdout: "pipe", stderr: "pipe",
    });
    return p.exited;
  };

  test("I3: --accept-all leaves a new proposal that became a duplicate pending", async () => {
    await addJson({ type: "experience", title: "Senior Engineer", org: "Acme Robotics", start: "2024-01", end: "present", bullets: ["A"] });
    await addJson({ type: "experience", title: "Sr. Engineer", org: "Acme Robotics", start: "2024-01", end: "present", bullets: ["B"] });
    const r = await cli("profile", "review", "--accept-all");
    expect(r.stdout).toContain("accepted 1-exp-acme-robotics");
    expect(r.stdout).toContain("needs a decision: 2-exp-acme-robotics-2");
    expect(existsSync(join(layout(root).profile, "experience", "acme-robotics-2.md"))).toBe(false);
    expect((await cli("profile", "review", "--list")).stdout).toContain("2-exp-acme-robotics-2");
  });

  test("I5: profile review refuses to decide when run by the interview agent", async () => {
    expect(await addJson({ type: "experience", title: "Engineer", org: "Zed", start: "2020-01", end: "2021-01", bullets: ["x"] }, { RESUMELY_AGENT: "interview" })).toBe(0);
    const env = { ...process.env, RESUMELY_HOME: root, RESUMELY_AGENT: "interview" };
    for (const args of [["--accept", "1"], ["--accept-all"], ["--reject", "1"]]) {
      const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "profile", "review", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(1);
      expect(stderr).toContain("only you can decide");
    }
    const list = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "profile", "review", "--list"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(await new Response(list.stdout).text()).toContain("1-exp-zed");
    expect(existsSync(join(layout(root).profile, "experience", "zed.md"))).toBe(false);
  });
});

describe.skipIf(Bun.which("expect") === null)("apply prompts and Ctrl-C", () => {
  test("I4: a SIGINT handler runs while Continue? [Y/n] is waiting", async () => {
    const exp = join(root, "sigint.exp");
    const log = join(root, "sigint.log");
    writeFileSync(exp, `set timeout 10
log_file -noappend ${log}
spawn bun ${join(fx, "prompt-sigint.ts")}
expect "Continue?"
sleep 0.5
send "\\003"
sleep 1
send "\\r"
expect eof
`);
    const p = Bun.spawn(["expect", exp], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await p.exited;
    const out = readFileSync(log, "utf8");
    expect(out).toContain("SIGINT-HANDLED");
    expect(out).not.toContain("ANSWERED");
  }, 30_000);
});

/** Run an expect script that spawns the CLI, waits for `prompt`, sends Ctrl-C and reports how the CLI ended. */
async function ctrlCAt(args: string[], prompt: string): Promise<{ log: string; elapsedMs: number; wait: string }> {
  const exp = join(root, "ctrl-c.exp");
  const log = join(root, "ctrl-c.log");
  writeFileSync(exp, `set timeout 20
log_file -noappend ${log}
spawn bun ${join(import.meta.dir, "../src/cli.ts")} ${args.join(" ")}
expect "${prompt}"
set t0 [clock milliseconds]
send "\\003"
set timeout 5
expect {
  eof {}
  timeout { puts "RESULT HUNG"; exit 1 }
}
set t1 [clock milliseconds]
puts "RESULT [expr {$t1 - $t0}] [wait]"
`);
  const p = Bun.spawn(["expect", exp], {
    env: { ...process.env, RESUMELY_HOME: root, FAKE_HARNESS_SCRIPT: join(root, "script.json") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const m = out.match(/RESULT (\d+) (.*)/);
  if (!m) throw new Error(`the CLI did not exit within 5 s of Ctrl-C: ${out.trim()}`);
  return { log: readFileSync(log, "utf8"), elapsedMs: Number(m[1]), wait: m[2]!.trim() };
}
/** Exit code 130, or killed by SIGINT (what a shell reports as 130). */
const interrupted = (wait: string) => / 0 130$/.test(wait) || /CHILDKILLED SIGINT/.test(wait);

describe.skipIf(Bun.which("expect") === null || !hasLatex)("integration C: Ctrl-C at apply prompts", () => {
  test("Ctrl-C at Continue? [Y/n] exits 130 promptly and leaves no running run", async () => {
    const r = await ctrlCAt(["apply", jobFile, "--review", "--no-open"], "Continue?");
    expect(r.wait).toMatch(/ 0 130$/);
    expect(r.elapsedMs).toBeLessThanOrEqual(2000);
    const states = readdirSync(layout(root).runs).map((d) => JSON.parse(readFileSync(join(layout(root).runs, d, "state.json"), "utf8")));
    expect(states).toHaveLength(1);
    expect(states[0].status).not.toBe("running");
  }, 40_000);
});

describe.skipIf(Bun.which("expect") === null)("integration C: Ctrl-C at profile review", () => {
  test("Ctrl-C at the review prompt exits promptly and keeps the proposal pending", async () => {
    const add = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "profile", "add", "--json", "-"], {
      env: { ...process.env, RESUMELY_HOME: root }, stdin: new Blob([JSON.stringify({ type: "experience", title: "Engineer", org: "Zed", start: "2020-01", end: "2021-01", bullets: ["x"] })]), stdout: "pipe", stderr: "pipe",
    });
    expect(await add.exited).toBe(0);
    const r = await ctrlCAt(["profile", "review"], "uit: ");
    expect(interrupted(r.wait)).toBe(true);
    expect(r.elapsedMs).toBeLessThanOrEqual(2000);
    expect((await cli("profile", "review", "--list")).stdout).toContain("1-exp-zed");
  }, 40_000);
});

describe("ui command", () => {
  test("rejects a non-numeric --port", async () => {
    const r = await cli("ui", "--port", "abc");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Invalid --port "abc"');
  });

  test("rejects --port above 65535", async () => {
    const r = await cli("ui", "--port", "70000");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Invalid --port "70000"');
  });

  test("an empty data root is a UserError", async () => {
    const empty = mkdtempSync(join(tmpdir(), "resumely-empty-"));
    try {
      const r = await cliEnv({ RESUMELY_HOME: empty }, "ui", "--no-open");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("No resumely data root");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("an explicit busy --port exits 1 with a hint", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    try {
      const r = await cli("ui", "--port", String(blocker.port), "--no-open");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`Port ${blocker.port} is in use`);
      expect(r.stderr).toContain("hint: Pick another with --port");
    } finally {
      blocker.stop(true);
    }
  });

  test("serves the board and exits 0 on SIGTERM", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "ui", "--port", "0", "--no-open"], {
      env: { ...process.env, RESUMELY_HOME: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 10_000;
      let url: string | undefined;
      while (!url && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
        if (!chunk || chunk.done) break;
        buf += dec.decode(chunk.value);
        url = buf.match(/running at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
      }
      expect(url).toBeDefined();
      const res = await fetch(url!);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Applications");
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 20_000);
});
