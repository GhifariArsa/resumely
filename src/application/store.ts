import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { UserError } from "../errors";
import type { JobSource } from "../job/intake";
import type { ParsedJob } from "../pipeline/schemas";
import { slugify } from "./slug";

export { slugify, sendReadyName } from "./slug";

export type ApplicationMeta = {
  company: string;
  role: string;
  created: string;
  status: "drafted" | "applied" | "interviewing" | "rejected" | "offer";
  notes: string[];
  source: { kind: string; url?: string };
  /** Versions actually sent when the status became `applied`. */
  sent?: { resume?: number; cover_letter?: number };
  applied_at?: string;
};
export type Application = { dir: string; slug: string; meta: ApplicationMeta };
type Kind = "resume" | "cover-letter";

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createApplication(appsDir: string, job: ParsedJob, src: JobSource, now: Date = new Date()): Application {
  mkdirSync(appsDir, { recursive: true });
  const base = `${localDate(now)}-${slugify(job.company)}-${slugify(job.role)}`;
  let slug = base;
  for (let n = 2; existsSync(join(appsDir, slug)); n++) slug = `${base}-${n}`;
  const dir = join(appsDir, slug);
  mkdirSync(join(dir, "job"), { recursive: true });
  const source: ApplicationMeta["source"] = { kind: src.kind };
  if (src.url) source.url = src.url;
  const meta: ApplicationMeta = {
    company: job.company,
    role: job.role,
    created: now.toISOString(),
    status: "drafted",
    notes: [],
    source,
  };
  writeFileSync(join(dir, "application.toml"), stringify(meta));
  writeFileSync(join(dir, "job/raw.md"), src.text);
  if (src.html !== undefined) writeFileSync(join(dir, "job/source.html"), src.html);
  writeFileSync(join(dir, "job/parsed.json"), JSON.stringify(job, null, 2) + "\n");
  return { dir, slug, meta };
}

function readApplication(dir: string): Application | null {
  try {
    const raw = parse(readFileSync(join(dir, "application.toml"), "utf8")) as Partial<ApplicationMeta>;
    if (typeof raw.company !== "string" || typeof raw.role !== "string" || typeof raw.created !== "string") return null;
    const meta: ApplicationMeta = {
      company: raw.company,
      role: raw.role,
      created: raw.created,
      status: raw.status ?? "drafted",
      notes: raw.notes ?? [],
      source: raw.source ?? { kind: "file" },
    };
    if (raw.sent) meta.sent = raw.sent;
    if (typeof raw.applied_at === "string") meta.applied_at = raw.applied_at;
    return { dir, slug: basename(dir), meta };
  } catch {
    return null;
  }
}

export function listApplications(appsDir: string): Application[] {
  if (!existsSync(appsDir)) return [];
  const apps: Application[] = [];
  for (const e of readdirSync(appsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const a = readApplication(join(appsDir, e.name));
    if (a) apps.push(a);
  }
  return apps.sort((x, y) => y.meta.created.localeCompare(x.meta.created) || y.slug.localeCompare(x.slug));
}

export function findApplication(appsDir: string, query: string): Application {
  const apps = listApplications(appsDir);
  const exact = apps.find((a) => a.slug === query);
  if (exact) return exact;
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = apps.filter((a) => {
    const fields = [a.slug, a.meta.company, a.meta.role].map((f) => f.toLowerCase());
    if (fields.some((f) => f.includes(q))) return true;
    const hay = fields.join(" ");
    return tokens.length > 0 && tokens.every((t) => hay.includes(t));
  });
  if (matches.length === 0) throw new UserError(`No application matches "${query}"`, "resumely ls");
  if (matches.length > 1) {
    throw new UserError(`"${query}" matches ${matches.length} applications: ${matches.map((m) => m.slug).join(", ")}`, "Use a more specific name or the full slug");
  }
  return matches[0]!;
}

function versions(app: Application, kind: Kind): number[] {
  const d = join(app.dir, kind);
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => Number(e.name.slice(1)))
    .sort((a, b) => a - b);
}

export function nextVersionDir(app: Application, kind: Kind): { dir: string; version: number } {
  const version = (versions(app, kind).at(-1) ?? 0) + 1;
  const dir = join(app.dir, kind, `v${version}`);
  mkdirSync(dir, { recursive: true });
  return { dir, version };
}

export function latestVersion(app: Application, kind: Kind): { dir: string; version: number } | null {
  const version = versions(app, kind).at(-1);
  return version === undefined ? null : { dir: join(app.dir, kind, `v${version}`), version };
}

const TRACKING = /^(utm_.*|ref|gh_src)$/i;

/** Compare posting URLs as the same page: lowercase scheme/host, no fragment, no tracking params, no trailing slash. */
export function normaliseJobUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

/** An earlier application for the same posting: same source URL (normalised), or the same company + role (case-insensitive). Most recent first. */
export function findDuplicate(appsDir: string, o: { url?: string; company: string; role: string }): Application | null {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const company = norm(o.company);
  const role = norm(o.role);
  const url = o.url ? normaliseJobUrl(o.url) : "";
  return (
    listApplications(appsDir).find(
      (a) =>
        (url && a.meta.source.url && normaliseJobUrl(a.meta.source.url) === url) ||
        (company && role && norm(a.meta.company) === company && norm(a.meta.role) === role),
    ) ?? null
  );
}

/** Keep the application's original posting; save a re-applied posting next to it as `job/raw-<n>.md` (n = 2, 3, …). */
export function saveExtraRaw(app: Application, text: string): string {
  let n = 2;
  while (existsSync(join(app.dir, "job", `raw-${n}.md`))) n++;
  const path = join(app.dir, "job", `raw-${n}.md`);
  mkdirSync(join(app.dir, "job"), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export function saveMeta(app: Application): void {
  writeFileSync(join(app.dir, "application.toml"), stringify(app.meta));
}

export function addNote(app: Application, text: string, now: Date = new Date()): Application {
  app.meta.notes.push(`${localDate(now)}: ${text}`);
  saveMeta(app);
  return app;
}
