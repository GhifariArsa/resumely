import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ZodType } from "zod";
import { latestVersion, nextVersionDir, sendReadyName, type Application } from "../application/store";
import type { HardFacts } from "../checks/facts";
import { UserError } from "../errors";
import type { About } from "../profile/schema";
import type { DocumentKind } from "./refine";
import type { EntryLike, ResolvedResume } from "./resolve";
import type { CompanyResearch, CoverLetterContent, ResumeContent, Review } from "./schemas";
import { schemaErrors } from "./validate";

export const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** A version is ready to send when an ATS can read it and it fits its page target. */
export const isReady = (f: HardFacts): boolean => f.ats.status !== "failed" && !f.overflow;

/** Why `isReady` is false, for warnings. */
export function notReadyReasons(f: HardFacts): string[] {
  const out: string[] = [];
  if (f.ats.status === "failed") out.push(`ATS check failed: ${f.ats.problems.join("; ")}`);
  if (f.overflow) out.push(`${f.pages} pages (target ${f.target_pages})`);
  return out;
}

/**
 * Allocate the next `<kind>/vN` dir and write `files`, the send-ready PDF and `meta.json`. Call it last:
 * a version dir only exists once everything it holds has been produced.
 */
export function saveVersion(o: {
  app: Application;
  kind: DocumentKind;
  about: About;
  files: Record<string, string | Uint8Array>;
  pdf: Uint8Array;
  /** The send-ready name pattern (config `filename`). */
  filename: string;
  meta: object;
}): { dir: string; version: number; pdfPath: string } {
  const { dir, version } = nextVersionDir(o.app, o.kind);
  const pdfName = sendReadyName(o.filename, o.about, o.kind === "resume" ? "Resume" : "Cover_Letter", o.app.meta.company);
  for (const [name, content] of Object.entries(o.files)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, pdfName), o.pdf);
  writeFileSync(join(dir, "meta.json"), json(o.meta));
  return { dir, version, pdfPath: join(dir, pdfName) };
}

/** `meta.json` fields shared by every saved version. */
export function versionMeta(o: {
  mode: "truthful" | "stretch";
  facts: HardFacts;
  review: Review | null;
  reviewedFinal: boolean;
  rounds: number;
  research: "used" | "skipped" | "failed";
  harness?: string;
  run?: string;
  template: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    mode: o.mode,
    ready: isReady(o.facts),
    reviewed_final: o.reviewedFinal,
    rounds: o.rounds,
    research: o.research,
    review_verdict: o.review?.verdict ?? null,
    harness: o.harness,
    run: o.run,
    template: o.template,
    pages: o.facts.pages,
    target_pages: o.facts.target_pages,
    ...o.extra,
    created: new Date().toISOString(),
  };
}

export function resumeTrace(r: ResolvedResume) {
  const out: { section: string; item: string; bullet: number; text: string; entry_ids: string[]; basis: string }[] = [];
  if (r.summary) out.push({ section: "summary", item: "", bullet: 0, text: r.summary.text, entry_ids: r.summary.entry_ids, basis: "direct" });
  for (const s of r.sections) {
    for (const it of s.items) {
      it.bullets.forEach((b, i) => out.push({ section: s.title, item: it.heading, bullet: i, text: b.text, entry_ids: b.entry_ids, basis: b.basis }));
    }
  }
  return out;
}

export function coverTrace(c: CoverLetterContent) {
  return c.paragraphs.map((p, i) => ({ paragraph: i, text: p.text, entry_ids: p.entry_ids, company_fact_ids: p.company_fact_ids }));
}

export function resumeEntryIds(c: ResumeContent): Set<string> {
  const ids = new Set<string>(c.summary?.entry_ids ?? []);
  for (const s of c.sections) for (const it of s.items) { ids.add(it.entry_id); for (const b of it.bullets) b.entry_ids.forEach((i) => ids.add(i)); }
  return ids;
}

export const coverEntryIds = (c: CoverLetterContent): Set<string> => new Set(c.paragraphs.flatMap((p) => p.entry_ids));

/** The cited entries, frozen with the version. */
export const snapshotOf = <E extends EntryLike>(ids: Set<string>, entries: E[]): E[] => entries.filter((e) => ids.has(e.id));

/** The company facts the letter cites. */
export function citedFacts(c: CoverLetterContent, research: CompanyResearch | null): CompanyResearch["facts"] {
  const ids = new Set(c.paragraphs.flatMap((p) => p.company_fact_ids));
  return (research?.facts ?? []).filter((f) => ids.has(f.id));
}

/** Read and schema-check a JSON file the user may have edited by hand. */
export function readJsonFile<T>(path: string, schema: ZodType<T>): T {
  const name = basename(path);
  if (!existsSync(path)) throw new UserError(`Missing ${path}`, `render needs the version's ${name}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UserError(`Invalid ${name} at ${path}`, (e as Error).message);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new UserError(`Invalid ${name} at ${path}`, schemaErrors(r.error.issues).join("; "));
  return r.data;
}

export function pickVersion(app: Application, kind: DocumentKind, version?: number): { dir: string; version: number } {
  const label = kind === "resume" ? "resume" : "cover letter";
  if (version === undefined) {
    const latest = latestVersion(app, kind);
    if (!latest) throw new UserError(`${app.slug} has no ${label} versions yet`, "Run: resumely apply");
    return latest;
  }
  const dir = join(app.dir, kind, `v${version}`);
  if (!existsSync(dir)) throw new UserError(`${app.slug} has no ${label} v${version}`);
  return { dir, version };
}

/** Parsed JSON at `path`, or `fallback` when missing or unreadable. */
export function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** The send-ready PDF in a version dir. */
export function pdfIn(dir: string): string {
  const f = readdirSync(dir).find((n) => n.endsWith(".pdf"));
  if (!f) throw new UserError(`No PDF in ${dir}`);
  return join(dir, f);
}

/** Why a saved version is not ready ("see meta.json" when the checks are unreadable). */
export function savedNotReadyReasons(dir: string): string {
  const checks = readJsonOr<HardFacts | null>(join(dir, "checks.json"), null);
  const reasons = checks?.ats ? notReadyReasons(checks) : [];
  return reasons.join("; ") || "see meta.json";
}
