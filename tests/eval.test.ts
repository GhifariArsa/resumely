import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { isThin, readJobFile } from "../src/job/intake";
import { layout } from "../src/paths";
import { applyJob } from "../src/pipeline/apply";
import { formatSummary, parseEvalArgs, runDirOf, summarizeRun, type EvalRow } from "../scripts/eval-lib";

const fx = join(import.meta.dir, "fixtures");
const hasLatex = Bun.which("latexmk") !== null;
const load = (f: string) => JSON.parse(readFileSync(join(fx, f), "utf8"));
const parsedJob = { company: "Atlas Freight", role: "Senior Backend Engineer", requirements: ["Rust", "Kafka"], nice_to_haves: [], keywords: ["Go", "PostgreSQL"], language: "en" };
const resume = load("resume-content.json");
const cover = load("cover-letter.json");
const pass = load("review-pass.json");
const coverPass = { ...pass, scores: { ...pass.scores, voice: 4 }, templated: false };
const mean = (o: Record<string, number>) => Math.round((Object.values(o).reduce((a, b) => a + b, 0) / Object.keys(o).length) * 10) / 10;

let root: string;
const saved = process.env.FAKE_HARNESS_SCRIPT;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-eval-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  const cmd = `["bun", "${join(fx, "fake-harness.ts")}", "{workspace}"]`;
  writeFileSync(layout(root).config, `harness = "fake"\n[adapters.fake]\ncommand = ${cmd}\nresearch_command = ${cmd}\n`);
});
afterEach(() => {
  if (saved === undefined) delete process.env.FAKE_HARNESS_SCRIPT;
  else process.env.FAKE_HARNESS_SCRIPT = saved;
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasLatex)("summarizeRun over a real applyJob", () => {
  const happy = async () => {
    const p = join(root, "script.json");
    writeFileSync(p, JSON.stringify({
      parse: [{ "out/parsed-job.json": parsedJob }],
      research: [{ "out/company.json": load("company.json") }],
      "resume-write": [{ "out/resume.json": resume }],
      "resume-review-1": [{ "out/review.json": pass }],
      "cover-write": [{ "out/cover-letter.json": cover }],
      "cover-review-1": [{ "out/review.json": coverPass }],
    }));
    process.env.FAKE_HARNESS_SCRIPT = p;
    return applyJob({ root, input: await readJobFile(join(fx, "jobs/backend.md")), open: false });
  };
  const runDir = (id: string) => join(layout(root).runs, id);

  test("a happy run summarises as ok with scores, rounds and no fabrication", async () => {
    const result = await happy();
    const row = summarizeRun({ harness: "fake", job: "backend", wallMs: 1000, result, runDir: runDir(result.runId) });
    expect(row.ok).toBe(true);
    expect(row.resume?.ready).toBe(true);
    expect(["ok", "skipped"]).toContain(row.resume!.ats);
    expect(row.resume?.score).toBe(mean(pass.scores));
    expect(row.resume?.verdict).toBe("pass");
    expect(row.resume?.rounds).toBe(1);
    expect(row.cover?.score).toBe(mean(coverPass.scores));
    expect(row.gaps).toBe(resume.gaps.length);
    expect(row.fabrication_flags).toBe(0);
    expect(row.expect_ok).toBeNull();
  }, 90000);

  test("expect.min_gaps beyond the gaps found makes expect_ok false", async () => {
    const result = await happy();
    const row = summarizeRun({ harness: "fake", job: "backend", wallMs: 1, result, runDir: runDir(result.runId), expect: { min_gaps: 99 } });
    expect(row.expect_ok).toBe(false);
    const ok = summarizeRun({ harness: "fake", job: "backend", wallMs: 1, result, runDir: runDir(result.runId), expect: { min_gaps: 0 } });
    expect(ok.expect_ok).toBe(true);
  }, 90000);

  test("counts fabrication warnings and 'is not supported by' lines in errors.md", async () => {
    const result = await happy();
    const dir = runDir(result.runId);
    const step = join(dir, readdirSync(dir).find((n) => existsSync(join(dir, n, "out")))!);
    writeFileSync(join(step, "errors.md"), "- claim X is not supported by the profile\n- other\n- Y is not supported by anything\n");
    const row = summarizeRun({ harness: "fake", job: "backend", wallMs: 1, result, runDir: dir });
    expect(row.fabrication_flags).toBe(2);
  }, 90000);
});

describe("summarizeRun without a result", () => {
  test("an error becomes ok:false with its message", () => {
    const row = summarizeRun({ harness: "h", job: "j", wallMs: 5, error: new Error("boom") });
    expect(row).toMatchObject({ ok: false, error: "boom", gaps: 0, fabrication_flags: 0, expect_ok: null });
    expect(row.resume).toBeUndefined();
  });
});

describe("runDirOf", () => {
  test("the result's run, else the only run on disk, else undefined (also when the runs dir is missing)", () => {
    const runs = join(mkdtempSync(join(tmpdir(), "resumely-evalruns-")), ".runs");
    expect(runDirOf(runs)).toBeUndefined();
    expect(runDirOf(runs, "r9")).toBe(join(runs, "r9"));
    mkdirSync(join(runs, "r1"), { recursive: true });
    expect(runDirOf(runs)).toBe(join(runs, "r1"));
  });
});

describe("formatSummary", () => {
  const doc = { ready: true, ats: "ok" as const, score: 4.3, verdict: "pass" as const, rounds: 1 };
  const rows: EvalRow[] = [
    { harness: "claude", job: "backend", ok: true, resume: doc, cover: doc, gaps: 2, fabrication_flags: 0, wall_ms: 65_000, expect_ok: null },
    { harness: "codex", job: "mismatched", ok: false, error: "boom", gaps: 0, fabrication_flags: 1, wall_ms: 5000, expect_ok: false },
  ];
  test("renders a header, a separator and one line per row", () => {
    const lines = formatSummary(rows).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("| harness | job | ok | resume ready/ats/score/rounds | cover ready/ats/score/rounds | gaps | fab | time | expect |");
    expect(lines[2]).toContain("✓/ok/4.3/1");
    expect(lines[2]).toContain("1:05");
    expect(lines[3]).toContain("| - | - |");
  });
});

describe("parseEvalArgs", () => {
  test("parses harnesses, jobs, stretch and a default out dir", () => {
    const a = parseEvalArgs(["--harness", "claude,codex", "--jobs", "backend", "--stretch"]);
    expect(a.harnesses).toEqual(["claude", "codex"]);
    expect(a.jobs).toEqual(["backend"]);
    expect(a.stretch).toBe(true);
    expect(a.out.startsWith("eval-results/")).toBe(true);
    expect(a.out).toMatch(/^eval-results\/\d{8}-\d{6}$/);
  });
  test("defaults and --out", () => {
    const a = parseEvalArgs(["--out", "x"]);
    expect(a).toMatchObject({ out: "x", stretch: false });
    expect(a.harnesses).toBeUndefined();
  });
});

describe("fixtures and wiring", () => {
  const jobs = join(fx, "jobs");
  test("every fixture JD has at least 150 words and is not thin", () => {
    const files = readdirSync(jobs).filter((f) => f.endsWith(".md"));
    expect(files.sort()).toEqual(["backend.md", "data.md", "frontend.md", "mismatched.md", "pm.md"]);
    for (const f of files) {
      const text = readFileSync(join(jobs, f), "utf8");
      expect(text.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(150);
      expect(isThin(text)).toBe(false);
    }
    expect(JSON.parse(readFileSync(join(jobs, "mismatched.expect.json"), "utf8"))).toEqual({ min_gaps: 3 });
  });
  test("package.json has the eval script, and no test imports scripts/eval.ts", () => {
    expect(JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).scripts.eval).toBe("bun scripts/eval.ts");
    for (const f of readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(join(import.meta.dir, f), "utf8")).not.toMatch(/(from|import\()\s*["'][^"']*scripts\/eval(\.ts)?["']/);
    }
  });
});
