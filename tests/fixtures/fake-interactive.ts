// Test stand-in for an interactive harness: stages the proposal in FAKE_INTERVIEW_PROPOSAL via the add command
// named in <workspace>/resumely.json, and logs its own argv to FAKE_INTERVIEW_ARGV.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ws = process.argv[2]!;
if (process.env.FAKE_INTERVIEW_ARGV) appendFileSync(process.env.FAKE_INTERVIEW_ARGV, JSON.stringify(process.argv.slice(2)) + "\n");
const { add } = JSON.parse(readFileSync(join(ws, "resumely.json"), "utf8")) as { add: string[] };
const proposal = readFileSync(process.env.FAKE_INTERVIEW_PROPOSAL!, "utf8");
const p = Bun.spawn([...add, "--source", "interview", "--json", "-"], {
  stdin: new Blob([proposal]),
  stdout: "ignore",
  stderr: "inherit",
  env: process.env,
});
process.exit(await p.exited);
