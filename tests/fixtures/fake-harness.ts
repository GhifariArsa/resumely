// Fake coding-agent CLI for tests. Usage: bun fake-harness.ts <workspace>
// The step name is basename(workspace).
// FAKE_HARNESS_SCRIPT: JSON file { "<step>": [ { "<relative path>": <json | "INVALID"> }, ... ] }
//   Array index = attempt number for that workspace (counted in <workspace>/.fake-count); extra attempts
//   reuse the last element; {} writes nothing. An attempt may also set "$stderr" (printed to stderr) and
//   "$exit" (exit code). Every call (including failing ones) appends "<step>\n" to <script>.calls.
// FAKE_HARNESS_EXIT=1: fail with a rate-limit message.
// FAKE_HARNESS_FAIL_STEP=<step>: fail with a rate-limit message for that step only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const workspace = process.argv[2] ?? process.cwd();
const step = basename(workspace);
const scriptPath = process.env.FAKE_HARNESS_SCRIPT;
if (scriptPath) appendFileSync(`${scriptPath}.calls`, `${step}\n`);
if (process.env.FAKE_HARNESS_EXIT === "1" || process.env.FAKE_HARNESS_FAIL_STEP === step) {
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
  for (const [rel, value] of Object.entries(call)) {
    if (rel.startsWith("$")) continue;
    const p = join(workspace, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, value === "INVALID" ? "{not json" : JSON.stringify(value, null, 2));
  }
  if (typeof call.$stderr === "string") console.error(call.$stderr);
  if (typeof call.$exit === "number") process.exit(call.$exit);
}
