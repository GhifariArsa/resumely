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
