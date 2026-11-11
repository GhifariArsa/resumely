#!/usr/bin/env bun
// Opt-in, subscription-backed eval: runs the full pipeline per harness over tests/fixtures/jobs/*.md.
// Usage: bun run eval [--harness a,b] [--jobs a,b] [--out DIR] [--stretch]
// Never imported by tests, and it makes real LLM calls (many minutes per harness).
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify } from "smol-toml";
import { checkHarness, type Probe } from "../src/commands/doctor";
import { initDataRoot } from "../src/commands/init";
import { defaultConfig, loadConfig, type Config } from "../src/config";
import { PRESETS, resolveAdapter } from "../src/harness/adapter";
import { readJobFile } from "../src/job/intake";
import { layout, resolveDataRoot } from "../src/paths";
import { applyJob, type ApplyResult } from "../src/pipeline/apply";
import { spawnWithTimeout } from "../src/proc";
import { formatSummary, parseEvalArgs, runDirOf, summarizeRun, type EvalRow } from "./eval-lib";

const args = parseEvalArgs(process.argv.slice(2));
const fx = join(import.meta.dir, "../tests/fixtures");

// The user's real config is only read (for custom adapters), never written.
let userConfig: Config = defaultConfig();
try {
  const real = resolveDataRoot();
  if (existsSync(layout(real).config)) userConfig = loadConfig(real);
} catch {
  // an unreadable real config just means no custom adapters
}

const probe: Probe = async (argv) => {
  try {
    const r = await spawnWithTimeout(argv, { cwd: process.cwd(), env: process.env, timeoutMs: 15_000 });
    return { code: r.exitCode, stdout: r.stdout, missing: false };
  } catch (e) {
    return { code: null, stdout: "", missing: (e as NodeJS.ErrnoException).code === "ENOENT" };
  }
};

const candidates = args.harnesses ?? [...new Set([...Object.keys(PRESETS), ...Object.keys(userConfig.adapters)])];
const available: string[] = [];
for (const name of candidates) {
  let why: string | null = null;
  try {
    const r = await checkHarness(name, resolveAdapter(name, userConfig)!, probe, false);
    if (!r.installed) why = "not installed";
    else if (r.authenticated === false) why = "not authenticated";
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  if (why) console.error(`skipping ${name}: ${why}`);
  else available.push(name);
}
if (available.length === 0) {
  console.error("error: no harness available\nrun: resumely doctor");
  process.exit(1);
}

const jobsDir = join(fx, "jobs");
const jobs = readdirSync(jobsDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => basename(f, ".md"))
  .filter((j) => !args.jobs || args.jobs.includes(j))
  .sort();
if (jobs.length === 0) {
  console.error(`error: no fixture jobs match ${args.jobs?.join(",")}`);
  process.exit(1);
}

mkdirSync(args.out, { recursive: true });
const rows: EvalRow[] = [];
for (const harness of available) {
  for (const job of jobs) {
    const root = join(args.out, `${harness}-${job}`, "root");
    mkdirSync(root, { recursive: true });
    initDataRoot(root);
    cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
    writeFileSync(layout(root).config, stringify({ harness, adapters: userConfig.adapters }));
    const expectFile = join(jobsDir, `${job}.expect.json`);
    const expectation = existsSync(expectFile) ? await Bun.file(expectFile).json() : undefined;

    const started = Date.now();
    let result: ApplyResult | undefined;
    let error: unknown;
    try {
      result = await applyJob({
        root, input: await readJobFile(join(jobsDir, `${job}.md`)), harness, open: false,
        mode: args.stretch ? "stretch" : "truthful",
        onDuplicate: async () => "new",
        onProgress: (m) => console.error(`[${harness}/${job}] ${m}`),
      });
    } catch (e) {
      error = e;
    }
    const runDir = runDirOf(layout(root).runs, result?.runId);
    rows.push(summarizeRun({ harness, job, wallMs: Date.now() - started, result, error, runDir, expect: expectation }));
  }
}

const summary = formatSummary(rows);
writeFileSync(join(args.out, "results.json"), JSON.stringify(rows, null, 2) + "\n");
writeFileSync(join(args.out, "summary.md"), summary);
console.log(summary);
