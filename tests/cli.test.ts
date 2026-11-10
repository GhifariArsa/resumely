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
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, RESUMELY_HOME: root, FAKE_HARNESS_SCRIPT: join(root, "script.json") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
const apps = () => readdirSync(layout(root).applications);

test("--review on a non-TTY exits 1", async () => {
  const r = await cli("apply", jobFile, "--review", "--no-open");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--review needs an interactive terminal");
});

test("status rejects an unknown status", async () => {
  const r = await cli("status", "x", "bogus");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('Unknown status "bogus"');
});

describe.skipIf(!hasLatex)("apply flow", () => {
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
