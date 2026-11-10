import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("re-init after removing config.toml keeps existing about.md and skills.yaml", () => {
  const d = join(mkdtempSync(join(tmpdir(), "resumely-")), "r");
  initDataRoot(d);
  writeFileSync(join(d, "profile/about.md"), "---\nname: Real Person\nemail: r@example.com\n---\nmine\n");
  writeFileSync(join(d, "profile/skills.yaml"), "Languages: [Go]\n");
  rmSync(join(d, "config.toml"));
  initDataRoot(d);
  expect(readFileSync(join(d, "profile/about.md"), "utf8")).toContain("Real Person");
  expect(readFileSync(join(d, "profile/skills.yaml"), "utf8")).toBe("Languages: [Go]\n");
  expect(existsSync(join(d, "config.toml"))).toBe(true);
});
