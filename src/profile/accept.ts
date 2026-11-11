import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument, stringify } from "yaml";
import { UserError } from "../errors";
import { normaliseSkill } from "../pipeline/validate";
import { unifiedDiff } from "./diff";
import { archiveProposal, findLikelyDuplicate, ID_PREFIX, newEntryId, takenIds } from "./inbox";
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

const PRIVATE_HEADING = /^##\s+Private\b.*$/i;

type Section = { key: string | null; private: boolean; text: string };

/** A body as its preamble (prose before the first `## ` heading, key null) and its `## ` sections, keyed by heading. */
function sections(body: string): Section[] {
  const out: { key: string | null; private: boolean; lines: string[] }[] = [{ key: null, private: false, lines: [] }];
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*?)\s*$/);
    if (h) out.push({ key: h[1]!.replace(/:$/, "").toLowerCase(), private: PRIVATE_HEADING.test(line), lines: [line] });
    else out.at(-1)!.lines.push(line);
  }
  return out.map((s) => ({ key: s.key, private: s.private, text: s.lines.join("\n").trim() }));
}

const joinSections = (secs: Section[]) => secs.map((s) => s.text).filter(Boolean).join("\n\n");

/** `body` with blank lines between sections normalised, for comparing with a `mergeBody` result. */
export function normaliseBody(body: string): string {
  return joinSections(sections(body));
}

/** Headings an entry proposal speaks for: rendered from its bullets/context, or (after a review edit) its whole body. */
const ENTRY_OWNED = ["highlights", "context"];

/**
 * Live sections with a proposal's merged in: the proposal's preamble replaces the live preamble; each proposal `## `
 * section replaces the live section with the same heading in place, or is appended; live sections in `owned` that the
 * proposal lacks are dropped; every other live section, and every `## Private` section, is kept verbatim.
 */
function mergeSections(live: Section[], proposed: Section[], owned: string[]): string {
  const [pre, ...prop] = proposed.filter((s) => !s.private);
  const byKey = new Map<string, Section>();
  for (const s of prop) if (!byKey.has(s.key!)) byKey.set(s.key!, s);
  const used = new Set<Section>();
  const out: Section[] = [pre!];
  for (const s of live.slice(1)) {
    const mine = s.private ? undefined : byKey.get(s.key!);
    if (mine) {
      if (!used.has(mine)) out.push(mine);
      used.add(mine);
    } else if (s.private || !owned.includes(s.key!)) {
      out.push(s);
    }
  }
  for (const s of prop) if (!used.has(s)) out.push(s);
  return joinSections(out);
}

/** `liveBody` with `proposed` merged in (see `mergeSections`); used for the about.md summary. */
export function mergeBody(liveBody: string, proposed: string, owned: string[] = []): string {
  return mergeSections(sections(liveBody), sections(proposed), owned);
}

/**
 * The live entry body with an update proposal merged in. A proposal without bullets (or context) leaves the live
 * Highlights (or Context) alone; an edited body speaks for both. The live preamble stays unless the proposal has its
 * own; when the live file has no `## Highlights`, its preamble holds the highlights and is replaced in place by them.
 */
function mergeEntryBody(liveBody: string, e: ProposedEntry): string {
  const proposed = sections(renderBody(e));
  const owned = e.body !== undefined ? ENTRY_OWNED : ENTRY_OWNED.filter((k) => proposed.some((s) => s.key === k));
  let live = sections(liveBody);
  if (!proposed[0]!.text) {
    const [livePre, ...rest] = live;
    if (live.some((s) => s.key === "highlights")) proposed[0] = livePre!;
    else if (livePre!.text) live = [{ key: null, private: false, text: "" }, { ...livePre!, key: "highlights" }, ...rest];
  }
  return mergeSections(live, proposed, owned);
}

/** Merge `extra` private sections (from a review edit) after the body, skipping any the body already has verbatim. */
function withPrivate(body: string, extra?: string): string {
  const have = new Set(sections(body).filter((s) => s.private).map((s) => s.text));
  const add = extra ? sections(extra).filter((s) => s.private && !have.has(s.text)) : [];
  return joinSections([{ key: null, private: false, text: body }, ...add]);
}

/** The text after an entry file's frontmatter. */
export function bodyOf(fileText: string): string {
  return fileText.replace(FM_RE, "");
}

