import type { z } from "zod";
import type { Profile } from "../profile/schema";
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

export function validateResume(raw: unknown, profile: Profile, mode: "truthful"): ValidationResult<ResumeContent> {
  const r = ResumeContent.safeParse(raw);
  if (!r.success) return { ok: false, errors: schemaErrors(r.error.issues) };
  const value = r.data;
  const known = new Set(profile.entries.map((e) => e.id));
  const errors: string[] = [];
  const checkIds = (where: string, ids: string[]) => {
    for (const id of ids) if (!known.has(id)) errors.push(`${where}: unknown entry id "${id}"`);
  };

  if (value.summary) checkIds("summary", value.summary.entry_ids);
  value.sections.forEach((s, i) => {
    s.items.forEach((item, j) => {
      const at = `sections[${i}].items[${j}]`;
      checkIds(at, [item.entry_id]);
      item.bullets.forEach((b, k) => {
        const bat = `${at}.bullets[${k}]`;
        checkIds(bat, b.entry_ids);
        if (mode === "truthful" && b.basis === "inferred") errors.push(`${bat}: inferred claims are not allowed in truthful mode`);
      });
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
