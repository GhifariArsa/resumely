import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument, stringify } from "yaml";
import { UserError } from "../errors";
import { normaliseSkill } from "../pipeline/validate";
import { unifiedDiff } from "./diff";
import { archiveProposal, ID_PREFIX, newEntryId, takenIds } from "./inbox";
import { listEntryFiles, loadProfile, parseEntryText } from "./load";
import type { Proposal, ProposedEntry } from "./proposal";
import { AboutFrontmatter, SkillsSchema, type Entry, type EntryType } from "./schema";

const FM_KEYS = ["id", "type", "title", "org", "location", "start", "end", "url", "skills", "tags"] as const;
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function renderBody(e: ProposedEntry): string {
  if (e.body !== undefined) return e.body.trim();
  const parts: string[] = [];
  if (e.bullets.length) parts.push("## Highlights\n\n" + e.bullets.map((b) => `- ${b}`).join("\n"));
  if (e.context.trim()) parts.push("## Context\n\n" + e.context.trim());
  return parts.join("\n\n");
}

export function entryMarkdown(e: ProposedEntry): string {
  const fm: Record<string, unknown> = {};
  for (const k of FM_KEYS) if (e[k] !== undefined) fm[k] = e[k];
  const body = renderBody(e);
  return `---\n${stringify(fm).trimEnd()}\n---\n` + (body ? `\n${body}\n` : "");
}

const DIR_FOR: Record<EntryType, string> = {
  experience: "experience",
  project: "projects",
  education: "education",
  award: "extras",
  publication: "extras",
  volunteering: "extras",
  certification: "extras",
  other: "extras",
};

