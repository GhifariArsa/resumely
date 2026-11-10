import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApplication, findDuplicate, latestVersion, saveExtraRaw } from "../application/store";
import type { Application } from "../application/store";
import { keywordCoverage } from "../checks/keywords";
import { openFile } from "../commands/open";
import { loadConfig } from "../config";
import { UserError } from "../errors";
import { resolveAdapter } from "../harness/adapter";
import type { JobSource } from "../job/intake";
import { layout, requireDataRoot } from "../paths";
import { buildAgentPayload } from "../profile/context";
import { loadProfile, loadVoiceSamples } from "../profile/load";
import { builtinTemplatesDir, findTemplate, formatLetterDate } from "../render/render";
import { DEFAULT_BANNED } from "./banned";
import { coverDocument, inferredClaims, profileTextOf, resumeDocument, type Doc, type DocContext } from "./documents";
import { refine, type DocumentKind, type RefineResult } from "./refine";
import { runResearch, type ResearchStatus } from "./research";
import { jsonSchemaFor, type CompanyResearch, type ParsedJob, type ResumeContent, type Review } from "./schemas";
import { validateParsedJob } from "./validate";
import { citedFacts, coverEntryIds, coverTrace, json, notReadyReasons, pdfIn, pickVersion, readJsonOr, resumeEntryIds, resumeTrace, saveVersion, snapshotOf, versionMeta, isReady } from "./version";
import { resolveResume } from "./resolve";
import { createRunWorkspace, newRunId, runAgentStep } from "./workspace";

export { renderApplication } from "./rerender";

export type DocResult = { pdfPath: string; version: number; pages: number; ready: boolean; review: Review | null };

export type ApplyResult = {
  app: Application;
  resume?: DocResult;
  cover?: DocResult;
  /** Documents that could not be produced; `hint` names the failing step's workspace when known. */
  failures: { kind: DocumentKind; message: string; hint?: string }[];
  gaps: ResumeContent["gaps"];
  /** Stretch-mode bullets the user should check. */
  inferred: { text: string; entry_ids: string[] }[];
  warnings: string[];
};

export type ApplyOptions = {
  root: string;
  input: JobSource;
  harness?: string;
  template?: string;
  open?: boolean;
  mode?: "truthful" | "stretch";
  pages?: number;
  cover?: boolean;
  research?: boolean;
  review?: boolean;
  /** After the parse: resolve false to stop (the application is kept). */
  pause?: (job: ParsedJob, likelyGaps: string[]) => Promise<boolean>;
  /** Add versions to this application unconditionally (skips duplicate detection and creation). */
  into?: Application;
  onDuplicate?: (existing: Application) => Promise<"existing" | "new" | "abort">;
  onProgress?: (m: string) => void;
};

const TAG: Record<DocumentKind, string> = { resume: "resume", "cover-letter": "cover" };

/** ISO 639-1 "en" (also "en-US" etc.), or the word itself in case the agent spells it out. */
const isEnglish = (lang: string) => /^(en([-_].*)?|english)$/i.test(lang.trim());

