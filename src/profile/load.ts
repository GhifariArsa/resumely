import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { UserError } from "../errors";
import { stripPrivate } from "./context";
import { AboutFrontmatter, EntryFrontmatter, SkillsSchema, type Entry, type EntryType, type Profile } from "./schema";

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const DIR_TYPE: Record<string, EntryType> = { experience: "experience", projects: "project", education: "education", extras: "other" };

function parseYamlSafe(text: string, file: string): unknown {
  try {
    return parseYaml(text);
  } catch (e) {
    throw new UserError(`${file}: invalid YAML (${(e as Error).message.split("\n")[0]})`);
  }
}

function validate<T>(schema: ZodType<T>, data: unknown, file: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new UserError(`${file}: ${detail}`);
  }
  return r.data;
}

function splitFrontmatter(file: string): { data: unknown; body: string } {
  const text = readFileSync(file, "utf8");
  const m = text.match(FM);
  if (!m) throw new UserError(`${file}: missing YAML frontmatter`, "Start the file with a --- block");
  return { data: parseYamlSafe(m[1]!, file) ?? {}, body: text.slice(m[0].length) };
}

export function loadProfile(profileDir: string): Profile {
  const aboutFile = join(profileDir, "about.md");
  if (!existsSync(aboutFile)) throw new UserError(`${aboutFile}: not found`, "Run `resumely init` first");
  const a = splitFrontmatter(aboutFile);
  const { private: priv, ...about } = validate(AboutFrontmatter, a.data, aboutFile);
  const aboutBody = stripPrivate(a.body).body.trim();

  const skillsFile = join(profileDir, "skills.yaml");
  const skills = existsSync(skillsFile) ? validate(SkillsSchema, parseYamlSafe(readFileSync(skillsFile, "utf8"), skillsFile) ?? {}, skillsFile) : {};

  const entries: Entry[] = [];
  const seen = new Map<string, string>();
  for (const dir of Object.keys(DIR_TYPE)) {
    const d = join(profileDir, dir);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d).filter((n) => n.endsWith(".md")).sort()) {
      const file = join(d, name);
      const { data, body } = splitFrontmatter(file);
      const fm = validate(EntryFrontmatter, data, file);
      const prev = seen.get(fm.id);
      if (prev) throw new UserError(`Duplicate entry id "${fm.id}" in ${prev} and ${file}`);
      seen.set(fm.id, file);
      const s = stripPrivate(body);
      entries.push({ ...fm, type: fm.type ?? DIR_TYPE[dir]!, body: s.body.trim(), privateLines: s.privateLines, file });
    }
  }
  return { about: { ...about, body: aboutBody }, entries, skills, aboutPrivateKeys: priv ? Object.keys(priv).length : 0 };
}
