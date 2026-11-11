import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";
import { applyJob, resumeRun } from "../src/pipeline/apply";
import { readJobFile } from "../src/job/intake";
import { listApplications } from "../src/application/store";
import { UserError } from "../src/errors";
import { HarnessError } from "../src/harness/adapter";

const fx = join(import.meta.dir, "fixtures");
const hasLatex = Bun.which("latexmk") !== null;
const parsedJob = { company: "Atlas Freight", role: "Senior Backend Engineer", requirements: ["Rust", "Kafka"], nice_to_haves: [], keywords: ["Go", "PostgreSQL"], language: "en" };
const load = (f: string) => JSON.parse(readFileSync(join(fx, f), "utf8"));
const resume = load("resume-content.json");
const cover = load("cover-letter.json");
const company = load("company.json");
const pass = load("review-pass.json");
const revise = load("review-revise.json");
const coverPass = { ...pass, scores: { ...pass.scores, voice: 4 }, templated: false };
const revised = structuredClone(resume);
revised.sections[0].items[0].bullets.reverse();
/** The fixture letter, also citing proj-ledgerly. */
const coverLedgerly = structuredClone(cover);
coverLedgerly.paragraphs[1].entry_ids = ["exp-atlas-labs", "proj-ledgerly"];
/** The fixture letter with no company-fact citations, for runs without research. */
const coverNoResearch = structuredClone(cover);
coverNoResearch.paragraphs[0] = {
  text:
    "The Senior Backend Engineer posting at Atlas Freight caught my attention because the role centres on services that keep shipment state consistent while tracking events pour in. That is the kind of backend work I enjoy most: ordering, retries and back pressure stop being abstract when a late message means a late delivery, and the posting reads like a team that takes those problems seriously.",
  entry_ids: [],
  company_fact_ids: [],
};
coverNoResearch.paragraphs[3].company_fact_ids = [];

