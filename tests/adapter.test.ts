import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UserError } from "../src/errors";
import type { Config } from "../src/config";
import { HarnessError, PRESETS, classifyFailure, expandCommand, resolveAdapter, resolveFallbacks, runHarness } from "../src/harness/adapter";
import { validateResearch } from "../src/pipeline/validate";
import { runAgentStep } from "../src/pipeline/workspace";

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

describe("resolveAdapter research", () => {
  test("pi has no research command", () => {
    expect(resolveAdapter("pi", cfg(), { research: true })).toBeNull();
  });
  test("claude research command allows web tools", () => {
    const a = resolveAdapter("claude", cfg(), { research: true })!;
    const i = a.command.indexOf("--allowedTools");
    expect(a.command[i + 1]).toContain("WebSearch WebFetch");
  });
  test("codex research command uses --search", () => {
    expect(resolveAdapter("codex", cfg(), { research: true })!.command.slice(0, 3)).toEqual(["codex", "--search", "exec"]);
  });
  test("user research_command overrides preset; absent means null", () => {
    const rc = ["mine", "{prompt}"];
    expect(resolveAdapter("claude", cfg({ claude: { command: ["x"], research_command: rc } }), { research: true })!.command).toEqual(rc);
    expect(resolveAdapter("foo", cfg({ foo: { command: ["foo"] } }), { research: true })).toBeNull();
  });
  test("without research option the normal command is returned", () => {
    expect(resolveAdapter("claude", cfg()).command).toEqual(PRESETS.claude.command);
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

  test("fake harness: step-keyed attempts, .fake-count, .calls log", async () => {
    const root = tmp();
    const ws = join(root, "write");
    mkdirSync(ws);
    const script = join(root, "script.json");
    writeFileSync(script, JSON.stringify({ write: [{ "out/a.json": { x: 1 }, "b.json": "INVALID" }, { "c.json": [2] }], other: [{}] }));
    process.env.FAKE_HARNESS_SCRIPT = script;
    try {
      const a = { command: ["bun", FAKE, "{workspace}"] };
      const r = await runHarness(a, base(ws));
      expect(JSON.parse(readFileSync(join(ws, "out/a.json"), "utf8"))).toEqual({ x: 1 });
      expect(readFileSync(join(ws, "b.json"), "utf8")).toBe("{not json");
      expect(readFileSync(join(ws, ".fake-count"), "utf8")).toBe("0");
      expect(existsSync(join(ws, "stdout.log"))).toBe(true);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      await runHarness(a, base(ws));
      expect(JSON.parse(readFileSync(join(ws, "c.json"), "utf8"))).toEqual([2]);
      await runHarness(a, base(ws)); // extra attempt reuses last element
      expect(readFileSync(join(ws, ".fake-count"), "utf8")).toBe("2");
      const ws2 = join(root, "other");
      mkdirSync(ws2);
      await runHarness(a, base(ws2));
      mkdirSync(join(root, "unscripted"));
      await runHarness(a, base(join(root, "unscripted")));
      expect(readFileSync(script + ".calls", "utf8")).toBe("write\nwrite\nwrite\nother\nunscripted\n");
    } finally {
      delete process.env.FAKE_HARNESS_SCRIPT;
    }
  });

  test("FAKE_HARNESS_FAIL_STEP fails only that step", async () => {
    const root = tmp();
    const bad = join(root, "research");
    const good = join(root, "write");
    mkdirSync(bad);
    mkdirSync(good);
    process.env.FAKE_HARNESS_FAIL_STEP = "research";
    try {
      const a = { command: ["bun", FAKE, "{workspace}"] };
      const e = await runHarness(a, base(bad)).catch((x) => x);
      expect(e).toBeInstanceOf(HarnessError);
      expect(e.kind).toBe("rate_limit");
      await runHarness(a, base(good));
    } finally {
      delete process.env.FAKE_HARNESS_FAIL_STEP;
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

describe("robustness", () => {
  const company = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/company.json"), "utf8"));
  const fake = (tag: string) => ({ command: ["bun", FAKE, "{workspace}", "--as", tag] });
  const step = (ws: string, over: Record<string, unknown> = {}) =>
    runAgentStep({ adapter: fake("a"), name: "a", workspace: ws, instructions: "x", files: {}, outFile: "company.json", validate: validateResearch, timeoutMs: 20000, ...over } as never);
  const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
    Object.assign(process.env, env);
    try {
      await fn();
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  };
  const script = (root: string, body: unknown) => {
    const p = join(root, "script.json");
    writeFileSync(p, JSON.stringify(body));
    return p;
  };

  test("claude research preset is web-only", () => {
    const c = resolveAdapter("claude", cfg(), { research: true })!.command;
    expect(c[c.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch,Write");
    expect(c).toContain("--strict-mcp-config");
    // Word match: the mandated "acceptEdits" permission mode legitimately contains "Edit".
    for (const bad of ["Read", "Glob", "Edit", "Bash"]) expect(c.some((x) => x.split(/[\s,]+/).includes(bad))).toBe(false);
  });
  test("auth_check presets", () => {
    expect(PRESETS.codex.auth_check).toEqual(["codex", "login", "status"]);
    expect(PRESETS.claude.auth_check).toEqual(["claude", "auth", "status"]);
    expect(PRESETS.pi.auth_check).toBeUndefined();
  });

  test("resolveFallbacks drops primary and duplicates; unknown throws", () => {
    const c = { ...cfg(), fallback_harnesses: ["claude", "codex", "claude"] } as Config;
    expect(resolveFallbacks(c, "claude").map((f) => f.name)).toEqual(["codex"]);
    const e = (() => {
      try {
        resolveFallbacks({ ...cfg(), fallback_harnesses: ["nope"] } as Config, "claude");
      } catch (x) {
        return x as UserError;
      }
    })();
    expect(e).toBeInstanceOf(UserError);
    expect(e!.message).toContain("fallback_harnesses");
  });

  test("invalid output on every attempt -> invalid_output", async () => {
    const root = tmp();
    const s = script(root, { research: [{ "out/company.json": "INVALID" }] });
    await withEnv({ FAKE_HARNESS_SCRIPT: s }, async () => {
      const e = await step(join(root, "research")).catch((x) => x);
      expect(e).toBeInstanceOf(HarnessError);
      expect(e.kind).toBe("invalid_output");
      expect(e.message).toBe("Agent output invalid after 3 attempts");
      expect(e.hint).toStartWith("Inspect ");
    });
  });

  test("fallback takes over on rate_limit and logs to stdout.<name>.log", async () => {
    const root = tmp();
    const s = script(root, { research: [{ "out/company.json": company }] });
    const progress: string[] = [];
    await withEnv({ FAKE_HARNESS_SCRIPT: s, FAKE_HARNESS_FAIL_AS: "a" }, async () => {
      const ws = join(root, "research");
      const r = await step(ws, { fallbacks: [{ name: "b", adapter: fake("b") }], onProgress: (m: string) => progress.push(m) });
      expect(r.harness).toBe("b");
      expect(validateResearch(r.value).ok).toBe(true);
      expect(existsSync(join(ws, "stdout.log"))).toBe(true);
      expect(existsSync(join(ws, "stdout.b.log"))).toBe(true);
      expect(progress).toContain("a failed (rate_limit); trying b…");
    });
  });

  test("no fallbacks -> rate_limit error", async () => {
    const root = tmp();
    await withEnv({ FAKE_HARNESS_FAIL_AS: "a" }, async () => {
      const e = await step(join(root, "research")).catch((x) => x);
      expect(e.kind).toBe("rate_limit");
    });
  });

  test("invalid_output never falls back", async () => {
    const root = tmp();
    const s = script(root, { research: [{ "out/company.json": "INVALID" }] });
    const ls = join(root, "ls.jsonl");
    await withEnv({ FAKE_HARNESS_SCRIPT: s, FAKE_HARNESS_LS: ls }, async () => {
      const e = await step(join(root, "research"), { fallbacks: [{ name: "b", adapter: fake("b") }] }).catch((x) => x);
      expect(e.kind).toBe("invalid_output");
      const tags = readFileSync(ls, "utf8").trim().split("\n").map((l) => JSON.parse(l).tag);
      expect(tags).not.toContain("b");
    });
  });

  test("inline prompt mode embeds files and the output instruction", async () => {
    const root = tmp();
    const s = script(root, { research: [{ "out/company.json": company }] });
    const ls = join(root, "ls.jsonl");
    await withEnv({ FAKE_HARNESS_SCRIPT: s, FAKE_HARNESS_LS: ls }, async () => {
      const a = { command: ["bun", FAKE, "{workspace}", "--prompt", "{prompt}"] };
      await step(join(root, "research"), { adapter: a, promptMode: "inline", instructions: "DO IT", files: { "target.json": '{"company":"X"}' } });
      const p: string = JSON.parse(readFileSync(ls, "utf8").trim().split("\n")[0]!).prompt;
      expect(p).toBe('DO IT\n\n## target.json\n\n```\n{"company":"X"}\n```\n\nWrite out/company.json with your file-writing tool. You do not need to read any files.');
    });
  });
});
