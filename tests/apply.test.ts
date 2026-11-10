import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";
import { applyJob, renderApplication, formatApplicationList } from "../src/pipeline/apply";
import { readJobFile, type JobSource } from "../src/job/intake";
import { findApplication, findDuplicate, listApplications } from "../src/application/store";
import { UserError } from "../src/errors";
import { HarnessError } from "../src/harness/adapter";
import { loadProfile } from "../src/profile/load";
import { DEFAULT_BANNED } from "../src/pipeline/banned";
import { validateCoverLetter } from "../src/pipeline/validate";

const fx = join(import.meta.dir, "fixtures");
const hasLatex = Bun.which("latexmk") !== null;
const hasPdftotext = Bun.which("pdftotext") !== null;
const parsedJob = {
  company: "Atlas Freight",
  role: "Senior Backend Engineer",
  requirements: ["Rust", "Kafka"],
  nice_to_haves: [],
  keywords: ["Go", "PostgreSQL"],
  language: "en",
};
const load = (f: string) => JSON.parse(readFileSync(join(fx, f), "utf8"));
const resume = load("resume-content.json");
const cover = load("cover-letter.json");
const company = load("company.json");
const pass = load("review-pass.json");
const coverPass = { ...pass, scores: { ...pass.scores, voice: 4 }, templated: false };
const badResume = structuredClone(resume);
badResume.sections[0].items[0].bullets[0].entry_ids = ["ghost"];

/** The fixture letter with no company-fact citations (and no fact-only claims), for runs without research. */
const coverNoResearch = structuredClone(cover);
coverNoResearch.paragraphs[0] = {
  text:
    "The Senior Backend Engineer posting at Atlas Freight caught my attention because the role centres on services that keep shipment state consistent while tracking events pour in. That is the kind of backend work I enjoy most: ordering, retries and back pressure stop being abstract when a late message means a late delivery, and the posting reads like a team that takes those problems seriously.",
  entry_ids: [],
  company_fact_ids: [],
};
coverNoResearch.paragraphs[3].company_fact_ids = [];

