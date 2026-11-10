import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApplication, findApplication, latestVersion, nextVersionDir, sendReadyName } from "../application/store";
import type { Application } from "../application/store";
import { openFile } from "../commands/open";
import { loadConfig } from "../config";
import { UserError } from "../errors";
import { resolveAdapter } from "../harness/adapter";
import type { JobSource } from "../job/intake";
import { layout, requireDataRoot } from "../paths";
import { buildAgentPayload } from "../profile/context";
import { loadAbout, loadProfile } from "../profile/load";
import type { About } from "../profile/schema";
import { compileTex } from "../render/compile";
import { builtinTemplatesDir, findTemplate, renderResume } from "../render/render";
import type { TemplateMeta } from "../render/render";
import { EntrySnapshot, resolveResume, type EntryLike, type ResolvedResume } from "./resolve";
import { jsonSchemaFor, ResumeContent } from "./schemas";
import { validateParsedJob, validateResume } from "./validate";
import { createRunWorkspace, newRunId, runAgentStep } from "./workspace";

export type ApplyResult = {
  app: Application;
  pdfPath: string;
  pages: number;
  version: number;
  gaps: ResumeContent["gaps"];
  warnings: string[];
};

const prompt = (name: string) => Bun.file(join(import.meta.dir, "prompts", name)).text();
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

function flattenTrace(r: ResolvedResume) {
  const out: { section: string; item: string; bullet: number; text: string; entry_ids: string[]; basis: string }[] = [];
  if (r.summary) out.push({ section: "summary", item: "", bullet: 0, text: r.summary.text, entry_ids: r.summary.entry_ids, basis: "direct" });
  for (const s of r.sections) {
    for (const it of s.items) {
      it.bullets.forEach((b, i) => out.push({ section: s.title, item: it.heading, bullet: i, text: b.text, entry_ids: b.entry_ids, basis: b.basis }));
    }
  }
  return out;
}

function snapshotOf(c: ResumeContent, entries: EntryLike[]) {
  const ids = new Set<string>(c.summary?.entry_ids ?? []);
  for (const s of c.sections) for (const it of s.items) { ids.add(it.entry_id); for (const b of it.bullets) b.entry_ids.forEach((i) => ids.add(i)); }
  return entries.filter((e) => ids.has(e.id));
}

/** Resolve + render + compile in memory, then allocate the version dir and write everything. */
async function produceVersion(o: {
  app: Application;
  about: About;
  content: ResumeContent;
  /** Entries to resolve headings/dates from: the live profile (apply) or the version's frozen snapshot (render). */
  entries: EntryLike[];
  template: TemplateMeta;
  filename: string;
  timeoutMs: number;
  targetPages: number;
  meta: Record<string, unknown>;
  /** Raw snapshot to copy verbatim (render); otherwise one is built from `entries`. */
  snapshot?: string;
  onProgress?: (m: string) => void;
}): Promise<{ dir: string; version: number; pdfPath: string; pages: number; warnings: string[] }> {
  o.onProgress?.("compiling…");
  const resume = resolveResume(o.content, o.entries);
  const tex = renderResume(o.template, { about: o.about, resume });
  const { pdf, pages } = await compileTex(tex, o.template.engine, { timeoutMs: o.timeoutMs });
  const { dir, version } = nextVersionDir(o.app, "resume");
  const pdfName = sendReadyName(o.filename, o.about, "Resume", o.app.meta.company);
  writeFileSync(join(dir, "resume.json"), json(o.content));
  writeFileSync(join(dir, "resume.tex"), tex);
  writeFileSync(join(dir, pdfName), pdf);
  writeFileSync(join(dir, "trace.json"), json(flattenTrace(resume)));
  writeFileSync(join(dir, "entries.snapshot.json"), o.snapshot ?? json(snapshotOf(o.content, o.entries)));
  writeFileSync(
    join(dir, "meta.json"),
    json({ ...o.meta, template: o.template.id, mode: "truthful", pages, target_pages: o.targetPages, created: new Date().toISOString() }),
  );
  const warnings = pages > o.targetPages ? [`resume is ${pages} pages (target ${o.targetPages})`] : [];
  return { dir, version, pdfPath: join(dir, pdfName), pages, warnings };
}