const ENV = ["FAKE_HARNESS_SCRIPT", "FAKE_HARNESS_FAIL_STEP", "FAKE_HARNESS_FAIL_AS", "FAKE_HARNESS_LS"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const fake = (...extra: string[]) => JSON.stringify(["bun", join(fx, "fake-harness.ts"), "{workspace}", ...extra]);
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-resume-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  writeFileSync(layout(root).config, `harness = "fake"\n[adapters.fake]\ncommand = ${fake()}\nresearch_command = ${fake()}\n[adapters.fake2]\ncommand = ${fake("--as", "b")}\n`);
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function script(s: Record<string, Record<string, unknown>[]>) {
  const p = join(root, "script.json");
  writeFileSync(p, JSON.stringify(s));
  rmSync(`${p}.calls`, { force: true });
  process.env.FAKE_HARNESS_SCRIPT = p;
}
const resetCalls = () => rmSync(join(root, "script.json.calls"), { force: true });
const calls = () => {
  const p = join(root, "script.json.calls");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n") : [];
};
const rev = (r: unknown) => ({ "out/review.json": r });
const full = (over: Record<string, Record<string, unknown>[]> = {}) => ({
  parse: [{ "out/parsed-job.json": parsedJob }],
  research: [{ "out/company.json": company }],
  "resume-write": [{ "out/resume.json": resume }],
  "resume-review-1": [rev(pass)],
  "cover-write": [{ "out/cover-letter.json": cover }],
  "cover-review-1": [rev(coverPass)],
  ...over,
});
const job = () => readJobFile(join(fx, "jobs/backend.md"));
const apply = async (o: Partial<Parameters<typeof applyJob>[0]> = {}) => applyJob({ root, input: await job(), open: false, ...o });
const runIds = () => readdirSync(layout(root).runs);
const statePath = (id: string) => join(layout(root).runs, id, "state.json");
const state = (id: string) => JSON.parse(readFileSync(statePath(id), "utf8"));
/** Run apply with FAKE_HARNESS_FAIL_STEP=<step>, then clear it and the call log. */
async function failAt(step: string, o: Partial<Parameters<typeof applyJob>[0]> = {}) {
  process.env.FAKE_HARNESS_FAIL_STEP = step;
  const r = await apply(o);
  delete process.env.FAKE_HARNESS_FAIL_STEP;
  resetCalls();
  return r;
}

describe.skipIf(!hasLatex)("checkpointed runs", () => {
  test("a happy apply leaves a done state with every agent step and the documents", async () => {
    script(full());
    const r = await apply();
    expect(r.runId).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    const s = state(r.runId);
    expect(s.status).toBe("done");
    expect(Object.keys(s.steps).sort()).toEqual(["cover-review-1", "cover-write", "parse", "resume-review-1", "resume-write"]);
    expect(s.steps["cover-write"]).toMatchObject({ harness: "fake", fallback: false, out: join("cover-write", "out", "cover-letter.json") });
    expect(s.documents.resume.version).toBe(1);
    expect(s.documents["cover-letter"].version).toBe(1);
    expect(s.app).toEqual({ dir: r.app.dir, slug: r.app.slug });
    expect(s.research).toEqual({ status: "used" });
    expect(s.error).toBeNull();
  }, 60000);

  test("a failed cover-write resumes with only the cover steps; the resume is not regenerated", async () => {
    script(full());
    const first = await failAt("cover-write");
    expect(first.failures.map((f) => f.kind)).toEqual(["cover-letter"]);
    expect(state(first.runId).status).toBe("failed");
    expect(state(first.runId).error.kind).toBe("rate_limit");

    const r = await resumeRun({ root, open: false });
    expect(calls()).toEqual(["cover-write", "cover-review-1"]);
    expect(r.runId).toBe(first.runId);
    expect(r.failures).toEqual([]);
    expect(r.resume?.version).toBe(1);
    expect(r.resume?.pdfPath).toBe(first.resume!.pdfPath);
    expect(r.cover?.version).toBe(1);
    expect(readdirSync(join(r.app.dir, "resume"))).toEqual(["v1"]);
    expect(r.gaps).toEqual(first.gaps);
    expect(state(r.runId).status).toBe("done");
    expect(state(r.runId).error).toBeNull();
  }, 90000);

  test("an availability failure at resume-review-2 fails the resume; resuming reruns only that review", async () => {
    script(full({ "resume-review-1": [rev(revise)], "resume-revise-1": [{ "out/resume.json": revised }], "resume-review-2": [rev(pass)] }));
    const first = await failAt("resume-review-2");
    expect(first.failures.length).toBe(1);
    expect(first.failures[0]).toMatchObject({ kind: "resume" });
    expect(first.failures[0]!.message).toContain("rate_limit");
    expect(first.cover?.version).toBe(1);
    expect(first.resume).toBeUndefined();

    const r = await resumeRun({ root, open: false });
    expect(calls()).toEqual(["resume-review-2"]);
    expect(r.resume?.version).toBe(1);
    expect(r.cover?.version).toBe(1);
    expect(existsSync(join(r.app.dir, "resume/v1"))).toBe(true);
    expect(JSON.parse(readFileSync(join(r.app.dir, "resume/v1/resume.json"), "utf8"))).toEqual(revised);
    expect(JSON.parse(readFileSync(join(r.app.dir, "resume/v1/meta.json"), "utf8"))).toMatchObject({ rounds: 2, reviewed_final: true });
  }, 90000);

  test("a parse failure throws with a resume hint and no application; resuming creates it", async () => {
    script(full());
    process.env.FAKE_HARNESS_FAIL_STEP = "parse";
    const e = (await apply().catch((x) => x)) as HarnessError;
    delete process.env.FAKE_HARNESS_FAIL_STEP;
    expect(e).toBeInstanceOf(HarnessError);
    expect(e.kind).toBe("rate_limit");
    const [runId] = runIds();
    expect(e.hint).toContain(`resumely resume ${runId}`);
    expect(e.hint).toContain("logs:");
    expect(listApplications(layout(root).applications)).toEqual([]);
    expect(state(runId!)).toMatchObject({ status: "failed", app: null, error: { kind: "rate_limit" } });

    resetCalls();
    const r = await resumeRun({ root, runId, open: false });
    expect(calls()[0]).toBe("parse");
    expect(r.resume?.version).toBe(1);
    expect(r.cover?.version).toBe(1);
    expect(listApplications(layout(root).applications).length).toBe(1);
    expect(state(runId!).status).toBe("done");
  }, 90000);

  test("resume --harness switches the harness without counting as a fallback", async () => {
    script(full());
    const first = await failAt("cover-write");
    const ls = join(root, "ls.jsonl");
    process.env.FAKE_HARNESS_LS = ls;
    const r = await resumeRun({ root, harness: "fake2", open: false });
    const lines = readFileSync(ls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.step === "cover-write").map((l) => l.tag)).toEqual(["b"]);
    expect(state(first.runId).harness).toBe("fake2");
    expect(r.cover?.version).toBe(1);
    expect(r.warnings.some((w) => w.includes("fallback harness"))).toBe(false);
  }, 90000);

  test("an opt-in fallback harness produces both documents and is reported", async () => {
    writeFileSync(layout(root).config, `harness = "fake"\nfallback_harnesses = ["fake2"]\n[adapters.fake]\ncommand = ${fake("--as", "a")}\n[adapters.fake2]\ncommand = ${fake("--as", "b")}\n`);
    script(full({ "cover-write": [{ "out/cover-letter.json": coverNoResearch }] }));
    process.env.FAKE_HARNESS_FAIL_AS = "a";
    const r = await apply({ research: false });
    expect(r.failures).toEqual([]);
    expect(r.resume?.version).toBe(1);
    expect(r.cover?.version).toBe(1);
    expect(r.warnings).toContain("cover-write ran on fallback harness fake2");
    expect(r.warnings.some((w) => w.includes("ran on fallback harness fake2"))).toBe(true);
    expect(state(r.runId).steps.parse).toMatchObject({ harness: "fake2", fallback: true });
  }, 90000);

  test("Review Focus 2: resume reads the profile snapshot, not the live profile", async () => {
    script(full({ "cover-write": [{ "out/cover-letter.json": coverLedgerly }] }));
    await failAt("cover-write");
    rmSync(join(layout(root).profile, "projects/ledgerly.md"));
    const r = await resumeRun({ root, open: false });
    expect(r.failures).toEqual([]);
    expect(r.cover?.version).toBe(1);
    const snap = JSON.parse(readFileSync(join(r.app.dir, "cover-letter/v1/entries.snapshot.json"), "utf8")) as { id: string }[];
    expect(snap.map((e) => e.id)).toContain("proj-ledgerly");
  }, 90000);

  test("Review Focus 1: a stale running run with a corrupt checkpointed output reruns that step", async () => {
    script(full());
    const first = await failAt("cover-review-1");
    expect(first.failures.map((f) => f.kind)).toEqual(["cover-letter"]);
    const dir = join(layout(root).runs, first.runId);
    writeFileSync(join(dir, "cover-write/out/cover-letter.json"), "{not");
    writeFileSync(statePath(first.runId), JSON.stringify({ ...state(first.runId), status: "running", pid: 999999 }));
    const r = await resumeRun({ root, open: false });
    expect(calls()).toEqual(["cover-write", "cover-review-1"]);
    expect(r.cover?.version).toBe(1);
    expect(state(first.runId).status).toBe("done");
  }, 90000);

  test("a deleted application folder is reported", async () => {
    script(full());
    const first = await failAt("cover-write");
    rmSync(first.app.dir, { recursive: true, force: true });
    const e = (await resumeRun({ root, open: false }).catch((x) => x)) as UserError;
    expect(e).toBeInstanceOf(UserError);
    expect(e.message).toBe(`Application folder for run ${first.runId} is gone: ${first.app.dir}`);
    expect(e.hint).toBe("Move it back, or use resumely mv to rename applications");
  }, 60000);
});

