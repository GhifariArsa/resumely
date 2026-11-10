import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataRoot, requireDataRoot, layout } from "../src/paths";
import { UserError } from "../src/errors";

test("resolveDataRoot uses RESUMELY_HOME", () => {
  expect(resolveDataRoot({ RESUMELY_HOME: "/x" })).toBe("/x");
});
test("resolveDataRoot falls back to ~/resumely", () => {
  expect(resolveDataRoot({ HOME: "/h" })).toBe("/h/resumely");
});
test("layout paths", () => {
  const l = layout("/r");
  expect(l.runs).toBe("/r/.runs");
  expect(l.config).toBe("/r/config.toml");
});
test("requireDataRoot throws UserError with hint", () => {
  const d = mkdtempSync(join(tmpdir(), "resumely-"));
  try {
    requireDataRoot(d);
    throw new Error("should throw");
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    expect((e as UserError).hint).toBe("Run: resumely init");
    expect((e as UserError).message).toBe(`No resumely data root at ${d}`);
  }
});
