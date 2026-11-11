import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { aboutPlaceholders } from "../commands/init";
import { UserError } from "../errors";
import { normaliseSkill } from "../pipeline/validate";
import { layout, requireDataRoot } from "../paths";
import { privateHeadingWarnings } from "./context";
import { inboxDir, listProposalsDetailed } from "./inbox";
import { listEntryFiles, loadAbout, loadSkills, parseEntryText } from "./load";
import type { Entry, EntryType, Profile } from "./schema";

export interface LintIssue {
  entry_id: string | null;
  file: string;
  severity: "error" | "warning";
  code: string;
  message: string;
}

const RESULT_WORDS = [
  "reduced", "increased", "improved", "cut", "grew", "saved", "doubled", "tripled", "halved", "launched", "shipped", "delivered", "won",
  "eliminated", "accelerated", "lowered", "raised", "boosted", "scaled", "achieved", "generated", "resulting", "so that", "leading to",
];
const RESULT_RE = new RegExp(`\\b(${RESULT_WORDS.join("|")})\\b`, "i");
const OUTCOME_TYPES: EntryType[] = ["experience", "project", "volunteering"];
const CONTEXT_HEADING = /context|stor(y|ies)|notes/i;

const month = (d: Date) => d.toISOString().slice(0, 7);

/** Date-field checks shared with the editor UI. Months compare as `YYYY-MM` strings. */
export function dateIssues(e: { type: EntryType; start?: string; end?: string }, now: Date = new Date()): Omit<LintIssue, "entry_id" | "file">[] {
  const cur = month(now);
  const out: Omit<LintIssue, "entry_id" | "file">[] = [];
  if ((e.type === "experience" || e.type === "education") && !e.start) {
    out.push({ severity: "warning", code: "missing-dates", message: "no start date" });
  }
  if (e.start && e.end && e.end !== "present" && e.end < e.start) {
    out.push({ severity: "error", code: "end-before-start", message: `end ${e.end} is before start ${e.start}` });
  }
  if (e.start && e.start > cur) out.push({ severity: "error", code: "future-start", message: `start ${e.start} is in the future` });
  if (e.end && e.end !== "present" && e.end > cur && e.type !== "education") {
    out.push({ severity: "warning", code: "future-end", message: `end ${e.end} is in the future` });
  }
  return out;
}

function outcomeIssues(e: Entry): string[] {
  if (!OUTCOME_TYPES.includes(e.type)) return [];
  const out: string[] = [];
  let skip = false;
  for (const line of e.body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)/);
    if (h) {
      skip = CONTEXT_HEADING.test(h[1]!);
      continue;
    }
    const m = line.match(/^\s*[-*]\s+(.+)/);
    if (!m || skip) continue;
    const text = m[1]!;
    if (!/\d/.test(text) && !RESULT_RE.test(text)) out.push(`no measurable outcome: "${[...text].slice(0, 60).join("")}"`);
  }
  return out;
}

function citedIds(root: string): Set<string> | null {
  const apps = layout(root).applications;
  if (!existsSync(apps)) return null;
  let found = false;
  const ids = new Set<string>();
  const dirs = (d: string) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name) : []);
  for (const app of dirs(apps)) {
    for (const kind of ["resume", "cover-letter"]) {
      for (const v of dirs(join(apps, app, kind)).filter((n) => /^v/.test(n))) {
        const f = join(apps, app, kind, v, "trace.json");
        if (!existsSync(f)) continue;
        try {
          const t = JSON.parse(readFileSync(f, "utf8"));
          if (!Array.isArray(t)) continue;
          found = true;
          for (const row of t) if (row && Array.isArray(row.entry_ids)) for (const id of row.entry_ids) ids.add(String(id));
        } catch {
          /* unreadable trace: ignored */
        }
      }
    }
  }
  return found ? ids : null;
}

