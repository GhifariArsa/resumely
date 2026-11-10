import type { z } from "zod";
import type { EntryType, Profile } from "../profile/schema";
import { unsupportedChars } from "../render/latex-escape";
import { ParsedJob, ResumeContent } from "./schemas";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function formatPath(path: PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

function schemaErrors(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((i) => {
    const p = formatPath(i.path);
    return p ? `${p}: ${i.message}` : i.message;
  });
}

export function validateParsedJob(raw: unknown): ValidationResult<ParsedJob> {
  const r = ParsedJob.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: schemaErrors(r.error.issues) };
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

export function validateResume(raw: unknown, profile: Profile, mode: "truthful"): ValidationResult<ResumeContent> {
  const r = ResumeContent.safeParse(raw);
  if (!r.success) return { ok: false, errors: schemaErrors(r.error.issues) };
  const value = r.data;
  const byId = new Map(profile.entries.map((e) => [e.id, e]));
  const known = new Set(byId.keys());
  const errors: string[] = [];
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
      if (!skills.has(normaliseSkill(v))) errors.push(`skills[${i}].items[${j}]: "${v}" is not in your profile`);
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
