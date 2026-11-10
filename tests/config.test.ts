import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

test("partial config gets defaults", () => {
  const d = mkdtempSync(join(tmpdir(), "resumely-"));
  writeFileSync(join(d, "config.toml"), "pages = 2\n");
  const c = loadConfig(d);
  expect(c.pages).toBe(2);
  expect(c.harness).toBe("claude");
  expect(c.timeout_minutes).toBe(10);
  expect(c.template).toBe("classic");
  expect(c.adapters).toEqual({});
});

import { UserError } from "../src/errors";

function expectUserError(fn: () => unknown): UserError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    return e as UserError;
  }
  throw new Error("should throw");
}

test("malformed TOML -> UserError naming the path", () => {
  const d = mkdtempSync(join(tmpdir(), "resumely-"));
  writeFileSync(join(d, "config.toml"), "pages = = 2\n");
  const e = expectUserError(() => loadConfig(d));
  expect(e.message).toContain(join(d, "config.toml"));
});

test("invalid value -> UserError with field in hint", () => {
  const d = mkdtempSync(join(tmpdir(), "resumely-"));
  writeFileSync(join(d, "config.toml"), 'pages = "two"\n');
  const e = expectUserError(() => loadConfig(d));
  expect(e.message).toContain(join(d, "config.toml"));
  expect(e.hint).toContain("pages");
});

test("missing config -> UserError with init hint", () => {
  const d = mkdtempSync(join(tmpdir(), "resumely-"));
  const e = expectUserError(() => loadConfig(d));
  expect(e.hint).toBe("Run: resumely init");
});

test("adapter model is optional and parsed", () => {
  const d = mkdtempSync(join(tmpdir(), "resumely-"));
  writeFileSync(join(d, "config.toml"), '[adapters.mine]\ncommand = ["my-agent", "--model", "{model}"]\nmodel = "fast"\n[adapters.other]\ncommand = ["o"]\n');
  const c = loadConfig(d);
  expect(c.adapters.mine!.model).toBe("fast");
  expect(c.adapters.other!.model).toBeUndefined();
});

test("review config defaults and validation", () => {
  const d = mkdtempSync(join(tmpdir(), "resumely-"));
  writeFileSync(join(d, "config.toml"), "pages = 1\n");
  const c = loadConfig(d);
  expect(c.max_review_rounds).toBe(2);
  expect(c.banned_phrases).toEqual([]);
  writeFileSync(join(d, "config.toml"), "max_review_rounds = -1\n");
  const e = expectUserError(() => loadConfig(d));
  expect(e.hint).toContain("max_review_rounds");
  writeFileSync(join(d, "config.toml"), 'max_review_rounds = 0\nbanned_phrases = ["synergy"]\n[adapters.x]\ncommand = ["a"]\nresearch_command = ["b", "{prompt}"]\n');
  const c2 = loadConfig(d);
  expect(c2.max_review_rounds).toBe(0);
  expect(c2.banned_phrases).toEqual(["synergy"]);
  expect(c2.adapters.x!.research_command).toEqual(["b", "{prompt}"]);
});
