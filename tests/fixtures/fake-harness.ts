// Fake coding-agent CLI for tests. Usage: bun fake-harness.ts <workspace>
// FAKE_HARNESS_SCRIPT: JSON file { "<call-index>": { "<relative path>": <json | "INVALID"> } }
// FAKE_HARNESS_EXIT=1: fail with a rate-limit message.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (process.env.FAKE_HARNESS_EXIT === "1") {
  console.error("usage limit reached");
  process.exit(1);
}
const workspace = process.argv[2] ?? process.cwd();
const scriptPath = process.env.FAKE_HARNESS_SCRIPT;
if (scriptPath) {
  const countPath = `${scriptPath}.count`;
  const idx = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 0;
  writeFileSync(countPath, String(idx));
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, Record<string, unknown>>;
  for (const [rel, value] of Object.entries(script[String(idx)] ?? {})) {
    const p = join(workspace, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, value === "INVALID" ? "{not json" : JSON.stringify(value, null, 2));
  }
}
