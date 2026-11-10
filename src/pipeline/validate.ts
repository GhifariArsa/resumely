import type { z } from "zod";
import type { Entry, EntryType, Profile } from "../profile/schema";
import { hasToken, PROSE_OPENERS, scanClaims } from "../checks/fabrication";
import { unsupportedChars } from "../render/latex-escape";
import { CompanyResearch, CoverLetterContent, ParsedJob, ResumeContent, Review } from "./schemas";

export type ValidationResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

function formatPath(path: PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

export function schemaErrors(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((i) => {
    const p = formatPath(i.path);
    return p ? `${p}: ${i.message}` : i.message;
  });
}

export function validateParsedJob(raw: unknown): ValidationResult<ParsedJob> {
  const r = ParsedJob.safeParse(raw);
  return r.success ? { ok: true, value: r.data, warnings: [] } : { ok: false, errors: schemaErrors(r.error.issues) };
}

const KIND_TYPES: Record<ResumeContent["sections"][number]["kind"], EntryType[]> = {
  experience: ["experience"],
  projects: ["project"],
  education: ["education"],
  extras: ["award", "publication", "volunteering", "certification", "other"],
};

/** Lowercase, trim and collapse whitespace; `+`, `#` and `.` are kept so C, C# and C++ stay distinct. */
export function normaliseSkill(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function profileSkills(profile: Profile): Set<string> {
  const all = [...Object.values(profile.skills).flat(), ...profile.entries.flatMap((e) => e.skills)];
  return new Set(all.map(normaliseSkill));
}

/**
 * Flag numbers/proper nouns that `sources` don't support. Stretch never allows new numeric metrics:
 * only unsourced proper nouns downgrade from errors to warnings.
 */
function claimIssues(
  where: string,
  text: string,
  sources: string[],
  mode: "truthful" | "stretch",
  what: string,
  errors: string[],
  warnings: string[],
  scan: { openers?: readonly string[]; context?: string } = {},
): void {
  for (const tok of scanClaims(text, sources, scan)) {
    const isNumber = /^[$\d]/.test(tok);
    (mode === "truthful" || isNumber ? errors : warnings).push(`${where}: "${tok}" is not supported by ${what}`);
  }
}

function entrySources(e: Entry): string[] {
  const years = [e.start, e.end].flatMap((d) => (d && /^\d{4}/.test(d) ? [d.slice(0, 4)] : []));
  return [e.title, e.org ?? "", e.body, ...e.skills, ...e.tags, ...years];
}

export function validateResume(raw: unknown, profile: Profile, mode: "truthful" | "stretch"): ValidationResult<ResumeContent> {
  const r = ResumeContent.safeParse(raw);
  if (!r.success) return { ok: false, errors: schemaErrors(r.error.issues) };
  const value = r.data;
  const byId = new Map(profile.entries.map((e) => [e.id, e]));
  const known = new Set(byId.keys());
  const errors: string[] = [];
  const warnings: string[] = [];
  const profileSkillText = Object.values(profile.skills).flat();
  const context = [value.summary?.text ?? "", ...value.sections.flatMap((s) => s.items.flatMap((i) => i.bullets.map((b) => b.text)))].join("\n");
  /** Flag numbers/proper nouns the cited entries don't support: errors in truthful mode, warnings in stretch. */
  const checkClaims = (where: string, text: string, ids: string[], openers?: readonly string[]) => {
    const sources = [...profileSkillText, ...ids.flatMap((id) => (byId.has(id) ? entrySources(byId.get(id)!) : []))];
    claimIssues(where, text, sources, mode, "the cited entries", errors, warnings, { openers, context });
  };
  const checkIds = (where: string, ids: string[]) => {
    for (const id of ids) if (!known.has(id)) errors.push(`${where}: unknown entry id "${id}"`);
  };
  /** Reject text the template can't typeset, so it goes back to the agent instead of failing the compile. */
  const checkChars = (where: string, text: string) => {
    for (const c of unsupportedChars(text)) {
      errors.push(`${where}: unsupported character "${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
    }
  };

  if (value.summary) {
    checkIds("summary", value.summary.entry_ids);
    checkChars("summary", value.summary.text);
    checkClaims("summary", value.summary.text, value.summary.entry_ids, PROSE_OPENERS);
  }
  value.sections.forEach((s, i) => {
    checkChars(`sections[${i}].title`, s.title);
    s.items.forEach((item, j) => {
      const at = `sections[${i}].items[${j}]`;
      checkIds(at, [item.entry_id]);
      const entry = byId.get(item.entry_id);
      if (entry && !KIND_TYPES[s.kind].includes(entry.type)) {
        errors.push(`${at}: entry "${entry.id}" (${entry.type}) does not belong in a ${s.kind} section`);
      }
      item.bullets.forEach((b, k) => {
        const bat = `${at}.bullets[${k}]`;
        checkIds(bat, b.entry_ids);
        checkChars(bat, b.text);
        checkClaims(bat, b.text, b.entry_ids);
        if (!b.entry_ids.includes(item.entry_id)) errors.push(`${bat}: bullet must cite its item's entry "${item.entry_id}"`);
        if (mode === "truthful" && b.basis === "inferred") errors.push(`${bat}: inferred claims are not allowed in truthful mode`);
      });
    });
  });
  const skills = profileSkills(profile);
  value.skills.forEach((group, i) => {
    checkChars(`skills[${i}].category`, group.category);
    group.items.forEach((v, j) => {
      checkChars(`skills[${i}].items[${j}]`, v);
      const inBody = mode === "stretch" && profile.entries.some((e) => hasToken(e.body, v.trim(), true));
      if (!skills.has(normaliseSkill(v)) && !inBody) errors.push(`skills[${i}].items[${j}]: "${v}" is not in your profile`);
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value, warnings };
}

export function validateResearch(raw: unknown): ValidationResult<CompanyResearch> {
  const r = CompanyResearch.safeParse(raw);
  if (!r.success) return { ok: false, errors: schemaErrors(r.error.issues) };
  const value = r.data;
  const errors: string[] = [];
  const sources = new Set(value.sources);
  const seen = new Set<string>();
  const checkChars = (where: string, text: string) => {
    for (const c of unsupportedChars(text)) {
      errors.push(`${where}: unsupported character "${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
    }
  };
  checkChars("company", value.company);
  checkChars("summary", value.summary);
  value.facts.forEach((f, i) => {
    const at = `facts[${i}]`;
    if (seen.has(f.id)) errors.push(`${at}: duplicate fact id "${f.id}"`);
    seen.add(f.id);
    if (!/^https?:\/\//i.test(f.source_url)) errors.push(`${at}.source_url: must be an http(s) URL`);
    else if (!sources.has(f.source_url)) errors.push(`${at}.source_url: "${f.source_url}" is not listed in sources`);
    checkChars(`${at}.text`, f.text);
  });
  value.sources.forEach((u, i) => {
    if (!/^https?:\/\//i.test(u)) errors.push(`sources[${i}]: must be an http(s) URL`);
    checkChars(`sources[${i}]`, u);
  });
  return errors.length ? { ok: false, errors } : { ok: true, value, warnings: [] };
}

const GREETING = /^Dear (Hiring Team|\p{Lu}[\p{L}\p{N}.'-]*( \p{Lu}[\p{L}\p{N}.'-]*)*),$/u;
const CLOSING = /^(Sincerely|Best regards|Kind regards|Regards|Thank you|With thanks),$/;

export type CoverLetterOptions = {
  profile: Profile;
  research: CompanyResearch | null;
  banned: string[];
  mode: "truthful" | "stretch";
  jobText: string;
  job: ParsedJob;
};

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function validateCoverLetter(raw: unknown, o: CoverLetterOptions): ValidationResult<CoverLetterContent> {
  const r = CoverLetterContent.safeParse(raw);
  if (!r.success) return { ok: false, errors: schemaErrors(r.error.issues) };
  const value = r.data;
  const byId = new Map(o.profile.entries.map((e) => [e.id, e]));
  const facts = new Map((o.research?.facts ?? []).map((f) => [f.id, f]));
  const errors: string[] = [];
  const warnings: string[] = [];
  const chars = (where: string, text: string) => {
    for (const c of unsupportedChars(text)) {
      errors.push(`${where}: unsupported character "${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
    }
  };

  const g = value.greeting.match(GREETING);
  if (!g) errors.push(`greeting: must be "Dear Hiring Team," or "Dear <Name>," (got "${value.greeting}")`);
  else if (g[1] !== "Hiring Team") {
    const name = g[1]!;
    if (/\b(Team|Hiring|Manager|Recruiter)\b/i.test(name) || [o.job.company, o.research?.company ?? ""].some((c) => c && c.toLowerCase() === name.toLowerCase())) {
      errors.push(`greeting: "${name}" is not a person's name; use "Dear Hiring Team,"`);
    } else if (!hasToken(o.jobText, name, true)) {
      errors.push(`greeting: "${name}" does not appear in the job posting; use "Dear Hiring Team,"`);
    }
  }
  chars("greeting", value.greeting);
  chars("closing", value.closing);
  if (!CLOSING.test(value.closing)) errors.push('closing: use a simple sign-off like "Sincerely,"');

  const words = value.paragraphs.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0);
  if (words < 200 || words > 400) errors.push(`word count ${words} (must be 200–400)`);

  const banned = o.banned.map((b) => b.trim()).filter(Boolean);
  const context = value.paragraphs.map((p) => p.text).join("\n");
  value.paragraphs.forEach((p, i) => {
    const at = `paragraphs[${i}]`;
    for (const id of p.entry_ids) if (!byId.has(id)) errors.push(`${at}: unknown entry id "${id}"`);
    for (const id of p.company_fact_ids) if (!facts.has(id)) errors.push(`${at}: unknown company fact id "${id}"`);
    chars(at, p.text);
    for (const b of banned) {
      if (new RegExp(`(?<![\\p{L}\\p{N}])${escRe(b).replace(/\\? +/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(p.text)) errors.push(`${at}: banned phrase "${b}"`);
    }
    const sources = [
      ...p.entry_ids.flatMap((id) => (byId.has(id) ? entrySources(byId.get(id)!) : [])),
      ...p.company_fact_ids.flatMap((id) => (facts.has(id) ? [facts.get(id)!.text] : [])),
      o.research?.company ?? "",
      o.job.company,
      o.job.role,
    ];
    claimIssues(at, p.text, sources, o.mode, "the cited entries or company facts", errors, warnings, { openers: PROSE_OPENERS, context });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value, warnings };
}

/**
 * Schema plus the verdict rules the reviewer prompts state: `revise` needs a request, `pass` can't carry a
 * score of 3 or lower, and cover-letter reviews must score `voice`, say whether the letter is `templated`
 * and never pass a templated letter.
 */
export function validateReview(raw: unknown, kind: "resume" | "cover-letter"): ValidationResult<Review> {
  const r = Review.safeParse(raw);
  if (!r.success) return { ok: false, errors: schemaErrors(r.error.issues) };
  const value = r.data;
  const errors: string[] = [];
  if (value.verdict === "revise" && !value.requests.some((q) => q.trim())) errors.push('requests: "revise" needs at least one concrete request');
  if (kind === "cover-letter") {
    if (value.scores.voice === undefined) errors.push("scores.voice: required for a cover letter review");
    if (value.templated === undefined) errors.push("templated: required for a cover letter review");
    if (value.templated === true && value.verdict === "pass") errors.push('verdict: a templated letter must be "revise"');
  }
  const scored = Object.entries(value.scores).filter(([k]) => kind === "cover-letter" || k !== "voice");
  const low = scored.filter(([, n]) => n !== undefined && n <= 3).map(([k]) => k);
  if (value.verdict === "pass" && low.length) errors.push(`verdict: "pass" with ${low.join(", ")} scored 3 or lower; use "revise"`);
  return errors.length ? { ok: false, errors } : { ok: true, value, warnings: [] };
}
