// Fake coding-agent CLI for tests. Usage: bun fake-harness.ts <workspace> [--as <tag>] [--prompt <text>]
// --as tags this instance (for fallback tests); --prompt records the prompt it was given (in the LS log).
// The step name is basename(workspace).
// FAKE_HARNESS_SCRIPT: JSON file { "<step>": [ { "<relative path>": <json | "INVALID"> }, ... ] }
//   Array index = attempt number for that workspace (counted in <workspace>/.fake-count); extra attempts
//   reuse the last element; {} writes nothing. An attempt may also set "$stderr" (printed to stderr) and
//   "$exit" (exit code). Every call (including failing ones) appends "<step>\n" to <script>.calls.
// FAKE_HARNESS_EXIT=1: fail with a rate-limit message.
// FAKE_HARNESS_FAIL_STEP=<step>: fail with a rate-limit message for that step only.
// FAKE_HARNESS_FAIL_AS=<tag>: fail with a rate-limit message when this instance's --as tag matches. Combined
//   with FAKE_HARNESS_FAIL_STEP, both must match.
// An attempt may also set "$sleep": <ms>, which sleeps before writing anything.
// FAKE_HARNESS_LS=<file>: append {"step","workspace","files","target","tag","prompt","pid"} (the workspace listing
//   on entry, target.json's contents when present, the --as tag, the --prompt text and process.pid) as a JSON line.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const workspace = process.argv[2] ?? process.cwd();
const step = basename(workspace);
const flag = (name: string) => {
  const i = process.argv.indexOf(name, 3);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const tag = flag("--as");
const prompt = flag("--prompt");
const scriptPath = process.env.FAKE_HARNESS_SCRIPT;
if (scriptPath) appendFileSync(`${scriptPath}.calls`, `${step}\n`);
if (process.env.FAKE_HARNESS_LS) {
  const target = join(workspace, "target.json");
  const entry = { step, workspace, files: readdirSync(workspace).sort(), target: existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : undefined, tag, prompt, pid: process.pid };
  appendFileSync(process.env.FAKE_HARNESS_LS, JSON.stringify(entry) + "\n");
}
const failStep = process.env.FAKE_HARNESS_FAIL_STEP;
const failAs = process.env.FAKE_HARNESS_FAIL_AS;
const targeted = failStep !== undefined || failAs !== undefined;
const targetHit = (failStep === undefined || failStep === step) && (failAs === undefined || failAs === tag);
if (process.env.FAKE_HARNESS_EXIT === "1" || (targeted && targetHit)) {
  console.error("usage limit reached");
  process.exit(1);
}
if (scriptPath) {
  mkdirSync(workspace, { recursive: true });
  const countPath = join(workspace, ".fake-count");
  const idx = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 0;
  writeFileSync(countPath, String(idx));
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, Record<string, unknown>[]>;
  const attempts = script[step] ?? [];
  const call = attempts[Math.min(idx, attempts.length - 1)] ?? {};
  if (typeof call.$sleep === "number") await new Promise((r) => setTimeout(r, call.$sleep as number));
  for (const [rel, value] of Object.entries(call)) {
    if (rel.startsWith("$")) continue;
    const p = join(workspace, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, value === "INVALID" ? "{not json" : JSON.stringify(value, null, 2));
  }
  if (typeof call.$stderr === "string") console.error(call.$stderr);
  if (typeof call.$exit === "number") process.exit(call.$exit);
}
