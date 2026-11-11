import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DRIVER = resolve(import.meta.dir, "fixtures/research-driver.ts");

test("SIGINT during research: exit 130, temp root removed, harness child killed", async () => {
  const base = mkdtempSync(join(tmpdir(), "resumely-sig-"));
  const script = join(base, "script.json");
  const ls = join(base, "ls.jsonl");
  writeFileSync(script, JSON.stringify({ research: [{ $sleep: 30000 }] }));
  const proc = Bun.spawn(["bun", DRIVER, base], {
    env: { ...process.env, FAKE_HARNESS_SCRIPT: script, FAKE_HARNESS_LS: ls },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(existsSync(ls) && readFileSync(ls, "utf8").includes("\n"))) await Bun.sleep(50);
  const entry = JSON.parse(readFileSync(ls, "utf8").trim().split("\n")[0]!);
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(130);
  expect(existsSync(dirname(entry.workspace))).toBe(false);
  const until = Date.now() + 2000;
  const alive = () => {
    try {
      process.kill(entry.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (alive() && Date.now() < until) await Bun.sleep(50);
  expect(alive()).toBe(false);
}, 20000);

test("process signal listeners are removed once every handler unregisters, and re-added on the next", async () => {
  const { onInterrupt } = await import("../src/signals");
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  const off1 = onInterrupt(() => {});
  const off2 = onInterrupt(() => {});
  expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
  expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
  off1();
  expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
  off2();
  off2();
  expect(process.listenerCount("SIGINT")).toBe(before.int);
  expect(process.listenerCount("SIGTERM")).toBe(before.term);
  const off3 = onInterrupt(() => {});
  expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
  off3();
  expect(process.listenerCount("SIGINT")).toBe(before.int);
});
