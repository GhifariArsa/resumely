import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createApplication, findApplication, findDuplicate, latestVersion, saveExtraRaw } from "../application/store";
import type { Application } from "../application/store";
import { keywordCoverage } from "../checks/keywords";
import { openFile } from "../commands/open";
import { loadConfig, type Config } from "../config";
import { UserError } from "../errors";
import { resolveAdapter, resolveFallbacks } from "../harness/adapter";
import type { JobSource } from "../job/intake";
import { layout, requireDataRoot } from "../paths";
import { buildAgentPayload } from "../profile/context";
import { loadProfile, loadVoiceSamples } from "../profile/load";
import { onInterrupt } from "../signals";
import { builtinTemplatesDir, findTemplate, formatLetterDate, type TemplateMeta } from "../render/render";
import { DEFAULT_BANNED } from "./banned";
import { pickResumable, RunCheckpoint, type RunOptions } from "./checkpoint";
import { coverDocument, inferredClaims, profileTextOf, resumeDocument, type Doc, type DocContext } from "./documents";
import { refine, type DocumentKind, type RefineResult } from "./refine";
import { loadCompanyResearch, runResearch, type ResearchStatus } from "./research";
import { jsonSchemaFor, ResumeContent, type CompanyResearch, type ParsedJob, type Review } from "./schemas";
import { validateParsedJob } from "./validate";
import { citedFacts, coverEntryIds, coverTrace, json, notReadyReasons, pdfIn, pickVersion, readJsonFile, readJsonOr, resumeEntryIds, resumeTrace, saveVersion, snapshotOf, versionMeta, isReady } from "./version";
import { resolveResume } from "./resolve";
import { createRunWorkspace, newRunId, runAgentStep } from "./workspace";

export { renderApplication } from "./rerender";

export type DocResult = { pdfPath: string; version: number; pages: number; ready: boolean; review: Review | null };

