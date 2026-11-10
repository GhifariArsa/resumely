import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { findApplication, type Application } from "../application/store";
import { openFile } from "../commands/open";
import { loadConfig } from "../config";
import { layout, requireDataRoot } from "../paths";
import { loadAbout } from "../profile/load";
import { builtinTemplatesDir, findTemplate, formatLetterDate } from "../render/render";
import { produceCover, produceResume, profileTextOf } from "./documents";
import type { DocumentKind, Produced } from "./refine";
import { EntrySnapshot, resolveResume } from "./resolve";
import { CompanyResearch, CoverLetterContent, ParsedJob, ResumeContent, type Review } from "./schemas";
import { coverTrace, isReady, json, notReadyReasons, pickVersion, readJsonFile, resumeTrace, saveVersion, versionMeta } from "./version";

const LooseEntries = z.array(z.object({ title: z.string().optional(), org: z.string().optional(), body: z.string().optional(), skills: z.array(z.string()).optional() }).loose());

function readOptional<T>(path: string, parse: (raw: unknown) => T | null): T | null {
  if (!existsSync(path)) return null;
  try {
    return parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Re-render a saved version with a template (no agent call, no review): a new version with recomputed hard
 * facts and `ready`, the frozen snapshots copied verbatim and the source version's review carried over.
 */
export async function renderApplication(opts: {
  root: string;
  query: string;
  template: string;
  version?: number;
  kind?: DocumentKind;
  open?: boolean;
  onProgress?: (m: string) => void;
}): Promise<{ app: Application; pdfPath: string; pages: number; version: number; ready: boolean; warnings: string[] }> {
  requireDataRoot(opts.root);
  const l = layout(opts.root);
  const config = loadConfig(opts.root);
  const kind = opts.kind ?? "resume";
  const app = findApplication(l.applications, opts.query);
  const src = pickVersion(app, kind, opts.version);
  const template = findTemplate(opts.template, [builtinTemplatesDir(), l.templates]);
  const { about } = loadAbout(l.profile);
  const at = (f: string) => join(src.dir, f);
  const entries = readJsonFile(at("entries.snapshot.json"), EntrySnapshot);
  const old = readOptional(at("meta.json"), (raw) => (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null)) ?? {};
  const review = readOptional(at("review.json"), (raw) => raw as Review);
  const job = readOptional(join(app.dir, "job", "parsed.json"), (raw) => ParsedJob.safeParse(raw).data ?? null);
  const appJob = { company: app.meta.company, role: app.meta.role };
  const m = {
    keywords: job?.keywords ?? [],
    profileText: profileTextOf(readJsonFile(at("entries.snapshot.json"), LooseEntries)),
    fabricationWarnings: [],
  };
  const files: Record<string, string> = {
    "entries.snapshot.json": readFileSync(at("entries.snapshot.json"), "utf8"),
    ...(review ? { "review.json": readFileSync(at("review.json"), "utf8") } : {}),
  };

  const extra: Record<string, unknown> = { rendered_from: src.version };
  opts.onProgress?.("compiling…");
  let produced: Produced;
  if (kind === "resume") {
    const content = readJsonFile(at("resume.json"), ResumeContent);
    const targetPages = typeof old.target_pages === "number" ? old.target_pages : config.pages;
    produced = await produceResume({ ...m, template, about, content, entries, job: appJob, targetPages });
    Object.assign(files, {
      "resume.json": json(content),
      "resume.tex": produced.tex,
      "trace.json": json(resumeTrace(resolveResume(content, entries))),
    });
  } else {
    const letter = readJsonFile(at("cover-letter.json"), CoverLetterContent);
    readJsonFile(at("company.snapshot.json"), CompanyResearch.shape.facts.element.array());
    // Keep the letter's original date: a template swap must not redate it.
    const date = typeof old.date === "string" ? old.date : formatLetterDate(new Date());
    extra.date = date;
    produced = await produceCover({ ...m, template, about, letter, job: appJob, date });
    Object.assign(files, {
      "cover-letter.json": json(letter),
      "cover-letter.tex": produced.tex,
      "trace.json": json(coverTrace(letter)),
      "company.snapshot.json": readFileSync(at("company.snapshot.json"), "utf8"),
    });
  }
  const facts = produced.facts;
  files["checks.json"] = json({ ...facts, warnings: [] });
  const keep = (k: string) => old[k];
  const v = saveVersion({
    app, kind, about, files, pdf: produced.pdf, filename: config.filename,
    meta: versionMeta({
      mode: keep("mode") === "stretch" ? "stretch" : "truthful",
      facts, review,
      reviewedFinal: false,
      rounds: typeof keep("rounds") === "number" ? (keep("rounds") as number) : 0,
      research: (["used", "none_found", "skipped", "failed"] as const).find((s) => s === keep("research")) ?? "skipped",
      harness: keep("harness") as string | undefined,
      run: keep("run") as string | undefined,
      template: template.id,
      extra,
    }),
  });
  const label = kind === "resume" ? "resume" : "cover letter";
  const warnings = notReadyReasons(facts).map((w) => `${label} not ready: ${w}`);
  if (facts.ats.status === "skipped" && facts.ats.hint) warnings.push(`ATS check skipped: ${facts.ats.hint}`);
  if (opts.open !== false) await openFile(v.pdfPath);
  return { app, pdfPath: v.pdfPath, pages: produced.pages, version: v.version, ready: isReady(facts), warnings };
}
