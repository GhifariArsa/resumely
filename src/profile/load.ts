import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { UserError } from "../errors";
import { stripPrivate } from "./context";
import { AboutFrontmatter, EntryFrontmatter, SkillsSchema, type About, type Entry, type EntryType, type Profile, type Skills } from "./schema";

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

function splitFrontmatterText(text: string, file: string): { data: unknown; body: string } {
  const m = text.match(FM);
  if (!m) throw new UserError(`${file}: missing YAML frontmatter`, "Start the file with a --- block");
  return { data: parseYamlSafe(m[1]!, file) ?? {}, body: text.slice(m[0].length) };
}

function splitFrontmatter(file: string): { data: unknown; body: string } {
  return splitFrontmatterText(readFileSync(file, "utf8"), file);
}

/** Entry files in the profile's entry dirs (`*.md`, sorted), with the type their directory implies. */
export function listEntryFiles(profileDir: string): { file: string; dirType: EntryType }[] {
  const out: { file: string; dirType: EntryType }[] = [];
  for (const dir of Object.keys(DIR_TYPE)) {
    const d = join(profileDir, dir);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d).filter((n) => n.endsWith(".md")).sort()) out.push({ file: join(d, name), dirType: DIR_TYPE[dir]! });
  }
  return out;
}

/** Parse one entry file's text. Throws `UserError` on missing frontmatter, invalid YAML or schema errors. */
export function parseEntryText(text: string, file: string, dirType?: EntryType): Entry {
  const { data, body } = splitFrontmatterText(text, file);
  const fm = validate(EntryFrontmatter, data, file);
  const s = stripPrivate(body);
  return { ...fm, type: fm.type ?? dirType ?? "other", body: s.body.trim(), privateLines: s.privateLines, file };
}

/** Load `skills.yaml` (empty when absent). Throws `UserError` on invalid YAML or schema. */
export function loadSkills(profileDir: string): Skills {
  const skillsFile = join(profileDir, "skills.yaml");
  if (!existsSync(skillsFile)) return {};
  return validate(SkillsSchema, parseYamlSafe(readFileSync(skillsFile, "utf8"), skillsFile) ?? {}, skillsFile);
}

/** Load just `about.md` (header data), with private keys and sections removed. */
export function loadAbout(profileDir: string): { about: About; privateKeys: number } {
  const aboutFile = join(profileDir, "about.md");
  if (!existsSync(aboutFile)) throw new UserError(`${aboutFile}: not found`, "Run `resumely init` first");
  const a = splitFrontmatter(aboutFile);
  const { private: priv, ...about } = validate(AboutFrontmatter, a.data, aboutFile);
  return { about: { ...about, body: stripPrivate(a.body).body.trim() }, privateKeys: priv ? Object.keys(priv).length : 0 };
}

export function loadProfile(profileDir: string): Profile {
  const { about, privateKeys } = loadAbout(profileDir);
  const skills = loadSkills(profileDir);

  const entries: Entry[] = [];
  const seen = new Map<string, string>();
  for (const { file, dirType } of listEntryFiles(profileDir)) {
    const entry = parseEntryText(readFileSync(file, "utf8"), file, dirType);
    const prev = seen.get(entry.id);
    if (prev) throw new UserError(`Duplicate entry id "${entry.id}" in ${prev} and ${file}`);
    seen.set(entry.id, file);
    entries.push(entry);
  }
  return { about, entries, skills, aboutPrivateKeys: privateKeys };
}

const VOICE_FILES = 3;
const VOICE_CHARS = 3000;

/** Up to 3 writing samples from `voice/*.md|*.txt`, private sections stripped, empty files skipped. */
export function loadVoiceSamples(profileDir: string): { name: string; text: string }[] {
  const d = join(profileDir, "voice");
  if (!existsSync(d)) return [];
  const out: { name: string; text: string }[] = [];
  for (const name of readdirSync(d).filter((n) => /\.(md|txt)$/i.test(n) && statSync(join(d, n)).isFile()).sort()) {
    const text = [...stripPrivate(readFileSync(join(d, name), "utf8")).body.trim()].slice(0, VOICE_CHARS).join("");
    if (!text) continue;
    out.push({ name, text });
    if (out.length === VOICE_FILES) break;
  }
  return out;
}
