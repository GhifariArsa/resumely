import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UserError } from "../src/errors";
import type { Config } from "../src/config";
import { HarnessError, PRESETS, classifyFailure, expandCommand, resolveAdapter, runHarness } from "../src/harness/adapter";

const FAKE = resolve(import.meta.dir, "fixtures/fake-harness.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "resumely-adapter-"));
const cfg = (adapters: Config["adapters"] = {}) => ({ adapters }) as Config;

describe("expandCommand", () => {
  test("substitutes placeholders per argv element, including inside larger args", () => {
    const out = expandCommand(
      { command: ["x", "{prompt}", "--ws={workspace}", "-m", "{model}", "pre {prompt} post"] },
      { prompt: "hello world", workspace: "/w", model: "m1" },
    );
    expect(out).toEqual(["x", "hello world", "--ws=/w", "-m", "m1", "pre hello world post"]);
  });
  test("no model: a bare {model} argv element is dropped with its preceding flag", () => {
    const vars = { prompt: "p", workspace: "/w" };
    expect(expandCommand({ command: ["x", "--model", "{model}", "{prompt}"] }, vars)).toEqual(["x", "p"]);
    expect(expandCommand({ command: ["x", "-m", "{model}"] }, vars)).toEqual(["x"]);
    expect(expandCommand({ command: ["x", "pos", "{model}"] }, vars)).toEqual(["x", "pos"]);
    expect(expandCommand({ command: ["x", "{model}"] }, vars)).toEqual(["x"]);
    expect(expandCommand({ command: ["x", "--model={model}"] }, vars)).toEqual(["x", "--model="]);
    expect(expandCommand({ command: ["x", "--model", "{model}"] }, { ...vars, model: "m1" })).toEqual(["x", "--model", "m1"]);
  });
  test("prompt containing placeholder-like text is not re-expanded", () => {
    expect(expandCommand({ command: ["{prompt}", "{workspace}"] }, { prompt: "{workspace}", workspace: "/w" })).toEqual(["{workspace}", "/w"]);
  });
});

describe("resolveAdapter", () => {
  test("preset by name", () => {
    expect(resolveAdapter("claude", cfg())).toEqual(PRESETS.claude);
  });
  test("config override beats preset", () => {
    const a = { command: ["mine"] };
    expect(resolveAdapter("claude", cfg({ claude: a }))).toEqual(a);
  });
  test("custom name from config", () => {
    expect(resolveAdapter("foo", cfg({ foo: { command: ["foo"] } })).command).toEqual(["foo"]);
  });
  test("unknown name throws UserError listing known names", () => {
    try {
      resolveAdapter("nope", cfg({ foo: { command: ["foo"] } }));
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      const u = e as UserError;
      const text = u.message + (u.hint ?? "");
      for (const n of ["claude", "codex", "pi", "foo"]) expect(text).toContain(n);
    }
  });
});

describe("classifyFailure", () => {
  test.each([
    [1, "", false, "ENOENT", "not_installed"],
    [null, "", true, undefined, "timeout"],
    [1, "You hit the usage limit", false, undefined, "rate_limit"],
    [1, "HTTP 429", false, undefined, "rate_limit"],
    [1, "quota exceeded", false, undefined, "rate_limit"],
    [1, "usage limit reached, please log in again", false, undefined, "rate_limit"],
    [1, "Please log in", false, undefined, "auth"],
    [1, "401 Unauthorized", false, undefined, "auth"],
    [1, "boom", false, undefined, "unknown"],
    [1, "authentication failed", false, undefined, "auth"],
    [1, "Authorization required", false, undefined, "auth"],
    [1, "error in author field", false, undefined, "unknown"],
    [1, "processed 14290 tokens then crashed", false, undefined, "unknown"],
    [1, "id 4013 not found", false, undefined, "unknown"],
  ] as const)("%p %p timedOut=%p %p -> %p", (code, stderr, timedOut, spawn, kind) => {
    expect(classifyFailure(code, stderr, timedOut, spawn)).toBe(kind);
  });
});

describe("runHarness", () => {
  const base = (workspace: string) => ({ workspace, prompt: "p", timeoutMs: 5000, name: "t" });

  test("missing binary -> not_installed with hint", async () => {
    const e = await runHarness({ command: ["definitely-not-a-binary-xyz"] }, base(tmp())).catch((x) => x);
    expect(e).toBeInstanceOf(HarnessError);
    expect(e.kind).toBe("not_installed");
    expect(e.message).toBe("t failed (not_installed)");
    expect(e.hint).toBe("Install definitely-not-a-binary-xyz or choose another harness with --harness");
  });

  test("timeout kills the process", async () => {
    const t0 = Date.now();
    const e = await runHarness({ command: ["sleep", "5"] }, { ...base(tmp()), timeoutMs: 200 }).catch((x) => x);
    expect(e).toBeInstanceOf(HarnessError);
    expect(e.kind).toBe("timeout");
    expect(e.hint).toBe("Raise timeout_minutes in config.toml");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("timeout still writes partial logs", async () => {
    const ws = tmp();
    const e = await runHarness({ command: ["bash", "-c", "echo partial; sleep 5"] }, { ...base(ws), timeoutMs: 300 }).catch((x) => x);
    expect(e.kind).toBe("timeout");
    expect(readFileSync(join(ws, "stdout.log"), "utf8")).toContain("partial");
    expect(existsSync(join(ws, "stderr.log"))).toBe(true);
  });

  test("timeout kills grandchildren holding pipes", async () => {
    const t0 = Date.now();
    const e = await runHarness({ command: ["sh", "-c", "sleep 5 & sleep 5"] }, { ...base(tmp()), timeoutMs: 200 }).catch((x) => x);
    expect(e.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("fake harness writes files, logs, and call index", async () => {
    const ws = tmp();
    const script = join(tmp(), "script.json");
    writeFileSync(script, JSON.stringify({ "0": { "out/a.json": { x: 1 }, "b.json": "INVALID" }, "1": { "c.json": [2] } }));
    process.env.FAKE_HARNESS_SCRIPT = script;
    try {
      const a = { command: ["bun", FAKE, "{workspace}"] };
      const r = await runHarness(a, base(ws));
      expect(JSON.parse(readFileSync(join(ws, "out/a.json"), "utf8"))).toEqual({ x: 1 });
      expect(readFileSync(join(ws, "b.json"), "utf8")).toBe("{not json");
      expect(readFileSync(script + ".count", "utf8")).toBe("0");
      expect(existsSync(join(ws, "stdout.log"))).toBe(true);
      expect(existsSync(join(ws, "stderr.log"))).toBe(true);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      await runHarness(a, base(ws));
      expect(JSON.parse(readFileSync(join(ws, "c.json"), "utf8"))).toEqual([2]);
    } finally {
      delete process.env.FAKE_HARNESS_SCRIPT;
    }
  });

  test("FAKE_HARNESS_EXIT=1 -> rate_limit, logs written", async () => {
    const ws = tmp();
    process.env.FAKE_HARNESS_EXIT = "1";
    try {
      const e = await runHarness({ command: ["bun", FAKE, "{workspace}"] }, base(ws)).catch((x) => x);
      expect(e).toBeInstanceOf(HarnessError);
      expect(e.kind).toBe("rate_limit");
      expect(e.hint).toBe("Usage limit reached; retry later or use --harness <other>");
      expect(readFileSync(join(ws, "stderr.log"), "utf8")).toContain("usage limit reached");
    } finally {
      delete process.env.FAKE_HARNESS_EXIT;
    }
  });

  test("classifies on stdout too", async () => {
    const e = await runHarness({ command: ["sh", "-c", "echo 'Error: rate limit exceeded'; exit 1"] }, base(tmp())).catch((x) => x);
    expect(e.kind).toBe("rate_limit");
  });

  test("unknown hint: last non-empty stderr line, else stdout", async () => {
    const both = await runHarness({ command: ["sh", "-c", "echo out-line; echo err-line >&2; echo >&2; exit 1"] }, base(tmp())).catch((x) => x);
    expect(both.kind).toBe("unknown");
    expect(both.hint).toBe("err-line");
    const outOnly = await runHarness({ command: ["sh", "-c", "echo first; echo 'it broke'; echo; exit 1"] }, base(tmp())).catch((x) => x);
    expect(outOnly.hint).toBe("it broke");
  });

  test("logSuffix names per-attempt logs", async () => {
    const ws = tmp();
    await runHarness({ command: ["sh", "-c", "echo hi; echo there >&2"] }, { ...base(ws), logSuffix: ".2" });
    expect(readFileSync(join(ws, "stdout.2.log"), "utf8")).toBe("hi\n");
    expect(readFileSync(join(ws, "stderr.2.log"), "utf8")).toBe("there\n");
    expect(existsSync(join(ws, "stdout.log"))).toBe(false);
  });

  test("adapter model from config is substituted", async () => {
    const ws = tmp();
    await runHarness({ command: ["sh", "-c", 'printf %s "$*" > args.txt', "sh", "--model", "{model}", "{prompt}"], model: "m1" }, base(ws));
    expect(readFileSync(join(ws, "args.txt"), "utf8")).toBe("--model m1 p");
    await runHarness({ command: ["sh", "-c", 'printf %s "$*" > args.txt', "sh", "--model", "{model}", "{prompt}"] }, base(ws));
    expect(readFileSync(join(ws, "args.txt"), "utf8")).toBe("p");
  });

  test("auth hint uses name", async () => {
    const e = await runHarness({ command: ["sh", "-c", "echo 'please log in' >&2; exit 1"] }, base(tmp())).catch((x) => x);
    expect(e.kind).toBe("auth");
    expect(e.hint).toBe("Log in to t (run it interactively once)");
  });
});
