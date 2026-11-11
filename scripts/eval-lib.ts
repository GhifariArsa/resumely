import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApplyResult } from "../src/pipeline/apply";

export type DocEval = { ready: boolean; ats: "ok" | "failed" | "skipped"; score: number | null; verdict: "pass" | "revise" | null; rounds: number };

export type EvalRow = {
  harness: string;
  job: string;
  ok: boolean;
  error?: string;
  resume?: DocEval;
  cover?: DocEval;
  gaps: number;
  fabrication_flags: number;
  wall_ms: number;
  expect_ok: boolean | null;
};

const readJson = (path: string): Record<string, any> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Read one saved version dir (`meta.json`, `checks.json`, `review.json`). */
function docEval(versionDir: string): { doc: DocEval; fabrication: number } {
  const meta = readJson(join(versionDir, "meta.json")) ?? {};
  const checks = readJson(join(versionDir, "checks.json")) ?? {};
  const review = readJson(join(versionDir, "review.json"));
  const nums = review?.scores ? Object.values(review.scores).filter((v): v is number => typeof v === "number") : [];
  const status = checks.ats?.status;
  return {
    doc: {
      ready: meta.ready === true,
      ats: status === "ok" || status === "failed" ? status : "skipped",
      score: nums.length ? round1(nums.reduce((a, b) => a + b, 0) / nums.length) : null,
      verdict: review?.verdict === "pass" || review?.verdict === "revise" ? review.verdict : null,
      rounds: typeof meta.rounds === "number" ? meta.rounds : 0,
    },
    fabrication: Array.isArray(checks.fabrication_warnings) ? checks.fabrication_warnings.length : 0,
  };
}

/** Lines in the run's per-step `errors.md` files that report an unsupported claim. */
function unsupportedLines(runDir: string): number {
  if (!existsSync(runDir)) return 0;
  let n = 0;
  for (const step of readdirSync(runDir)) {
    try {
      n += readFileSync(join(runDir, step, "errors.md"), "utf8").split("\n").filter((l) => /is not supported by/.test(l)).length;
    } catch {
      // no errors.md for this step
    }
  }
  return n;
}

export function summarizeRun(o: {
  harness: string;
  job: string;
  wallMs: number;
  result?: ApplyResult;
  error?: unknown;
  runDir?: string;
  expect?: { min_gaps?: number; max_gaps?: number };
}): EvalRow {
  const { result } = o;
  let fabrication = o.runDir ? unsupportedLines(o.runDir) : 0;
  const row: EvalRow = { harness: o.harness, job: o.job, ok: !!result && !o.error, gaps: result?.gaps.length ?? 0, fabrication_flags: 0, wall_ms: o.wallMs, expect_ok: null };
  if (o.error !== undefined) row.error = o.error instanceof Error ? o.error.message : String(o.error);
  for (const kind of ["resume", "cover"] as const) {
    const d = result?.[kind];
    if (!d) continue;
    const e = docEval(dirname(d.pdfPath));
    row[kind] = e.doc;
    fabrication += e.fabrication;
  }
  row.fabrication_flags = fabrication;
  if (o.expect) {
    const { min_gaps, max_gaps } = o.expect;
    row.expect_ok = row.ok && (min_gaps === undefined || row.gaps >= min_gaps) && (max_gaps === undefined || row.gaps <= max_gaps);
  }
  return row;
}

const cell = (d?: DocEval) => (d ? `${d.ready ? "✓" : "✗"}/${d.ats}/${d.score ?? "-"}/${d.rounds}` : "-");
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function formatSummary(rows: EvalRow[]): string {
  const head = "| harness | job | ok | resume ready/ats/score/rounds | cover ready/ats/score/rounds | gaps | fab | time | expect |";
  const sep = "|---|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) =>
    `| ${r.harness} | ${r.job} | ${r.ok ? "✓" : "✗"} | ${cell(r.resume)} | ${cell(r.cover)} | ${r.gaps} | ${r.fabrication_flags} | ${clock(r.wall_ms)} | ${r.expect_ok === null ? "-" : r.expect_ok ? "✓" : "✗"} |`,
  );
  return [head, sep, ...body].join("\n") + "\n";
}

export function parseEvalArgs(argv: string[]): { harnesses?: string[]; jobs?: string[]; out: string; stretch: boolean } {
  const list = (v: string | undefined) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const p = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const harnesses = list(value("--harness"));
  const jobs = list(value("--jobs"));
  return { ...(harnesses ? { harnesses } : {}), ...(jobs ? { jobs } : {}), out: value("--out") ?? `eval-results/${stamp}`, stretch: argv.includes("--stretch") };
}

/** The run directory to summarise: the result's run, else the first run on disk (none when `runsDir` doesn't exist, e.g. apply failed before creating it). */
export function runDirOf(runsDir: string, runId?: string): string | undefined {
  const id = runId ?? (existsSync(runsDir) ? readdirSync(runsDir)[0] : undefined);
  return id ? join(runsDir, id) : undefined;
}