function loadParsed(app: Application): ParsedJob | null {
  try {
    const r = validateParsedJob(JSON.parse(readFileSync(join(app.dir, "job", "parsed.json"), "utf8")));
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

/** Parse the posting and find or create its application, asking `onDuplicate` about an earlier one. */
async function intake(o: ApplyOptions, appsDir: string, parse: () => Promise<ParsedJob>): Promise<{ app: Application; job: ParsedJob }> {
  const decide = async (existing: Application): Promise<Application | null> => {
    if (!o.onDuplicate) throw new UserError(`Already applied: ${existing.slug}`, `Use --into ${existing.slug} to add a version, or --new for a separate application`);
    const choice = await o.onDuplicate(existing);
    if (choice === "abort") throw new UserError("Aborted");
    return choice === "existing" ? existing : null;
  };
  let asked = false;
  let reuse: Application | null = null;
  const into = o.into;
  const guard = (dup: Application): Application => {
    if (dup.slug !== into!.slug) throw new UserError(`--into ${into!.slug} doesn't match the earlier application ${dup.slug}`, `Use --into ${dup.slug}, or --new for a separate application`);
    return into!;
  };
  const byUrl = o.input.url ? findDuplicate(appsDir, { url: o.input.url, company: "", role: "" }) : null;
  if (byUrl) {
    asked = true;
    reuse = into ? guard(byUrl) : await decide(byUrl);
  }
  if (into && !reuse) reuse = into;
  const job = (reuse && loadParsed(reuse)) || (await parse());
  if (!asked && !reuse) {
    const byRole = findDuplicate(appsDir, { company: job.company, role: job.role });
    if (byRole) reuse = await decide(byRole);
  }
  if (!reuse) return { app: createApplication(appsDir, job, o.input), job };
  saveExtraRaw(reuse, o.input.text);
  return { app: reuse, job: loadParsed(reuse) ?? job };
}

export async function applyJob(opts: ApplyOptions): Promise<ApplyResult> {
  const { root, onProgress } = opts;
  requireDataRoot(root);
  const l = layout(root);
  const config = loadConfig(root);
  const profile = loadProfile(l.profile);
  if (profile.entries.length === 0 || profile.about.name === "Your Name") {
    throw new UserError("Your profile is empty", `Add entries under ${l.profile} (see README) — check with: resumely profile show`);
  }
  if (!Bun.which("latexmk", { PATH: process.env.PATH ?? "" })) {
    throw new UserError("latexmk not found", "Install TeX Live (macOS: brew install --cask mactex-no-gui)");
  }
  const harness = opts.harness ?? config.harness;
  const adapter = resolveAdapter(harness, config);
  const template = findTemplate(opts.template ?? config.template, [builtinTemplatesDir(), l.templates]);
  const mode = opts.mode ?? "truthful";
  const targetPages = opts.pages ?? config.pages;
  const wantCover = opts.cover !== false;
  const timeoutMs = config.timeout_minutes * 60_000;
  const runId = newRunId();
  const runDir = join(l.runs, runId);
  const payload = buildAgentPayload(profile);
  const jobText = opts.input.text;

  const { app, job } = await intake(opts, l.applications, async () => {
    onProgress?.("parsing job…");
    const { value } = await runAgentStep({
      adapter,
      name: harness,
      workspace: createRunWorkspace(l.runs, "parse", runId),
      instructions: await Bun.file(join(import.meta.dir, "prompts", "parse-job.md")).text(),
      files: { "job.md": jobText, "parsed-job.schema.json": json(jsonSchemaFor("parsed-job")) },
      outFile: "parsed-job.json",
      validate: validateParsedJob,
      timeoutMs,
      onProgress,
    });
    return value;
  });
  const warnings = isEnglish(job.language) ? [] : [`job description language is "${job.language}"; v1 is English-only`];
  const profileText = profileTextOf(payload.entries, Object.values(payload.skills).flat());

  if (opts.pause) {
    const likelyGaps = keywordCoverage([...job.requirements, ...job.keywords], "", profileText).absent;
    if (!(await opts.pause(job, likelyGaps))) throw new UserError("Aborted");
  }

  // Research only feeds the cover letter, so it runs only when a letter can be written.
  const coverable = template.supports.includes("cover-letter");
  let research: CompanyResearch | null = null;
  let researchStatus: ResearchStatus = "skipped";
  if (wantCover && coverable && opts.research !== false) {
    const r = await runResearch({
      adapter: resolveAdapter(harness, config, { research: true }),
      name: harness, runsDir: l.runs, runId, appDir: app.dir, job, url: app.meta.source.url, timeoutMs, onProgress,
    });
    ({ research, status: researchStatus } = r);
    if (r.warning) warnings.push(r.warning);
  }

  const letterDate = formatLetterDate(new Date());
  const tag = (t: string) => (m: string) => onProgress?.(`[${t}] ${m}`);
  const ctx = (t: string): DocContext => ({
    adapter, name: harness, timeoutMs, profile, payload, job, jobText, template, mode, profileText,
    appJob: { company: app.meta.company, role: app.meta.role }, onProgress: tag(t),
  });
  const loop = <T>(kind: DocumentKind, doc: Doc<T>) =>
    refine<T>({
      kind, runsDir: l.runs, runId, adapter, name: harness, timeoutMs, ...doc,
      maxRounds: opts.review === false ? 0 : config.max_review_rounds,
      reviewFiles: { "job.md": jobText }, onProgress: tag(TAG[kind]),
    });
  const coverLoop = async () => {
    if (!coverable) throw new UserError(`template ${template.id} has no cover-letter design`);
    const banned = [...new Set([...DEFAULT_BANNED, ...config.banned_phrases])];
    const doc = await coverDocument(ctx("cover"), { research, banned, voice: loadVoiceSamples(l.profile), date: letterDate });
    return loop("cover-letter", doc);
  };
  const [rs, cs] = await Promise.allSettled([
    resumeDocument(ctx("resume"), { targetPages }).then((d) => loop("resume", d)),
    wantCover ? coverLoop() : Promise.resolve(null),
  ]);

  const result: ApplyResult = { app, failures: [], gaps: [], inferred: [], warnings };
  let atsHint: string | undefined;
  const save = <T>(kind: DocumentKind, r: RefineResult<T>, files: Record<string, string>, extra?: Record<string, unknown>): DocResult => {
    const facts = r.produced.facts;
    const saved = saveVersion({
      app, kind, about: profile.about, pdf: r.produced.pdf, filename: config.filename,
      files: { ...files, ...(r.review ? { "review.json": json(r.review) } : {}), "checks.json": json({ ...facts, warnings: r.warnings }) },
      meta: versionMeta({ mode, research: researchStatus, harness, run: runDir, template: template.id, facts, review: r.review, reviewedFinal: r.reviewedFinal, rounds: r.rounds, extra }),
    });
    warnings.push(...[...r.warnings, ...notReadyReasons(facts).map((w) => `not ready: ${w}`)].map((w) => `[${TAG[kind]}] ${w}`));
    if (facts.ats.status === "skipped" && facts.ats.hint) atsHint = facts.ats.hint;
    return { pdfPath: saved.pdfPath, version: saved.version, pages: r.produced.pages, ready: isReady(facts), review: r.review };
  };
  if (rs.status === "fulfilled") {
    const r = rs.value;
    result.resume = save("resume", r, {
      "resume.json": json(r.value),
      "resume.tex": r.produced.tex,
      "trace.json": json(resumeTrace(resolveResume(r.value, payload.entries))),
      "entries.snapshot.json": json(snapshotOf(resumeEntryIds(r.value), payload.entries)),
    });
    result.gaps = r.value.gaps;
    result.inferred = inferredClaims(r.value, profile);
  }
  if (cs.status === "fulfilled" && cs.value) {
    const r = cs.value;
    result.cover = save("cover-letter", r, {
      "cover-letter.json": json(r.value),
      "cover-letter.tex": r.produced.tex,
      "trace.json": json(coverTrace(r.value)),
      "entries.snapshot.json": json(snapshotOf(coverEntryIds(r.value), payload.entries)),
      "company.snapshot.json": json(citedFacts(r.value, research)),
    }, { date: letterDate });
  }
  if (atsHint) warnings.push(`ATS check skipped: ${atsHint}`);

  const rejected = ([["resume", rs], ["cover-letter", cs]] as const).flatMap(([kind, s]) => (s.status === "rejected" ? [{ kind, error: s.reason as unknown }] : []));
  const bug = rejected.find((f) => !(f.error instanceof UserError));
  if (bug) throw bug.error;
  if (!result.resume && !result.cover) throw rejected[0]!.error;
  for (const { kind, error } of rejected) {
    const e = error as UserError;
    result.failures.push(e.hint ? { kind, message: e.message, hint: e.hint } : { kind, message: e.message });
  }
  const toOpen = pdfToOpen(result);
  if (opts.open !== false && toOpen) await openFile(toOpen);
  return result;
}

/** The PDF `apply` opens: the resume, or the cover letter when only it was produced. */
export const pdfToOpen = (r: ApplyResult): string | undefined => r.resume?.pdfPath ?? r.cover?.pdfPath;

export function formatApplicationList(apps: Application[], filter: { status?: string; company?: string } = {}): string {
  if (apps.length === 0) return "No applications yet. Try: resumely apply --clip";
  const q = filter.company?.toLowerCase();
  const shown = apps.filter((a) => (!filter.status || a.meta.status === filter.status) && (!q || a.meta.company.toLowerCase().includes(q)));
  if (shown.length === 0) return "No applications match that filter.";
  const rows = [["DATE", "COMPANY", "ROLE", "STATUS", "RESUME", "COVER", "SENT"]];
  const ver = (a: Application, kind: DocumentKind) => {
    const v = latestVersion(a, kind);
    if (!v) return "-";
    return `v${v.version}${readJsonOr<{ ready?: boolean }>(join(v.dir, "meta.json"), {}).ready === false ? "!" : ""}`;
  };
  for (const a of shown) {
    const s = a.meta.sent;
    const sent = s ? [s.resume ? `r${s.resume}` : "", s.cover_letter ? `c${s.cover_letter}` : ""].filter(Boolean).join("/") : "";
    rows.push([a.slug.slice(0, 10), a.meta.company, a.meta.role, a.meta.status, ver(a, "resume"), ver(a, "cover-letter"), sent || "-"]);
  }
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
}

/**
 * The PDF `open` shows: `kind` when given; otherwise the resume, falling back to the cover letter when the
 * application has no resume (and no version was asked for). `label` names what was picked, e.g. "resume v2".
 */
export function resolveOpenTarget(app: Application, version?: number, kind?: DocumentKind): { path: string; label: string } {
  const k: DocumentKind = kind ?? (version === undefined && !latestVersion(app, "resume") && latestVersion(app, "cover-letter") ? "cover-letter" : "resume");
  const v = pickVersion(app, k, version);
  return { path: pdfIn(v.dir), label: `${k === "resume" ? "resume" : "cover letter"} v${v.version}` };
}
