import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../src/errors";
import { RunCheckpoint, isAlive, listRuns, pickResumable, relinkRuns, type RunOptions } from "../src/pipeline/checkpoint";
import { runAgentStep } from "../src/pipeline/workspace";

const fx = join(import.meta.dir, "fixtures");
const adapter = { command: ["bun", join(fx, "fake-harness.ts"), "{workspace}"] };
const options: RunOptions = { template: "classic", mode: "truthful", pages: 1, cover: true, research: true, review: true, input: { kind: "file", path: "/tmp/job.md" } };

let dir: string;
let runs: string;
let profileDir: string;
const saved = process.env.FAKE_HARNESS_SCRIPT;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resumely-checkpoint-"));
  runs = join(dir, ".runs");
  profileDir = join(dir, "profile");
  cpSync(join(fx, "profile-jordan"), profileDir, { recursive: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env.FAKE_HARNESS_SCRIPT;
  else process.env.FAKE_HARNESS_SCRIPT = saved;
  rmSync(dir, { recursive: true, force: true });
});

const create = (id: string) => RunCheckpoint.create(runs, id, { harness: "fake", options, jobText: "# Job\n", profileDir });
const readState = (id: string) => JSON.parse(readFileSync(join(runs, id, "state.json"), "utf8"));
/** Overwrite fields of a run's state.json directly (status, pid, updated…). */
const patch = (id: string, over: Record<string, unknown>) => writeFileSync(join(runs, id, "state.json"), JSON.stringify({ ...readState(id), ...over }));

describe("RunCheckpoint", () => {
  test("create writes state.json, inputs/job.md and a profile snapshot without .inbox", () => {
    mkdirSync(join(profileDir, ".inbox"), { recursive: true });
    writeFileSync(join(profileDir, ".inbox/x.md"), "draft");
    const cp = create("r1");
    const s = readState("r1");
    expect(s).toMatchObject({ version: 1, run_id: "r1", status: "running", pid: process.pid, harness: "fake", options, app: null, steps: {}, research: null, documents: {}, error: null });
    expect(readFileSync(join(runs, "r1/inputs/job.md"), "utf8")).toBe("# Job\n");
    expect(existsSync(join(runs, "r1/inputs/profile/about.md"))).toBe(true);
    expect(existsSync(join(runs, "r1/inputs/profile/.inbox"))).toBe(false);
    expect(cp.dir).toBe(join(runs, "r1"));
    expect(cp.profileDir).toBe(join(runs, "r1/inputs/profile"));
    expect(cp.jobText).toBe("# Job\n");
  });

  test("done → load round trip keeps the step; no state.json.tmp remains", () => {
    const cp = create("r1");
    expect(cp.get("parse")).toBeNull();
    cp.done("parse", { harness: "fake2", outFile: "parsed-job.json", fallback: true });
    expect(existsSync(join(runs, "r1/state.json.tmp"))).toBe(false);
    const back = RunCheckpoint.load(runs, "r1");
    expect(back.get("parse")).toEqual({ harness: "fake2" });
    expect(back.state.steps.parse).toMatchObject({ harness: "fake2", fallback: true, out: join("parse", "out", "parsed-job.json") });
    expect(back.jobText).toBe("# Job\n");
  });

  test("fail and abort set the status; fail records the error", () => {
    const cp = create("r1");
    cp.fail(new UserError("boom", "do x"));
    expect(readState("r1")).toMatchObject({ status: "failed", error: { message: "boom", hint: "do x" } });
    cp.abort();
    expect(readState("r1").status).toBe("aborted");
  });
});