/** Deterministic profile checks. `root` is the data root; profile content problems never throw. */
export function lintProfile(root: string, opts: { now?: Date } = {}): LintIssue[] {
  requireDataRoot(root);
  const now = opts.now ?? new Date();
  const pdir = layout(root).profile;
  const rel = (f: string) => relative(root, f).split("\\").join("/");
  const issues: LintIssue[] = [];
  const add = (entry_id: string | null, file: string, severity: LintIssue["severity"], code: string, message: string) =>
    issues.push({ entry_id, file, severity, code, message });

  let aboutBody = "";
  try {
    const { about } = loadAbout(pdir);
    aboutBody = about.body;
    const placeholders = aboutPlaceholders(about);
    if (placeholders.length) {
      add(null, rel(join(pdir, "about.md")), "warning", "placeholder-about", `still has the placeholder ${placeholders.join(", ")} from resumely init`);
    }
  } catch (e) {
    add(null, rel(join(pdir, "about.md")), "error", "parse-error", e instanceof UserError ? e.message : String(e));
  }

  const entries: Entry[] = [];
  const firstFile = new Map<string, string>();
  for (const { file, dirType } of listEntryFiles(pdir)) {
    const text = readFileSync(file, "utf8");
    let entry: Entry;
    try {
      entry = parseEntryText(text, rel(file), dirType);
    } catch (e) {
      add(text.match(/^id:\s*(\S+)/m)?.[1] ?? null, rel(file), "error", "parse-error", e instanceof UserError ? e.message : String(e));
      continue;
    }
    const prev = firstFile.get(entry.id);
    if (prev) {
      add(entry.id, rel(file), "error", "duplicate-id", `Duplicate entry id "${entry.id}", first used in ${prev}`);
      continue;
    }
    firstFile.set(entry.id, rel(file));
    entries.push(entry);
  }

  for (const e of entries) {
    for (const d of dateIssues(e, now)) add(e.id, e.file, d.severity, d.code, d.message);
    for (const m of outcomeIssues(e)) add(e.id, e.file, "warning", "outcome-less-bullet", m);
    for (const w of privateHeadingWarnings({ about: { body: "" }, entries: [e] } as unknown as Profile)) add(e.id, e.file, "warning", "private-heading", w);
  }
  for (const w of privateHeadingWarnings({ about: { body: aboutBody }, entries: [] } as unknown as Profile)) {
    add(null, rel(join(pdir, "about.md")), "warning", "private-heading", w);
  }

  try {
    const seen = new Map<string, string>();
    for (const [cat, items] of Object.entries(loadSkills(pdir))) {
      for (const item of items) {
        const key = normaliseSkill(item);
        const prev = seen.get(key);
        if (prev !== undefined) add(null, "profile/skills.yaml", "warning", "duplicate-skill", `"${item}" appears in both ${prev} and ${cat}`);
        else seen.set(key, cat);
      }
    }
  } catch (e) {
    add(null, rel(join(pdir, "skills.yaml")), "error", "parse-error", e instanceof UserError ? e.message : String(e));
  }

  const cited = citedIds(root);
  if (cited) for (const e of entries) if (!cited.has(e.id)) add(e.id, e.file, "warning", "unused-entry", "not cited by any resume or cover letter");

  if (existsSync(inboxDir(pdir))) {
    const { proposals, broken } = listProposalsDetailed(pdir);
    const n = proposals.length + broken.length;
    if (n > 0) add(null, "profile/.inbox", "warning", "pending-proposals", `${n} proposal${n === 1 ? "" : "s"} awaiting review`);
  }

  const rank = (i: LintIssue) => (i.severity === "error" ? 0 : 1);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return issues.sort((a, b) => rank(a) - rank(b) || cmp(a.file, b.file) || cmp(a.code, b.code));
}

export function formatLint(issues: LintIssue[]): string {
  if (issues.length === 0) return "profile looks good";
  const lines = issues.map((i) => `${i.severity.padEnd(7)} ${i.entry_id ?? "-"} ${i.file}  ${i.code}: ${i.message}`);
  const errors = issues.filter((i) => i.severity === "error").length;
  lines.push(`${errors} errors, ${issues.length - errors} warnings`);
  return lines.join("\n");
}