test.skipIf(!hasLatex)("SIGINT during apply marks the run failed (interrupted); it stays resumable and resumes", async () => {
  script(full({ parse: [{ $sleep: 30000 }] }));
  const ls = join(root, "ls.jsonl");
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "apply", join(fx, "jobs/backend.md"), "--no-open"], {
    env: { ...process.env, RESUMELY_HOME: root, FAKE_HARNESS_SCRIPT: join(root, "script.json"), FAKE_HARNESS_LS: ls },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(existsSync(ls) && readFileSync(ls, "utf8").includes("\n"))) await Bun.sleep(50);
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(130);
  const [runId] = runIds();
  expect(state(runId!)).toMatchObject({ status: "failed", error: { message: "interrupted" } });
  expect(existsSync(join(layout(root).runs, runId!, "state.json.tmp"))).toBe(false);

  script(full());
  rmSync(join(layout(root).runs, runId!, "parse", ".fake-count"), { force: true });
  const r = await resumeRun({ root, open: false });
  expect(r.runId).toBe(runId!);
  expect(calls()[0]).toBe("parse");
  expect(r.resume?.version).toBe(1);
  expect(state(runId!).status).toBe("done");
}, 90000);

test("a corrupt state.json is unreadable", async () => {
  mkdirSync(join(layout(root).runs, "20260101-000000-abcd"), { recursive: true });
  writeFileSync(statePath("20260101-000000-abcd"), "{");
  const e = (await resumeRun({ root, runId: "20260101-000000-abcd", open: false }).catch((x) => x)) as UserError;
  expect(e).toBeInstanceOf(UserError);
  expect(e.message).toBe("Run 20260101-000000-abcd has an unreadable state.json");
});