describe("runAgentStep with a checkpoint", () => {
  test("a cache hit with a valid out file spawns nothing; a corrupt out file reruns and records again", async () => {
    const scriptPath = join(dir, "script.json");
    writeFileSync(scriptPath, JSON.stringify({ parse: [{ "out/x.json": { a: 1 } }] }));
    process.env.FAKE_HARNESS_SCRIPT = scriptPath;
    const cp = create("r1");
    const ws = join(cp.dir, "parse");
    mkdirSync(join(ws, "out"), { recursive: true });
    writeFileSync(join(ws, "out/x.json"), JSON.stringify({ a: 1 }));
    cp.done("parse", { harness: "fake", outFile: "x.json", fallback: false });
    const progress: string[] = [];
    const step = () =>
      runAgentStep({
        adapter, name: "fake", workspace: ws, instructions: "go", files: {}, outFile: "x.json", timeoutMs: 20000, checkpoint: cp,
        validate: (raw) => ({ ok: true as const, value: raw as { a: number }, warnings: ["fresh"] }),
        onProgress: (m) => progress.push(m),
      });
    const hit = await step();
    expect(hit).toEqual({ value: { a: 1 }, warnings: ["fresh"], harness: "fake" });
    expect(existsSync(`${scriptPath}.calls`)).toBe(false);
    expect(progress).toEqual(["parse: reused from checkpoint"]);

    writeFileSync(join(ws, "out/x.json"), "{not json");
    const before = readState("r1").steps.parse.finished;
    await Bun.sleep(5);
    const miss = await step();
    expect(miss.value).toEqual({ a: 1 });
    expect(readFileSync(`${scriptPath}.calls`, "utf8").trim().split("\n")).toEqual(["parse"]);
    expect(readState("r1").steps.parse.finished).not.toBe(before);
  });
});

describe("pickResumable", () => {
  test("prefers the newest failed run; skips done and aborted", () => {
    for (const id of ["a", "b", "c", "d"]) create(id);
    patch("a", { status: "failed", updated: "2026-01-01T00:00:00.000Z" });
    patch("b", { status: "failed", updated: "2026-01-02T00:00:00.000Z" });
    patch("c", { status: "done", updated: "2026-01-03T00:00:00.000Z" });
    patch("d", { status: "aborted", updated: "2026-01-04T00:00:00.000Z" });
    expect(listRuns(runs).map((s) => s.run_id)).toEqual(["d", "c", "b", "a"]);
    expect(pickResumable(runs).state.run_id).toBe("b");
  });

  test("picks a stale running run; a live one is still running", () => {
    create("a");
    patch("a", { status: "running", pid: 999999 });
    expect(isAlive(999999)).toBe(false);
    expect(isAlive(process.pid)).toBe(true);
    expect(pickResumable(runs).state.run_id).toBe("a");
    expect(pickResumable(runs, "a").state.run_id).toBe("a");
    patch("a", { pid: process.pid });
    expect(() => pickResumable(runs, "a")).toThrow(`Run a is still running (pid ${process.pid})`);
    expect(() => pickResumable(runs)).toThrow("No failed run to resume");
  });

  test("explicit id errors: done, missing, unreadable", () => {
    create("a");
    patch("a", { status: "done", app: { dir: "/apps/x", slug: "x" } });
    const e = (() => {
      try {
        pickResumable(runs, "a");
      } catch (x) {
        return x as UserError;
      }
    })();
    expect(e).toBeInstanceOf(UserError);
    expect(e!.message).toBe("Run a already finished");
    expect(e!.hint).toBe("Its documents are in /apps/x");
    expect(() => pickResumable(runs, "nope")).toThrow('No run "nope"');
    writeFileSync(join(runs, "a/state.json"), "{broken");
    expect(() => pickResumable(runs, "a")).toThrow("Run a has an unreadable state.json");
    expect(listRuns(runs)).toEqual([]);
  });

  test("no runs at all", () => {
    expect(() => pickResumable(runs)).toThrow("No failed run to resume");
    expect(listRuns(runs)).toEqual([]);
  });
});

test("relinkRuns rewrites app.dir and slug", () => {
  const a = create("a");
  a.setApp({ dir: "/apps/old", slug: "old" });
  create("b").setApp({ dir: "/apps/other", slug: "other" });
  expect(relinkRuns(runs, "/apps/old", { dir: "/apps/new", slug: "new" })).toBe(1);
  expect(readState("a").app).toEqual({ dir: "/apps/new", slug: "new" });
  expect(readState("b").app).toEqual({ dir: "/apps/other", slug: "other" });
});
