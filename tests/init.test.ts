import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { initDataRoot } from "../src/commands/init";
import { loadConfig } from "../src/config";
import { UserError } from "../src/errors";

test("init creates layout and refuses twice", () => {
  const d = join(mkdtempSync(join(tmpdir(), "resumely-")), "r");
  initDataRoot(d);
  for (const p of ["config.toml", "profile/experience", "profile/projects", "profile/education", "profile/extras", "profile/voice", "profile/about.md", "profile/skills.yaml", "applications", "templates", ".runs"]) {
    expect(existsSync(join(d, p))).toBe(true);
  }
  expect(loadConfig(d).harness).toBe("claude");
  const m = readFileSync(join(d, "profile/about.md"), "utf8").match(/^---\n([\s\S]*?)\n---/);
  expect(parseYaml(m![1]!)).toEqual({ name: "Your Name", email: "you@example.com", links: [] });
  expect(() => initDataRoot(d)).toThrow(UserError);
});
