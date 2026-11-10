import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../paths";
import { UserError } from "../errors";

const CONFIG_TOML = `# resumely config. Uncomment and edit to override defaults.

# Which agent harness to drive (see adapters below to customize)
# harness = "claude"

# Resume template name (in templates/ or built-in)
# template = "classic"

# Target page count
# pages = 1

# Harness run timeout, in minutes
# timeout_minutes = 10

# Output filename pattern
# filename = "{First}_{Last}_{Kind}_{Company}"

# Custom adapters (commands are argv arrays, never shell strings):
# [adapters.mine]
# command = ["my-agent", "--model", "{model}", "--prompt-file", "{prompt}"]
# check = ["my-agent", "--version"]
# model = "my-model"   # optional; without it "--model", "{model}" is dropped
`;

const ABOUT_MD = `---
name: "Your Name"
email: "you@example.com"
links: []
---

Write a short professional summary about yourself here.
`;

const SKILLS_YAML = `# Group your skills by category.
Languages: []
Tools: []
`;

/** Write a starter file unless one already exists (re-init must never clobber profile data). */
function writeIfAbsent(path: string, content: string): void {
  try {
    writeFileSync(path, content, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

export function initDataRoot(root: string): void {
  const l = layout(root);
  if (existsSync(l.config)) {
    throw new UserError(`Data root already initialized at ${root}`, "Delete config.toml to re-init, or use a different RESUMELY_HOME");
  }
  for (const sub of ["experience", "projects", "education", "extras", "voice"]) {
    mkdirSync(join(l.profile, sub), { recursive: true });
  }
  for (const d of [l.applications, l.templates, l.runs]) mkdirSync(d, { recursive: true });
  writeIfAbsent(join(l.profile, "about.md"), ABOUT_MD);
  writeIfAbsent(join(l.profile, "skills.yaml"), SKILLS_YAML);
  writeFileSync(l.config, CONFIG_TOML);
}
