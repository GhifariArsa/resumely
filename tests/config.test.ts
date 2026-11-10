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