export async function applyJob(opts: {
  root: string;
  input: JobSource;
  harness?: string;
  template?: string;
  open?: boolean;
  onProgress?: (m: string) => void;
}): Promise<ApplyResult> {
  const { root, onProgress } = opts;
  requireDataRoot(root);
  const l = layout(root);
  const config = loadConfig(root);
  const profile = loadProfile(l.profile);
  const harness = opts.harness ?? config.harness;
  const adapter = resolveAdapter(harness, config);
  const template = findTemplate(opts.template ?? config.template, [builtinTemplatesDir(), l.templates]);
  const timeoutMs = config.timeout_minutes * 60_000;
  const runId = newRunId();
  const runDir = join(l.runs, runId);
  const payload = buildAgentPayload(profile);

  onProgress?.("parsing job…");
  const job = await runAgentStep({
    adapter,
    name: harness,
    workspace: createRunWorkspace(l.runs, "parse", runId),
    instructions: await prompt("parse-job.md"),
    files: { "job.md": opts.input.text, "parsed-job.schema.json": json(jsonSchemaFor("parsed-job")) },
    outFile: "parsed-job.json",
    validate: validateParsedJob,
    timeoutMs,
    onProgress,
  });
  const app = createApplication(l.applications, job, opts.input);

  onProgress?.(`writing resume (${harness})…`);
  const content = await runAgentStep({
    adapter,
    name: harness,
    workspace: createRunWorkspace(l.runs, "write", runId),
    instructions: (await prompt("write-resume.md")).replaceAll("{{pages}}", String(config.pages)),
    files: {
      "profile.json": json(payload),
      "job.md": opts.input.text,
      "parsed-job.json": json(job),
      "resume.schema.json": json(jsonSchemaFor("resume")),
    },
    outFile: "resume.json",
    validate: (raw) => validateResume(raw, profile, "truthful"),
    timeoutMs,
    onProgress,
  });

  const v = await produceVersion({
    app, about: profile.about, content, entries: payload.entries, template, filename: config.filename, timeoutMs,
    targetPages: config.pages, onProgress, meta: { harness, run: runDir },
  });
  onProgress?.(`done: ${v.pdfPath}`);
  if (opts.open !== false) await openFile(v.pdfPath);
  return { app, pdfPath: v.pdfPath, pages: v.pages, version: v.version, gaps: content.gaps, warnings: v.warnings };
}

export function pdfIn(dir: string): string {
  const f = readdirSync(dir).find((n) => n.endsWith(".pdf"));
  if (!f) throw new UserError(`No PDF in ${dir}`);
  return join(dir, f);
}

function pickVersion(app: Application, version?: number): { dir: string; version: number } {
  if (version === undefined) {
    const latest = latestVersion(app, "resume");
    if (!latest) throw new UserError(`${app.slug} has no resume versions yet`, "Run: resumely apply");
    return latest;
  }
  const dir = join(app.dir, "resume", `v${version}`);
  if (!existsSync(dir)) throw new UserError(`${app.slug} has no resume v${version}`);
  return { dir, version };
}

export async function renderApplication(opts: {
  root: string;
  query: string;
  template: string;
  version?: number;
  open?: boolean;
  onProgress?: (m: string) => void;
}): Promise<{ app: Application; pdfPath: string; pages: number; version: number; warnings: string[] }> {
  requireDataRoot(opts.root);
  const l = layout(opts.root);
  const config = loadConfig(opts.root);
  const app = findApplication(l.applications, opts.query);
  const src = pickVersion(app, opts.version);
  const template = findTemplate(opts.template, [builtinTemplatesDir(), l.templates]);
  const { about } = loadAbout(l.profile);
  const content = ResumeContent.parse(JSON.parse(readFileSync(join(src.dir, "resume.json"), "utf8")));
  const snapshotPath = join(src.dir, "entries.snapshot.json");
  if (!existsSync(snapshotPath)) throw new UserError(`Missing ${snapshotPath}`, "render needs the version's frozen entries snapshot");
  const snapshot = readFileSync(snapshotPath, "utf8");
  const entries = EntrySnapshot.parse(JSON.parse(snapshot));
  const old = existsSync(join(src.dir, "meta.json")) ? JSON.parse(readFileSync(join(src.dir, "meta.json"), "utf8")) : {};
  const v = await produceVersion({
    app, about, content, entries, snapshot, template, filename: config.filename, timeoutMs: config.timeout_minutes * 60_000,
    targetPages: config.pages, onProgress: opts.onProgress,
    meta: { harness: old.harness, run: old.run, rendered_from: src.version },
  });
  if (opts.open !== false) await openFile(v.pdfPath);
  return { app, pdfPath: v.pdfPath, pages: v.pages, version: v.version, warnings: v.warnings };
}

export function formatApplicationList(apps: Application[]): string {
  if (apps.length === 0) return "No applications yet. Try: resumely apply --clip";
  const rows = [["DATE", "COMPANY", "ROLE", "STATUS", "RESUME"]];
  for (const a of apps) {
    const v = latestVersion(a, "resume");
    rows.push([a.slug.slice(0, 10), a.meta.company, a.meta.role, a.meta.status, v ? `v${v.version}` : "-"]);
  }
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
}

export function resolveOpenTarget(app: Application, version?: number): string {
  return pdfIn(pickVersion(app, version).dir);
}
