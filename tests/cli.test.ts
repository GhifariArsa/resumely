import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