let root: string;
const saved = { s: process.env.FAKE_HARNESS_SCRIPT, f: process.env.FAKE_HARNESS_FAIL_STEP };
const fakeCmd = `["bun", "${join(fx, "fake-harness.ts")}", "{workspace}"]`;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-apply-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  writeFileSync(layout(root).config, `harness = "fake"\n[adapters.fake]\ncommand = ${fakeCmd}\nresearch_command = ${fakeCmd}\n`);
  delete process.env.FAKE_HARNESS_FAIL_STEP;
});
afterEach(() => {
  for (const [k, v] of [["FAKE_HARNESS_SCRIPT", saved.s], ["FAKE_HARNESS_FAIL_STEP", saved.f]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function script(s: Record<string, Record<string, unknown>[]>) {
  const p = join(root, "script.json");
  writeFileSync(p, JSON.stringify(s));
  rmSync(`${p}.calls`, { force: true });
  process.env.FAKE_HARNESS_SCRIPT = p;
}
const calls = () => {
  const p = join(root, "script.json.calls");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n") : [];
};
const parseOut = { "out/parsed-job.json": parsedJob };
const writeOut = (r: unknown) => ({ "out/resume.json": r });
const coverOut = (c: unknown) => ({ "out/cover-letter.json": c });
const rev = (r: unknown) => ({ "out/review.json": r });
const full = (over: Record<string, Record<string, unknown>[]> = {}) => ({
  parse: [parseOut],
  research: [{ "out/company.json": company }],
  "resume-write": [writeOut(resume)],
  "resume-review-1": [rev(pass)],
  "cover-write": [coverOut(cover)],
  "cover-review-1": [rev(coverPass)],
  ...over,
});
const job = () => readJobFile(join(fx, "jobs/backend.md"));
type Opts = Partial<Parameters<typeof applyJob>[0]>;
const run = async (o: Opts = {}) => applyJob({ root, input: await job(), open: false, ...o });
/** The P1-style run: resume only, no review loop. */
const resumeOnly = (o: Opts = {}) => run({ cover: false, review: false, ...o });
const runDir = () => join(layout(root).runs, readdirSync(layout(root).runs)[0]!);
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe.skipIf(!hasLatex)("applyJob: resume + cover letter", () => {
  test("happy path writes resume/v1 and cover-letter/v1 with every file, both ready", async () => {
    const voice = join(layout(root).profile, "voice");
    mkdirSync(voice, { recursive: true });
    writeFileSync(join(voice, "sample.md"), "I write short sentences. I like plain words.\n");
    script(full());
    const progress: string[] = [];
    const r = await run({ onProgress: (m) => progress.push(m) });
    expect(r.failures).toEqual([]);
    expect([...calls()].sort()).toEqual(["cover-review-1", "cover-write", "parse", "research", "resume-review-1", "resume-write"]);
    expect(calls().slice(0, 2)).toEqual(["parse", "research"]);

    const rv = join(r.app.dir, "resume/v1");
    for (const f of ["resume.json", "resume.tex", "Jordan_Example_Resume_AtlasFreight.pdf", "trace.json", "entries.snapshot.json", "review.json", "checks.json", "meta.json"]) {
      expect(existsSync(join(rv, f))).toBe(true);
    }
    const cv = join(r.app.dir, "cover-letter/v1");
    for (const f of ["cover-letter.json", "cover-letter.tex", "Jordan_Example_Cover_Letter_AtlasFreight.pdf", "trace.json", "entries.snapshot.json", "company.snapshot.json", "review.json", "checks.json", "meta.json"]) {
      expect(existsSync(join(cv, f))).toBe(true);
    }
    expect(r.resume).toMatchObject({ version: 1, pdfPath: join(rv, "Jordan_Example_Resume_AtlasFreight.pdf"), ready: true, review: pass });
    expect(r.cover).toMatchObject({ version: 1, pdfPath: join(cv, "Jordan_Example_Cover_Letter_AtlasFreight.pdf"), ready: true, pages: 1, review: coverPass });

    for (const dir of [rv, cv]) {
      const meta = readJson(join(dir, "meta.json"));
      expect(meta).toMatchObject({ mode: "truthful", ready: true, reviewed_final: true, rounds: 1, research: "used", harness: "fake", template: "classic", target_pages: 1, review_verdict: "pass" });
      expect(existsSync(meta.run)).toBe(true);
      expect(typeof meta.created).toBe("string");
      const checks = readJson(join(dir, "checks.json"));
      expect(checks.ats.status).toBe(hasPdftotext ? "ok" : "skipped");
      expect(checks.overflow).toBe(false);
      expect(Array.isArray(checks.warnings)).toBe(true);
    }
    expect(readJson(join(rv, "meta.json")).pages).toBe(r.resume!.pages);
    // A letter's length is governed by its word bounds, not page fill.
    expect(readJson(join(cv, "checks.json")).underflow).toBe(false);

    const ctrace = readJson(join(cv, "trace.json"));
    expect(ctrace.length).toBe(cover.paragraphs.length);
    expect(ctrace[0]).toMatchObject({ paragraph: 0, entry_ids: [], company_fact_ids: ["co-1", "co-2"] });
    expect(readJson(join(cv, "company.snapshot.json")).map((f: { id: string }) => f.id)).toEqual(["co-1", "co-2"]);
    expect(readJson(join(cv, "entries.snapshot.json")).map((e: { id: string }) => e.id).sort()).toEqual(["exp-atlas-labs", "exp-northwind"]);

    // The cover writer sees profile, job, research, voice and banned phrases, never the resume.
    const cw = join(runDir(), "cover-write");
    for (const f of ["profile.json", "job.md", "parsed-job.json", "company.json", "voice/sample.md", "banned.json", "cover-letter.schema.json"]) {
      expect(existsSync(join(cw, f))).toBe(true);
    }
    expect(readdirSync(cw).some((f) => f.startsWith("resume"))).toBe(false);
    expect(readJson(join(cw, "banned.json"))).toEqual(DEFAULT_BANNED);
    expect(existsSync(join(r.app.dir, "job/company.json"))).toBe(true);

    expect(progress.some((m) => m.startsWith("[resume] "))).toBe(true);
    expect(progress.some((m) => m.startsWith("[cover] "))).toBe(true);
    expect(r.gaps).toEqual(resume.gaps);
    expect(r.inferred).toEqual([]);
  }, 60000);

  test("cover: false writes no cover letter and skips research", async () => {
    script(full());
    const r = await run({ cover: false });
    expect(existsSync(join(r.app.dir, "cover-letter"))).toBe(false);
    expect(r.cover).toBeUndefined();
    expect(r.resume?.version).toBe(1);
    expect(calls().some((c) => c.startsWith("cover-") || c === "research")).toBe(false);
  }, 60000);

  test("research: false makes no research call; cover letter cites no company facts", async () => {
    expect(validateCoverLetter(coverNoResearch, { profile: loadProfile(join(fx, "profile-jordan")), research: null, banned: DEFAULT_BANNED, mode: "truthful", jobText: "", job: parsedJob }).ok).toBe(true);
    script(full({ "cover-write": [coverOut(coverNoResearch)] }));
    const r = await run({ research: false });
    expect(calls()).not.toContain("research");
    expect(r.failures).toEqual([]);
    const cv = join(r.app.dir, "cover-letter/v1");
    expect(readJson(join(cv, "company.snapshot.json"))).toEqual([]);
    expect(readJson(join(cv, "meta.json")).research).toBe("skipped");
    expect(existsSync(join(runDir(), "cover-write/company.json"))).toBe(false);
  }, 60000);

  test("research skipped for a harness without web tools: warning, cover still produced", async () => {
    writeFileSync(layout(root).config, `harness = "fake"\n[adapters.fake]\ncommand = ${fakeCmd}\n`);
    script(full({ "cover-write": [coverOut(coverNoResearch)] }));
    const r = await run();
    expect(calls()).not.toContain("research");
    expect(r.warnings.some((w) => w.startsWith("research skipped:"))).toBe(true);
    expect(r.cover?.version).toBe(1);
    expect(readJson(join(r.app.dir, "cover-letter/v1/meta.json")).research).toBe("skipped");
  }, 60000);

  test("Review Focus 1: cover-write fails; resume still saved, failure names the logs", async () => {
    script(full());
    process.env.FAKE_HARNESS_FAIL_STEP = "cover-write";
    const r = await run();
    expect(r.resume?.version).toBe(1);
    expect(existsSync(join(r.app.dir, "resume/v1/meta.json"))).toBe(true);
    expect(existsSync(join(r.app.dir, "cover-letter"))).toBe(false);
    expect(r.cover).toBeUndefined();
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]!.kind).toBe("cover-letter");
    expect(r.failures[0]!.hint).toContain("logs:");
    expect(r.failures[0]!.hint).toContain(join(runDir(), "cover-write"));
  }, 60000);

  test("invalid cover output on every attempt: failure hint points at the workspace", async () => {
    script(full({ "cover-write": [{ "out/cover-letter.json": "INVALID" }] }));
    const r = await run();
    expect(r.resume?.version).toBe(1);
    expect(r.failures).toEqual([{ kind: "cover-letter", message: "Agent output invalid after 3 attempts", hint: `Inspect ${join(runDir(), "cover-write")}` }]);
  }, 60000);

  test("template without cover-letter support: cover failure, resume saved, no cover calls", async () => {
    const tpl = join(layout(root).templates, "plain");
    cpSync(join(import.meta.dir, "../templates/classic"), tpl, { recursive: true });
    writeFileSync(join(tpl, "template.toml"), 'id = "plain"\nengine = "pdflatex"\nsupports = ["resume"]\n');
    script(full());
    const r = await run({ template: "plain" });
    expect(r.resume?.version).toBe(1);
    expect(r.failures).toEqual([{ kind: "cover-letter", message: "template plain has no cover-letter design" }]);
    expect(calls().some((c) => c.startsWith("cover-"))).toBe(false);
  }, 60000);

  test("duplicate: no onDuplicate aborts; 'existing' adds resume v2 and reuses research", async () => {
    script(full());
    const first = await run();
    const e = (await run().catch((x) => x)) as UserError;
    expect(e).toBeInstanceOf(UserError);
    expect(e.message).toBe(`Already applied: ${first.app.slug}`);
    expect(e.hint).toBe(`Use --into ${first.app.slug} to add a version, or --new for a separate application`);
    expect(listApplications(layout(root).applications).length).toBe(1);

    script(full());
    let seen: string | undefined;
    const r = await run({ onDuplicate: async (a) => ((seen = a.slug), "existing") });
    expect(seen).toBe(first.app.slug);
    expect(r.app.slug).toBe(first.app.slug);
    expect(r.resume?.version).toBe(2);
    expect(r.cover?.version).toBe(2);
    expect(calls()).not.toContain("research");
    expect(existsSync(join(r.app.dir, "job/raw-2.md"))).toBe(true);
    expect(readJson(join(r.app.dir, "resume/v2/meta.json")).research).toBe("used");
    expect(listApplications(layout(root).applications).length).toBe(1);

    script(full());
    const n = await run({ onDuplicate: async () => "new" });
    expect(n.app.slug).not.toBe(first.app.slug);
    expect(listApplications(layout(root).applications).length).toBe(2);

    script(full());
    await expect(run({ onDuplicate: async () => "abort" })).rejects.toThrow("Aborted");
    expect(listApplications(layout(root).applications).length).toBe(2);
  }, 120000);

  test("duplicate URL is caught before the parse; 'existing' reuses the app's parsed job", async () => {
    const input = { ...(await job()), kind: "url" as const, url: "https://jobs.test/42" };
    script(full());
    const first = await run({ input, cover: false, review: false });
    script(full());
    const e = (await run({ input, cover: false, review: false }).catch((x) => x)) as UserError;
    expect(e.message).toBe(`Already applied: ${first.app.slug}`);
    expect(calls()).toEqual([]);
    script(full());
    const r = await run({ input, cover: false, review: false, onDuplicate: async () => "existing" });
    expect(r.app.slug).toBe(first.app.slug);
    expect(calls()).toEqual(["resume-write"]);
    expect(r.resume?.version).toBe(2);
  }, 60000);

  test("stretch: inferred bullet is listed and meta.mode is stretch", async () => {
    const stretched = structuredClone(resume);
    const bullet = { text: "Owned PostgreSQL schema changes behind the billing dashboard rebuild.", entry_ids: ["exp-atlas-labs"], basis: "inferred" };
    stretched.sections[0].items[0].bullets.push(bullet);
    script(full({ "resume-write": [writeOut(stretched)] }));
    const r = await run({ mode: "stretch", cover: false });
    expect(r.inferred).toEqual([{ text: bullet.text, entry_ids: bullet.entry_ids }]);
    expect(readJson(join(r.app.dir, "resume/v1/meta.json")).mode).toBe("stretch");
    expect(readFileSync(join(runDir(), "resume-write/instructions.md"), "utf8")).toContain('Mark every inferred bullet `basis: "inferred"`.');
  }, 60000);

  test("render --cover re-renders the cover letter without agent calls", async () => {
    script(full());
    const { app } = await run();
    rmSync(join(root, "script.json.calls"), { force: true });
    const r = await renderApplication({ root, query: "atlas", template: "classic", kind: "cover-letter", open: false });
    expect(r.version).toBe(2);
    expect(calls()).toEqual([]);
    const v2 = join(app.dir, "cover-letter/v2");
    expect(readFileSync(join(v2, "cover-letter.json"), "utf8")).toBe(readFileSync(join(app.dir, "cover-letter/v1/cover-letter.json"), "utf8"));
    expect(readFileSync(join(v2, "review.json"), "utf8")).toBe(readFileSync(join(app.dir, "cover-letter/v1/review.json"), "utf8"));
    for (const f of ["company.snapshot.json", "entries.snapshot.json", "trace.json", "checks.json", "Jordan_Example_Cover_Letter_AtlasFreight.pdf"]) expect(existsSync(join(v2, f))).toBe(true);
    const meta = readJson(join(v2, "meta.json"));
    expect(meta).toMatchObject({ rendered_from: 1, ready: true, template: "classic", mode: "truthful" });
    expect(existsSync(join(app.dir, "resume/v2"))).toBe(false);
  }, 60000);
});

test.skipIf(!hasLatex)("pause resolving false aborts before any writer call and keeps the app", async () => {
  script(full());
  let gaps: string[] | undefined;
  const e = (await run({ pause: async (_j, g) => ((gaps = g), false) }).catch((x) => x)) as UserError;
  expect(e).toBeInstanceOf(UserError);
  expect(e.message).toBe("Aborted");
  expect(gaps).toEqual(["Rust", "Kafka"]);
  expect(calls()).toEqual(["parse"]);
  expect(listApplications(layout(root).applications).length).toBe(1);
});

describe("findDuplicate", () => {
  const src = (url?: string): JobSource => ({ kind: url ? "url" : "file", text: "raw", ...(url ? { url } : {}) });
  test("matches on URL or case-insensitive company+role, most recent first", async () => {
    const { createApplication } = await import("../src/application/store");
    const apps = layout(root).applications;
    const a = createApplication(apps, parsedJob, src("https://jobs.test/1"), new Date(2026, 0, 1));
    const b = createApplication(apps, parsedJob, src(), new Date(2026, 5, 1));
    expect(findDuplicate(apps, { url: "https://jobs.test/1", company: "", role: "" })?.slug).toBe(a.slug);
    expect(findDuplicate(apps, { company: "atlas freight", role: "SENIOR BACKEND ENGINEER" })?.slug).toBe(b.slug);
    expect(findDuplicate(apps, { url: "https://jobs.test/2", company: "Other", role: "Role" })).toBeNull();
    expect(findDuplicate(apps, { company: "", role: "" })).toBeNull();
  });
});

describe.skipIf(!hasLatex)("applyJob (resume, P1 behaviours)", () => {
  test("happy path", async () => {
    script(full());
    const { app, resume: doc } = await resumeOnly();
    expect(app.slug).toMatch(/-atlas-freight-/);
    const v1 = join(app.dir, "resume/v1");
    for (const f of ["resume.json", "resume.tex", "Jordan_Example_Resume_AtlasFreight.pdf", "trace.json", "entries.snapshot.json", "checks.json", "meta.json"]) {
      expect(existsSync(join(v1, f))).toBe(true);
    }
    expect(existsSync(join(v1, "review.json"))).toBe(false);
    const meta = readJson(join(v1, "meta.json"));
    expect(meta.mode).toBe("truthful");
    expect(meta.template).toBe("classic");
    expect(meta.pages).toBe(doc!.pages);
    expect(meta.target_pages).toBe(1);
    expect(meta).toMatchObject({ rounds: 0, reviewed_final: false, review_verdict: null });
    expect(existsSync(meta.run)).toBe(true);
    const snap = readJson(join(v1, "entries.snapshot.json")) as { id: string }[];
    const ids = new Set<string>();
    const walk = (c: any) => {
      c.summary?.entry_ids.forEach((i: string) => ids.add(i));
      for (const s of c.sections) for (const it of s.items) { ids.add(it.entry_id); it.bullets.forEach((b: any) => b.entry_ids.forEach((i: string) => ids.add(i))); }
    };
    walk(resume);
    expect(snap.map((e) => e.id).sort()).toEqual([...ids].sort());
    const trace = readJson(join(v1, "trace.json"));
    expect(trace[0]).toMatchObject({ section: "summary", item: "", bullet: 0 });
    expect(trace[1]).toMatchObject({ section: "Experience", item: "Senior Software Engineer", bullet: 0, basis: "direct" });
    expect(calls()).toEqual(["parse", "resume-write"]);
  });

  test("--pages sets the target and the prompt", async () => {
    script(full());
    const { app } = await resumeOnly({ pages: 2 });
    expect(readJson(join(app.dir, "resume/v1/meta.json")).target_pages).toBe(2);
    expect(readFileSync(join(runDir(), "resume-write/instructions.md"), "utf8")).toContain("Target 2 page(s)");
  });

  test("retry after invalid JSON keeps errors.md and per-attempt logs", async () => {
    script(full({ "resume-write": [{ "out/resume.json": "INVALID" }, writeOut(resume)] }));
    const { app } = await resumeOnly();
    expect(existsSync(join(app.dir, "resume/v1/resume.json"))).toBe(true);
    expect(existsSync(join(runDir(), "resume-write/errors.md"))).toBe(true);
    for (const f of ["stdout.log", "stderr.log", "stdout.2.log", "stderr.2.log"]) expect(existsSync(join(runDir(), "resume-write", f))).toBe(true);
    expect(existsSync(join(runDir(), "parse/stdout.2.log"))).toBe(false);
  });

  test("harness failure in the write step names the write workspace", async () => {
    script(full({ "resume-write": [{ $stderr: "model overloaded, giving up", $exit: 1 }] }));
    const e = (await resumeOnly().catch((x) => x)) as HarnessError;
    expect(e).toBeInstanceOf(HarnessError);
    expect(e.kind).toBe("unknown");
    const ws = join(runDir(), "resume-write");
    expect(e.hint).toBe(`model overloaded, giving up (logs: ${ws})`);
    expect(readFileSync(join(ws, "stderr.log"), "utf8")).toContain("model overloaded");
  });

  test("both documents failing rethrows the resume's error", async () => {
    script(full({ "resume-write": [{ $stderr: "model overloaded, giving up", $exit: 1 }], "cover-write": [{ $exit: 1 }] }));
    const e = (await run().catch((x) => x)) as HarnessError;
    expect(e).toBeInstanceOf(HarnessError);
    expect(e.hint).toBe(`model overloaded, giving up (logs: ${join(runDir(), "resume-write")})`);
  });

  test("render into a new version with another template", async () => {
    script(full());
    const { app } = await resumeOnly();
    const r = await renderApplication({ root, query: "atlas", template: "classic", open: false });
    expect(r.version).toBe(2);
    const a = readFileSync(join(app.dir, "resume/v1/resume.json"), "utf8");
    expect(readFileSync(join(app.dir, "resume/v2/resume.json"), "utf8")).toBe(a);
    const meta = readJson(join(app.dir, "resume/v2/meta.json"));
    expect(meta.rendered_from).toBe(1);
    expect(typeof meta.ready).toBe("boolean");
    expect(existsSync(join(app.dir, "resume/v2/trace.json"))).toBe(true);
    expect(existsSync(join(app.dir, "resume/v2/entries.snapshot.json"))).toBe(true);
    expect(existsSync(join(app.dir, "resume/v2/checks.json"))).toBe(true);
    expect(findApplication(layout(root).applications, "atlas").slug).toBe(app.slug);
    const out = formatApplicationList(listApplications(layout(root).applications));
    expect(out).toContain("Atlas Freight");
    expect(out).toContain("v2");
  });

  test("render resolves from the frozen snapshot and recomputes trace from edited content", async () => {
    script(full());
    const { app } = await resumeOnly();
    const live = join(layout(root).profile, "experience/atlas-labs.md");
    writeFileSync(live, readFileSync(live, "utf8").replace("title: Senior Software Engineer", "title: Chief Everything Officer"));
    const edited = structuredClone(resume);
    edited.sections[0].items[0].bullets[0].text = "Rebuilt the billing dashboard with a team of 4.";
    writeFileSync(join(app.dir, "resume/v1/resume.json"), JSON.stringify(edited));
    await renderApplication({ root, query: "atlas", template: "classic", open: false });
    const tex = readFileSync(join(app.dir, "resume/v2/resume.tex"), "utf8");
    expect(tex).toContain("{Senior Software Engineer}{Mar 2023 – Present}");
    expect(tex).not.toContain("Chief Everything Officer");
    const trace = readJson(join(app.dir, "resume/v2/trace.json"));
    expect(trace[1]).toMatchObject({ item: "Senior Software Engineer", text: "Rebuilt the billing dashboard with a team of 4." });
    expect(readFileSync(join(app.dir, "resume/v2/entries.snapshot.json"), "utf8")).toBe(readFileSync(join(app.dir, "resume/v1/entries.snapshot.json"), "utf8"));
  });

  test("corrupt or hand-broken resume.json gives a UserError on render", async () => {
    script(full());
    const { app } = await resumeOnly();
    const p = join(app.dir, "resume/v1/resume.json");
    writeFileSync(p, "{ nope");
    let e = (await renderApplication({ root, query: "atlas", template: "classic", open: false }).catch((x) => x)) as UserError;
    expect(e).toBeInstanceOf(UserError);
    expect(e.message).toBe(`Invalid resume.json at ${p}`);
    const broken = structuredClone(resume);
    delete broken.sections[0].items[0].bullets[0].entry_ids;
    broken.skills = "lots";
    writeFileSync(p, JSON.stringify(broken));
    e = (await renderApplication({ root, query: "atlas", template: "classic", open: false }).catch((x) => x)) as UserError;
    expect(e.message).toBe(`Invalid resume.json at ${p}`);
    expect(e.hint).toMatch(/^sections\[0\]\.items\[0\]\.bullets\[0\]\.entry_ids: .+; skills: .+$/);
  });

  test("PDF metadata and non-English warning", async () => {
    script(full({ parse: [{ "out/parsed-job.json": { ...parsedJob, language: "fr" } }] }));
    const { app, warnings, resume: doc } = await resumeOnly();
    expect(warnings).toContain('job description language is "fr"; v1 is English-only');
    const tex = readFileSync(join(app.dir, "resume/v1/resume.tex"), "utf8");
    expect(tex).toContain("\\hypersetup{pdfauthor={Jordan Example}, pdftitle={Jordan Example — Resume}, pdfsubject={Senior Backend Engineer at Atlas Freight}}");
    expect(existsSync(doc!.pdfPath)).toBe(true);
  });

  test("English job has no language warning", async () => {
    script(full());
    const { warnings } = await resumeOnly();
    expect(warnings.some((w) => w.includes("English-only"))).toBe(false);
  });

  test("compile failure after a valid agent run names the saved content", async () => {
    const tpl = join(layout(root).templates, "broken");
    mkdirSync(tpl, { recursive: true });
    writeFileSync(join(tpl, "template.toml"), 'id = "broken"\nengine = "pdflatex"\n');
    writeFileSync(join(tpl, "resume.tex.njk"), "\\documentclass{article}\\begin{document}\\undefinedmacro\\end{document}\n");
    script(full());
    const e = (await run({ template: "broken" }).catch((x) => x)) as UserError;
    expect(e).toBeInstanceOf(UserError);
    expect(e.message).toBe("LaTeX compile failed");
    expect(e.hint).toMatch(/^! Undefined control sequence\. — content saved at .*\/\.runs\/[^/]+\/resume-write\/out\/resume\.json$/);
    expect(existsSync(e.hint!.split("content saved at ")[1]!)).toBe(true);
  });
});

test("empty or starter profile fails before any agent call", async () => {
  script(full());
  const fresh = mkdtempSync(join(tmpdir(), "resumely-apply-empty-"));
  try {
    initDataRoot(fresh);
    writeFileSync(layout(fresh).config, readFileSync(layout(root).config, "utf8"));
    const e = (await applyJob({ root: fresh, input: await job(), open: false }).catch((x) => x)) as UserError;
    expect(e).toBeInstanceOf(UserError);
    expect(e.message).toBe("Your profile is empty");
    expect(e.hint).toBe(`Add entries under ${layout(fresh).profile} (see README) — check with: resumely profile show`);
    // entries present but the starter name left in place
    cpSync(join(fx, "profile-jordan/experience"), join(layout(fresh).profile, "experience"), { recursive: true });
    await expect(applyJob({ root: fresh, input: await job(), open: false })).rejects.toThrow("Your profile is empty");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
  expect(existsSync(join(root, "script.json.calls"))).toBe(false);
});

test("missing latexmk fails before any agent call", async () => {
  script(full());
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  let e: UserError | undefined;
  try {
    e = await run().catch((x) => x);
  } finally {
    process.env.PATH = savedPath;
  }
  expect(e).toBeInstanceOf(UserError);
  expect(e!.message).toBe("latexmk not found");
  expect(e!.hint).toBe("Install TeX Live (macOS: brew install --cask mactex-no-gui)");
  expect(existsSync(join(root, "script.json.calls"))).toBe(false);
});

test.skipIf(!hasLatex)("unknown entry id on all write attempts: app exists, no version", async () => {
  script(full({ "resume-write": [writeOut(badResume)] }));
  let err: unknown;
  await resumeOnly().catch((e) => (err = e));
  expect(err).toBeInstanceOf(UserError);
  expect((err as UserError).message).toContain("after 3 attempts");
  const apps = listApplications(layout(root).applications);
  expect(apps.length).toBe(1);
  expect(existsSync(join(apps[0]!.dir, "resume"))).toBe(false);
});

test.skipIf(!hasLatex)("invalid parse on all attempts: no application dir", async () => {
  script({ parse: [{ "out/parsed-job.json": "INVALID" }] });
  await expect(run()).rejects.toThrow("after 3 attempts");
  expect(listApplications(layout(root).applications)).toEqual([]);
  expect(existsSync(layout(root).applications) ? readdirSync(layout(root).applications) : []).toEqual([]);
});

test("ls with no applications", () => {
  expect(formatApplicationList([])).toBe("No applications yet. Try: resumely apply --clip");
});