/** Raw `## Private…` sections (heading through the line before the next `## ` or EOF), joined. */
export function privateSections(fileText: string): string {
  const out: string[] = [];
  let inPrivate = false;
  for (const line of fileText.split(/\r?\n/)) {
    if (PRIVATE_HEADING.test(line)) inPrivate = true;
    else if (inPrivate && /^##\s/.test(line)) inPrivate = false;
    if (inPrivate) out.push(line);
  }
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out.length ? out.join("\n") + "\n" : "";
}

/**
 * Whether an update proposal sets frontmatter key `k`. An omitted key keeps the live value; so does an empty
 * skills/tags array, which is what a proposal that does not list them carries (they default to []).
 */
function setsKey(e: ProposedEntry, k: (typeof FM_KEYS)[number]): boolean {
  const v = e[k];
  return v !== undefined && !(Array.isArray(v) && v.length === 0);
}

/** True when accepting `e` would not change the live entry. */
export function sameAsLive(e: ProposedEntry, live: Entry): boolean {
  for (const k of FM_KEYS) if (k !== "id" && setsKey(e, k) && !isDeepStrictEqual(e[k], live[k])) return false;
  const liveBody = normaliseBody(live.body);
  if (mergeEntryBody(live.body, e) === liveBody) return true;
  return e.body === undefined && e.bullets.length === 0 && normaliseBody(e.context) === liveBody;
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

function updatedText(profileDir: string, p: Proposal, privateText?: string): { file: string; before: string; after: string } {
  const { entry, text } = liveFile(profileDir, p);
  const e = p.entry!;
  const m = text.match(FM_RE);
  if (!m) throw new UserError(`${entry.file}: missing YAML frontmatter`, "Start the file with a --- block");
  // Edit the live frontmatter in place so unknown keys and comments survive.
  const doc = parseDocument(m[1]!);
  // Only the keys the proposal sets change; the rest keep their live values.
  for (const k of FM_KEYS) if (setsKey(e, k)) doc.set(k, e[k]);
  // Only the sections the proposal speaks for change; other live sections and `## Private` stay as they are.
  const body = withPrivate(mergeEntryBody(text.slice(m[0].length), e), privateText);
  // No padding inside `[a, b]`, so keys the update leaves alone are written back as they were.
  const after = `---\n${doc.toString({ flowCollectionPadding: false }).trimEnd()}\n---\n` + (body ? `\n${body}\n` : "");
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
  // The summary is the prose before the first `## ` heading; every section, private or not, is kept.
  if (summary !== undefined) body = `\n${mergeBody(body, summary)}\n`;
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
  if (doc.errors.length) throw new UserError(`${file}: invalid YAML (${doc.errors[0]!.message.split("\n")[0]})`, "Fix skills.yaml, then accept again");
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

/** What accepting `p` would write. `privateText` is `## Private` text from a review edit (never stored in the inbox). */
export function previewProposal(profileDir: string, p: Proposal, privateText?: string): string {
  const diff = (r: { file: string; before: string; after: string }) =>
    unifiedDiff(r.before, r.after, { from: `a/profile/${rel(profileDir, r.file)}`, to: `b/profile/${rel(profileDir, r.file)}` });
  switch (p.kind) {
    case "new":
      return newEntryText(p.entry!, privateText);
    case "update":
    case "duplicate":
      return diff(updatedText(profileDir, p, privateText));
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

function newEntryText(e: ProposedEntry, privateText?: string): string {
  const md = entryMarkdown(e);
  const priv = withPrivate("", privateText);
  return priv ? `${md}\n${priv}\n` : md;
}

/** A live entry that a `new` proposal likely duplicates (checked against the profile as it is now), else null. */
export function liveDuplicate(profileDir: string, p: Proposal): Entry | null {
  return p.kind === "new" && p.entry ? findLikelyDuplicate(p.entry, loadProfile(profileDir).entries) : null;
}

/** `p` (a `new` proposal) as a possible duplicate of live entry `id`: what `--as update` would apply. */
export function asDuplicateOf(p: Proposal, id: string): Proposal {
  return { ...p, kind: "duplicate", target_id: id, entry: { ...p.entry!, id } };
}

function acceptNew(profileDir: string, p: Proposal, privateText?: string): { file: string; id: string } {
  let entry = p.entry!;
  const profile = loadProfile(profileDir);
  const taken = takenIds(profileDir, profile);
  // The proposal's own id is in `takenIds` when it is still pending, so only reassign on a real clash.
  const live = new Set(profile.entries.map((x) => x.id));
  if (live.has(entry.id)) entry = { ...entry, id: newEntryId(entry.type, entry, taken) };
  const text = newEntryText(entry, privateText);
  const abs = entryFileFor(profileDir, entry);
  validateEntry(text, abs);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, { flag: "wx" });
  return { file: rel(profileDir, abs), id: entry.id };
}

/**
 * Write an accepted proposal into the live profile and archive it. `as` decides a possible duplicate (a `duplicate`
 * proposal, or a `new` one that resembles a live entry now). `privateText` is `## Private` text typed in a review edit.
 */
export function acceptProposal(
  profileDir: string,
  p: Proposal,
  o: { as?: "update" | "new"; now?: Date; privateText?: string } = {},
): { file: string; id?: string } {
  const at = (o.now ?? new Date()).toISOString();
  let as = o.as;
  let target = p;
  if (p.kind === "new") {
    // Re-checked against the live profile: an earlier accept may have added the same role.
    const dup = liveDuplicate(profileDir, p);
    if (dup) target = asDuplicateOf(p, dup.id);
    else as = undefined;
  }
  if (target.kind === "duplicate" && !as) {
    throw new UserError(`${p.pid} is a possible duplicate of ${target.target_id}`, `Choose: --as update (replace ${target.target_id}) or --as new (keep both)`);
  }
  let result: { file: string; id?: string };
  if ((target.kind === "update" || target.kind === "duplicate") && as !== "new") {
    const u = updatedText(profileDir, target, o.privateText);
    validateEntry(u.after, u.file);
    atomicWrite(u.file, u.after);
    result = { file: rel(profileDir, u.file), id: target.entry!.id };
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
      result = acceptNew(profileDir, { ...p, entry: { ...e, id: newEntryId(e.type, e, takenIds(profileDir, profile)) } }, o.privateText);
      as = "new";
    } else {
      result = acceptNew(profileDir, p, o.privateText);
    }
  }
  archiveProposal(profileDir, p, { kind: "accepted", at, ...(as ? { as } : {}), file: result.file });
  return result;
}

export function rejectProposal(profileDir: string, p: Proposal, now: Date = new Date()): void {
  archiveProposal(profileDir, p, { kind: "rejected", at: now.toISOString() });
}
