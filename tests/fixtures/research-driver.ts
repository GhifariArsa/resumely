// Subprocess driver for signals.test.ts: runs runResearch against the fake harness (env: FAKE_HARNESS_SCRIPT, FAKE_HARNESS_LS).
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { runResearch } from "../../src/pipeline/research";

const base = process.argv[2]!;
mkdirSync(join(base, "app/job"), { recursive: true });
await runResearch({
  adapter: { command: ["bun", resolve(import.meta.dir, "fake-harness.ts"), "{workspace}"] },
  name: "fake",
  runsDir: join(base, "runs"),
  runId: "r1",
  appDir: join(base, "app"),
  job: { company: "Atlas Freight", role: "Backend", requirements: [], nice_to_haves: [], keywords: [], language: "en" },
  timeoutMs: 120000,
});