export type ApplyResult = {
  app: Application;
  /** The checkpointed run (`<root>/.runs/<runId>/`); `resumely resume <runId>` continues it. */
  runId: string;
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
  /** Override the parsed role (for postings that list several). */
  role?: string;
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

/**
 * A deliberate stop that resuming cannot get past (the user aborted, or the duplicate policy refused): the run is
 * marked aborted, not failed, so `resumely resume` never offers it, and the error carries no resume hint.
 */
class RunStopped extends UserError {}

type IntakeOptions = Pick<ApplyOptions, "input" | "into" | "onDuplicate" | "role">;

/** Parse the posting and find or create its application, asking `onDuplicate` about an earlier one. */
async function intake(o: IntakeOptions, appsDir: string, parse: () => Promise<ParsedJob>): Promise<{ app: Application; job: ParsedJob; warnings: string[] }> {
  const decide = async (existing: Application): Promise<Application | null> => {
    if (!o.onDuplicate) throw new RunStopped(`Already applied: ${existing.slug}`, `Use --into ${existing.slug} to add a version, or --new for a separate application`);
    const choice = await o.onDuplicate(existing);
    if (choice === "abort") throw new RunStopped("Aborted");
    return choice === "existing" ? existing : null;
  };
  let asked = false;
  let reuse: Application | null = null;
  const into = o.into;
  const guard = (dup: Application): Application => {
    if (dup.slug !== into!.slug) throw new RunStopped(`--into ${into!.slug} doesn't match the earlier application ${dup.slug}`, `Use --into ${dup.slug}, or --new for a separate application`);
    return into!;
  };
  const byUrl = o.input.url ? findDuplicate(appsDir, { url: o.input.url, company: "", role: "" }) : null;
  if (byUrl) {
    asked = true;
    reuse = into ? guard(byUrl) : await decide(byUrl);
  }
  if (into && !reuse) reuse = into;
  let job = (reuse && loadParsed(reuse)) || (await parse());
  const warnings: string[] = [];
  const role = o.role?.trim();
  if (role) {
    const known = [job.role, ...(job.other_roles ?? [])];
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    if (!known.some((k) => same(k, role))) warnings.push(`--role "${role}" is not one of the roles parsed from the posting (${known.join(", ")})`);
    job = { ...job, role };
  }
  if (!asked && !reuse) {
    const byRole = findDuplicate(appsDir, { company: job.company, role: job.role });
    if (byRole) reuse = await decide(byRole);
  }
  if (!reuse) return { app: createApplication(appsDir, job, o.input), job, warnings };
  saveExtraRaw(reuse, o.input.text);
  return { app: reuse, job: loadParsed(reuse) ?? job, warnings };
}

function requireLatexmk(): void {
  if (!Bun.which("latexmk", { PATH: process.env.PATH ?? "" })) {
    throw new UserError("latexmk not found", "Install TeX Live (macOS: brew install --cask mactex-no-gui)");
  }
}

const templateDirs = (root: string) => [builtinTemplatesDir(), layout(root).templates];

export async function applyJob(opts: ApplyOptions): Promise<ApplyResult> {
  const { root } = opts;
  requireDataRoot(root);
  const l = layout(root);
  const config = loadConfig(root);
  const profile = loadProfile(l.profile);
  if (profile.entries.length === 0 || profile.about.name === "Your Name") {
    throw new UserError("Your profile is empty", `Add entries under ${l.profile} (see README) — check with: resumely profile show`);
  }
  requireLatexmk();
  const harness = opts.harness ?? config.harness;
  resolveAdapter(harness, config);
  const template = findTemplate(opts.template ?? config.template, templateDirs(root));
  const { kind, url, path } = opts.input;
  const options: RunOptions = {
    template: template.id,
    mode: opts.mode ?? "truthful",
    pages: opts.pages ?? config.pages,
    cover: opts.cover !== false,
    research: opts.research !== false,
    review: opts.review !== false,
    ...(opts.role?.trim() ? { role: opts.role.trim() } : {}),
    input: { kind, ...(url ? { url } : {}), ...(path ? { path } : {}) },
  };
  const cp = RunCheckpoint.create(l.runs, newRunId(), { harness, options, jobText: opts.input.text, profileDir: l.profile });
  return runPipeline({ ...opts, cp, config, harness, template });
}

/**
 * Continue a failed (or abandoned) run from its last finished step: `runId`, or the newest failed run. It reuses the
 * run's options, job text and profile snapshot; `harness` replaces the run's harness from here on.
 */
export async function resumeRun(o: {
  root: string;
  runId?: string;
  harness?: string;
  open?: boolean;
  onProgress?: (m: string) => void;
  onDuplicate?: ApplyOptions["onDuplicate"];
}): Promise<ApplyResult> {
  requireDataRoot(o.root);
  const l = layout(o.root);
  const config = loadConfig(o.root);
  const cp = pickResumable(l.runs, o.runId);
  const { options, run_id: runId } = cp.state;
  requireLatexmk();
  const harness = o.harness ?? cp.state.harness;
  resolveAdapter(harness, config);
  const template = findTemplate(options.template, templateDirs(o.root));
  let app: Application | undefined;
  if (cp.state.app) {
    const { dir, slug } = cp.state.app;
    if (!existsSync(dir)) throw new UserError(`Application folder for run ${runId} is gone: ${dir}`, "Move it back, or use resumely mv to rename applications");
    app = findApplication(l.applications, slug);
  }
  cp.setHarness(harness);
  return runPipeline({
    root: o.root, input: { ...options.input, text: cp.jobText }, open: o.open, onProgress: o.onProgress, onDuplicate: o.onDuplicate,
    cp, config, harness, template, app,
  });
}

type Pipeline = Omit<ApplyOptions, "harness" | "template" | "mode" | "pages" | "cover" | "research" | "review"> & {
  cp: RunCheckpoint;
  config: Config;
  harness: string;
  template: TemplateMeta;
  /** The application an earlier attempt of this run created: intake is skipped. */
  app?: Application;
};

/** Run (or continue) a checkpointed run; records its outcome in state.json. */
async function runPipeline(p: Pipeline): Promise<ApplyResult> {
  const { cp } = p;
  cp.start();
  const unregister = onInterrupt(() => cp.fail(new UserError("interrupted")));
  try {
    return await pipeline(p);
  } catch (e) {
    if (e instanceof RunStopped) {
      cp.abort();
      throw e;
    }
    cp.fail(e);
    if (e instanceof UserError) {
      const resume = `resume with: resumely resume ${cp.state.run_id}`;
      e.hint = e.hint ? `${e.hint} — ${resume}` : resume;
    }
    throw e;
  } finally {
    unregister();
  }
}

/** A saved document's result, located in the application's current folder. */
const savedDoc = (app: Application, kind: DocumentKind, d: DocResult): DocResult => ({ ...d, pdfPath: join(app.dir, kind, `v${d.version}`, basename(d.pdfPath)) });

async function pipeline(p: Pipeline): Promise<ApplyResult> {
  const { cp, config, harness, template, onProgress } = p;
  const l = layout(p.root);
  const runId = cp.state.run_id;
  const opt = cp.state.options;
  const adapter = resolveAdapter(harness, config);
  const fallbacks = resolveFallbacks(config, harness);
  const profile = loadProfile(cp.profileDir);
  const mode = opt.mode;
  const targetPages = opt.pages;
  const timeoutMs = config.timeout_minutes * 60_000;
  const payload = buildAgentPayload(profile);
  const jobText = p.input.text;

  const parse = async () => {
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
      checkpoint: cp,
      fallbacks,
    });
    return value;
  };
  const savedJob = p.app ? loadParsed(p.app) : null;
  if (savedJob) onProgress?.("parse: reused from checkpoint");
  const taken = p.app ? { app: p.app, job: savedJob ?? (await parse()), warnings: [] as string[] } : await intake({ ...p, role: opt.role }, l.applications, parse);
  const { app, job } = taken;
  cp.setApp(app);
  const warnings = isEnglish(job.language) ? [] : [`job description language is "${job.language}"; v1 is English-only`];
  warnings.push(...taken.warnings);
  if (!opt.role && job.other_roles?.length) warnings.push(`posting lists other roles: ${job.other_roles.join(", ")} (pick one with --role)`);
  const profileText = profileTextOf(payload.entries, Object.values(payload.skills).flat());

  if (p.pause) {
    const likelyGaps = keywordCoverage([...job.requirements, ...job.keywords], "", profileText).absent;
    if (!(await p.pause(job, likelyGaps))) throw new RunStopped("Aborted");
  }

  // Research only feeds the cover letter, so it runs only when a letter can be written.
  const coverable = template.supports.includes("cover-letter");
  let research: CompanyResearch | null = null;
  let researchStatus: ResearchStatus = "skipped";
  if (cp.state.research) {
    researchStatus = cp.state.research.status;
    onProgress?.("research: reused from checkpoint");
    if (researchStatus === "used") research = loadCompanyResearch(app.dir);
    if (cp.state.research.warning) warnings.push(cp.state.research.warning);
  } else {
    let warning: string | undefined;
    if (opt.cover && coverable && opt.research) {
      const r = await runResearch({
        adapter: resolveAdapter(harness, config, { research: true }),
        name: harness, runsDir: l.runs, runId, appDir: app.dir, job, url: app.meta.source.url, timeoutMs, onProgress,
      });
      ({ research, status: researchStatus, warning } = r);
      if (warning) warnings.push(warning);
    }
    cp.setResearch(warning ? { status: researchStatus, warning } : { status: researchStatus });
  }

  const letterDate = formatLetterDate(new Date());
  const tag = (t: string) => (m: string) => onProgress?.(`[${t}] ${m}`);
  const ctx = (t: string): DocContext => ({
    adapter, name: harness, timeoutMs, profile, payload, job, jobText, template, mode, profileText,
    appJob: { company: app.meta.company, role: app.meta.role }, onProgress: tag(t), checkpoint: cp, fallbacks,
  });
  const loop = <T>(kind: DocumentKind, doc: Doc<T>) =>
    refine<T>({
      kind, runsDir: l.runs, runId, adapter, name: harness, timeoutMs, ...doc,
      maxRounds: opt.review ? config.max_review_rounds : 0,
      reviewFiles: { "job.md": jobText }, onProgress: tag(TAG[kind]), checkpoint: cp, fallbacks,
    });
  const coverLoop = async () => {
    if (!coverable) throw new UserError(`template ${template.id} has no cover-letter design`);
    const banned = [...new Set([...DEFAULT_BANNED, ...config.banned_phrases])];
    const doc = await coverDocument(ctx("cover"), { research, banned, voice: loadVoiceSamples(cp.profileDir), date: letterDate });
    return loop("cover-letter", doc);
  };
  // Documents an earlier attempt of this run saved are kept as they are.
  const earlier = cp.state.documents;
  const [rs, cs] = await Promise.allSettled([
    earlier.resume ? Promise.resolve(null) : resumeDocument(ctx("resume"), { targetPages }).then((d) => loop("resume", d)),
    opt.cover && !earlier["cover-letter"] ? coverLoop() : Promise.resolve(null),
  ]);

  const result: ApplyResult = { app, runId, failures: [], gaps: [], inferred: [], warnings };
  let atsHint: string | undefined;
  const save = <T>(kind: DocumentKind, r: RefineResult<T>, files: Record<string, string>, extra?: Record<string, unknown>): DocResult => {
    const facts = r.produced.facts;
    const saved = saveVersion({
      app, kind, about: profile.about, pdf: r.produced.pdf, filename: config.filename,
      files: { ...files, ...(r.review ? { "review.json": json(r.review) } : {}), "checks.json": json({ ...facts, warnings: r.warnings }) },
      meta: versionMeta({ mode, research: researchStatus, harness, run: cp.dir, template: template.id, facts, review: r.review, reviewedFinal: r.reviewedFinal, rounds: r.rounds, extra }),
    });
    warnings.push(...[...r.warnings, ...notReadyReasons(facts).map((w) => `not ready: ${w}`)].map((w) => `[${TAG[kind]}] ${w}`));
    if (facts.ats.status === "skipped" && facts.ats.hint) atsHint = facts.ats.hint;
    const d = { pdfPath: saved.pdfPath, version: saved.version, pages: r.produced.pages, ready: isReady(facts), review: r.review };
    cp.setDocument(kind, d);
    return d;
  };
  if (earlier.resume) {
    result.resume = savedDoc(app, "resume", earlier.resume);
    const content = (() => {
      try {
        return readJsonFile(join(app.dir, "resume", `v${earlier.resume.version}`, "resume.json"), ResumeContent);
      } catch {
        return null;
      }
    })();
    if (content) {
      result.gaps = content.gaps;
      result.inferred = inferredClaims(content, profile);
    }
  } else if (rs.status === "fulfilled" && rs.value) {
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
  if (earlier["cover-letter"]) {
    result.cover = savedDoc(app, "cover-letter", earlier["cover-letter"]);
  } else if (cs.status === "fulfilled" && cs.value) {
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
  if (!result.resume && !result.cover && rejected.length) throw rejected[0]!.error;
  for (const { kind, error } of rejected) {
    const e = error as UserError;
    result.failures.push(e.hint ? { kind, message: e.message, hint: e.hint } : { kind, message: e.message });
  }
  if (rejected.length) cp.fail(rejected[0]!.error);
  else cp.finish();
  for (const [step, s] of Object.entries(cp.state.steps)) if (s.fallback) warnings.push(`${step} ran on fallback harness ${s.harness}`);
  const toOpen = pdfToOpen(result);
  if (p.open !== false && toOpen) await openFile(toOpen);
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