/** Absolute path for a new entry file: id minus its type prefix, with `-2`, … if the file exists. */
export function entryFileFor(profileDir: string, e: { id: string; type: EntryType }): string {
  const dir = join(profileDir, DIR_FOR[e.type]);
  const prefix = `${ID_PREFIX[e.type]}-`;
  const base = e.id.startsWith(prefix) ? e.id.slice(prefix.length) : e.id;
  let file = join(dir, `${base}.md`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${base}-${n}.md`);
  return file;
}

/** Raw `## Private…` sections (heading through the line before the next `## ` or EOF), joined. */
export function privateSections(fileText: string): string {
  const out: string[] = [];
  let inPrivate = false;
  for (const line of fileText.split(/\r?\n/)) {
    if (/^##\s+Private\b.*$/i.test(line)) inPrivate = true;
    else if (inPrivate && /^##\s/.test(line)) inPrivate = false;
    if (inPrivate) out.push(line);
  }
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out.length ? out.join("\n") + "\n" : "";
}

function renderedFields(e: ProposedEntry): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of FM_KEYS) if (k !== "id" && e[k] !== undefined) o[k] = e[k];
  return o;
}

/** True when accepting `e` would not change the live entry. */
export function sameAsLive(e: ProposedEntry, live: Entry): boolean {
  const liveFields: Record<string, unknown> = {};
  for (const k of FM_KEYS) if (k !== "id" && live[k] !== undefined) liveFields[k] = live[k];
  if (!isDeepStrictEqual(renderedFields(e), liveFields)) return false;
  const body = renderBody(e).trim();
  const liveBody = live.body.trim();
  if (body === liveBody) return true;
  return e.body === undefined && e.bullets.length === 0 && e.context.trim() === liveBody;
}

const rel = (profileDir: string, file: string) => file.slice(profileDir.length + 1);

function liveFile(profileDir: string, p: Proposal): { entry: Entry; text: string } {
  const target = p.target_id!;
  const entry = loadProfile(profileDir).entries.find((x) => x.id === target);
  if (!entry || !existsSync(entry.file)) {
    throw new UserError(`Entry "${target}" no longer exists`, `Reject it, or accept it as new: resumely profile review --accept ${p.pid} --as new`);
  }
  return { entry, text: readFileSync(entry.file, "utf8") };
}

function updatedText(profileDir: string, p: Proposal): { file: string; before: string; after: string } {
  const { entry, text } = liveFile(profileDir, p);
  const priv = privateSections(text);
  const e = p.entry!;
  const m = text.match(FM_RE);
  if (!m) throw new UserError(`${entry.file}: missing YAML frontmatter`, "Start the file with a --- block");
  // Edit the live frontmatter in place so unknown keys and comments survive.
  const doc = parseDocument(m[1]!);
  for (const k of FM_KEYS) {
    if (e[k] === undefined) doc.delete(k);
    else doc.set(k, e[k]);
  }
  const body = renderBody(e);
  const after = `---\n${String(doc).trimEnd()}\n---\n` + (body ? `\n${body}\n` : "") + (priv ? "\n" + priv : "");
  return { file: entry.file, before: text, after };
}

function aboutResult(profileDir: string, p: Proposal): { file: string; before: string; after: string } {
  const file = join(profileDir, "about.md");
  if (!existsSync(file)) throw new UserError(`${file}: not found`, "Run `resumely init` first");
  const before = readFileSync(file, "utf8");
  const m = before.match(FM_RE);
  if (!m) throw new UserError("about.md: missing YAML frontmatter", "Start the file with a --- block");
  const doc = parseDocument(m[1]!);
  const { summary, links, ...scalars } = p.about!;
  for (const [k, v] of Object.entries(scalars)) if (v !== undefined) doc.set(k, v);
  if (links?.length) {
    const have = new Set(((doc.get("links") as { toJSON(): { url: string }[] } | null)?.toJSON() ?? []).map((l) => l.url));
    for (const l of links) {
      if (have.has(l.url)) continue;
      if (doc.has("links")) doc.addIn(["links"], doc.createNode(l));
      else doc.set("links", doc.createNode([l]));
      have.add(l.url);
    }
  }
  let body = before.slice(m[0].length);
  if (summary !== undefined) {
    const priv = privateSections(body);
    body = `\n${summary.trim()}\n` + (priv ? "\n" + priv : "");
  }
  const fm = String(doc).trimEnd();
  const after = `---\n${fm}\n---\n${body}`;
  const check = AboutFrontmatter.safeParse(parseDocument(fm).toJSON());
  if (!check.success) throw new UserError(`about.md would be invalid: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { file, before, after };
}

function skillsResult(profileDir: string, p: Proposal): { file: string; before: string; after: string } {
  const file = join(profileDir, "skills.yaml");
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const doc = parseDocument(before);
  const seen = new Set(Object.values((doc.toJSON() ?? {}) as Record<string, string[]>).flat().map(normaliseSkill));
  for (const [cat, items] of Object.entries(p.skills!)) {
    for (const item of items) {
      const key = normaliseSkill(item);
      if (seen.has(key)) continue;
      seen.add(key);
      if (doc.hasIn([cat])) doc.addIn([cat], item.trim());
      else doc.set(cat, doc.createNode([item.trim()]));
    }
  }
  const after = String(doc);
  const check = SkillsSchema.safeParse(parseDocument(after).toJSON() ?? {});
  if (!check.success) throw new UserError(`skills.yaml would be invalid: ${check.error.issues.map((i) => i.message).join("; ")}`);
  return { file, before, after };
}

function relFile(profileDir: string, e: ProposedEntry): string {
  return rel(profileDir, entryFileFor(profileDir, e));
}

export function previewProposal(profileDir: string, p: Proposal): string {
  const diff = (r: { file: string; before: string; after: string }) =>
    unifiedDiff(r.before, r.after, { from: `a/profile/${rel(profileDir, r.file)}`, to: `b/profile/${rel(profileDir, r.file)}` });
  switch (p.kind) {
    case "new":
      return entryMarkdown(p.entry!);
    case "update":
    case "duplicate":
      return diff(updatedText(profileDir, p));
    case "skills":
      return Object.entries(p.skills!).map(([c, items]) => `+ ${c}: ${items.join(", ")}`).join("\n");
    case "about":
      return diff(aboutResult(profileDir, p));
  }
}

function atomicWrite(file: string, text: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function validateEntry(text: string, file: string): void {
  try {
    parseEntryText(text, file);
  } catch (e) {
    if (e instanceof UserError) throw new UserError(`Proposal would write an invalid entry: ${e.message}`, e.hint);
    throw e;
  }
}

function acceptNew(profileDir: string, p: Proposal): { file: string; id: string } {
  let entry = p.entry!;
  const profile = loadProfile(profileDir);
  const taken = takenIds(profileDir, profile);
  // The proposal's own id is in `takenIds` when it is still pending, so only reassign on a real clash.
  const live = new Set(profile.entries.map((x) => x.id));
  if (live.has(entry.id)) entry = { ...entry, id: newEntryId(entry.type, entry, taken) };
  const text = entryMarkdown(entry);
  const abs = entryFileFor(profileDir, entry);
  validateEntry(text, abs);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, { flag: "wx" });
  return { file: rel(profileDir, abs), id: entry.id };
}

export function acceptProposal(profileDir: string, p: Proposal, o: { as?: "update" | "new"; now?: Date } = {}): { file: string; id?: string } {
  const at = (o.now ?? new Date()).toISOString();
  let as = o.as;
  if (p.kind === "duplicate" && !as) {
    throw new UserError(`${p.pid} is a possible duplicate of ${p.target_id}`, `Choose: --as update (replace ${p.target_id}) or --as new (keep both)`);
  }
  if (p.kind === "new") as = undefined;
  let result: { file: string; id?: string };
  if ((p.kind === "update" || p.kind === "duplicate") && as !== "new") {
    const u = updatedText(profileDir, p);
    validateEntry(u.after, u.file);
    atomicWrite(u.file, u.after);
    result = { file: rel(profileDir, u.file), id: p.entry!.id };
    as = "update";
  } else if (p.kind === "skills" || p.kind === "about") {
    const r = p.kind === "skills" ? skillsResult(profileDir, p) : aboutResult(profileDir, p);
    atomicWrite(r.file, r.after);
    result = { file: rel(profileDir, r.file) };
    as = undefined;
  } else {
    if (p.kind !== "new") {
      // Accepting an update/duplicate as new: take a fresh id.
      const profile = loadProfile(profileDir);
      const e = p.entry!;
      result = acceptNew(profileDir, { ...p, entry: { ...e, id: newEntryId(e.type, e, takenIds(profileDir, profile)) } });
      as = "new";
    } else {
      result = acceptNew(profileDir, p);
    }
  }
  archiveProposal(profileDir, p, { kind: "accepted", at, ...(as ? { as } : {}), file: result.file });
  return result;
}

export function rejectProposal(profileDir: string, p: Proposal, now: Date = new Date()): void {
  archiveProposal(profileDir, p, { kind: "rejected", at: now.toISOString() });
}
