import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listApplications, latestVersion, type Application, type ApplicationMeta } from "../application/store";
import { buildTrace, type TraceReport } from "../application/trace";
import type { HardFacts } from "../checks/facts";
import { UserError } from "../errors";
import { layout } from "../paths";
import { readJsonOr } from "../pipeline/version";
import { Review, type ParsedJob } from "../pipeline/schemas";
import { formatProfileContext } from "../profile/context";
import { lintProfile, type LintIssue } from "../profile/lint";
import { loadProfile } from "../profile/load";
import type { Profile } from "../profile/schema";
import { listTemplates, type TemplateInfo } from "../render/templates";

export type Kind = "resume" | "cover-letter";
export const KINDS: readonly Kind[] = ["resume", "cover-letter"];

export type VersionSummary = {
  version: number;
  ready: boolean | null;
  template: string | null;
  mode: "truthful" | "stretch" | null;
  created: string | null;
  renderedFrom: number | null;
  sent: boolean;
  pdfName: string | null;
};

export type BoardRow = {
  slug: string;
  company: string;
  role: string;
  status: ApplicationMeta["status"];
  created: string;
  resume: VersionSummary | null;
  cover: VersionSummary | null;
  sent: ApplicationMeta["sent"];
  appliedAt: string | null;
};

const SENT_KEY = { resume: "resume", "cover-letter": "cover_letter" } as const;

function versionNumbers(app: Application, kind: Kind): number[] {
  const d = join(app.dir, kind);
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => Number(e.name.slice(1)))
    .sort((a, b) => a - b);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function summarize(app: Application, kind: Kind, version: number): VersionSummary {
  const dir = join(app.dir, kind, `v${version}`);
  const meta = readJsonOr<Record<string, unknown> | null>(join(dir, "meta.json"), null);
  const m = meta && typeof meta === "object" ? meta : {};
  let pdfName: string | null = null;
  try {
    pdfName = readdirSync(dir).find((n) => n.endsWith(".pdf")) ?? null;
  } catch {
    // directory vanished mid-read; leave the PDF unset
  }
  return {
    version,
    ready: typeof m.ready === "boolean" ? m.ready : null,
    template: str(m.template),
    mode: m.mode === "truthful" || m.mode === "stretch" ? m.mode : null,
    created: str(m.created),
    renderedFrom: typeof m.rendered_from === "number" ? m.rendered_from : null,
    sent: app.meta.sent?.[SENT_KEY[kind]] === version,
    pdfName,
  };
}

export function boardRows(root: string, filter: { status?: string; company?: string } = {}): BoardRow[] {
  const q = filter.company?.toLowerCase();
  return listApplications(layout(root).applications)
    .filter((a) => (!filter.status || a.meta.status === filter.status) && (!q || a.meta.company.toLowerCase().includes(q)))
    .map((a) => {
      const latest = (kind: Kind) => {
        const v = latestVersion(a, kind);
        return v ? summarize(a, kind, v.version) : null;
      };
      return {
        slug: a.slug,
        company: a.meta.company,
        role: a.meta.role,
        status: a.meta.status,
        created: a.meta.created,
        resume: latest("resume"),
        cover: latest("cover-letter"),
        sent: a.meta.sent,
        appliedAt: a.meta.applied_at ?? null,
      };
    });
}

/** Exact slug only, never fuzzy: the slug comes straight from a URL. */
export function getApplication(appsDir: string, slug: string): Application | null {
  return listApplications(appsDir).find((a) => a.slug === slug) ?? null;
}

export function fileHref(slug: string, kind: Kind, version: number, name: string): string {
  return `/files/${encodeURIComponent(slug)}/${kind}/v${version}/${encodeURIComponent(name)}`;
}

export type SnapshotEntry = { id: string; type: string; title: string; org?: string; start?: string; end?: string; body?: string; skills: string[]; tags?: string[] };

export type DocView = {
  kind: Kind;
  version: number;
  dir: string;
  versions: VersionSummary[];
  pdf: { name: string; href: string; path: string } | null;
  trace: TraceReport | null;
  entries: SnapshotEntry[];
  review: Review | null;
  checks: (HardFacts & { warnings: string[] }) | null;
  meta: Record<string, unknown>;
  files: { name: string; path: string; href: string | null }[];
  problems: string[];
};

export type AppView = {
  app: Application;
  kinds: Kind[];
  doc: DocView | null;
  job: { parsed: ParsedJob | null; raw: string | null };
  templates: TemplateInfo[];
  problems: string[];
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parsed JSON of an optional file: null when missing, null plus a problem when it exists but can't be parsed. */
function readOptional(dir: string, name: string, problems: string[]): unknown {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    problems.push(`${name} couldn't be read`);
    return null;
  }
}

function snapshotEntries(raw: unknown): SnapshotEntry[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter(isObject).filter((e) => typeof e.id === "string").map((e) => ({
    id: e.id as string,
    type: str(e.type) ?? "other",
    title: str(e.title) ?? "",
    org: str(e.org) ?? undefined,
    start: str(e.start) ?? undefined,
    end: str(e.end) ?? undefined,
    body: str(e.body) ?? undefined,
    skills: Array.isArray(e.skills) ? e.skills.filter((s): s is string => typeof s === "string") : [],
    tags: Array.isArray(e.tags) ? e.tags.filter((s): s is string => typeof s === "string") : undefined,
  }));
}

function docView(app: Application, kind: Kind, version: number, all: number[]): DocView {
  const dir = join(app.dir, kind, `v${version}`);
  const problems: string[] = [];

  const metaRaw = readOptional(dir, "meta.json", problems);
  const checksRaw = readOptional(dir, "checks.json", problems);
  const reviewRaw = readOptional(dir, "review.json", problems);
  const entriesRaw = readOptional(dir, "entries.snapshot.json", problems);

  let review: Review | null = null;
  if (reviewRaw !== null) {
    const r = Review.safeParse(reviewRaw);
    if (r.success) review = r.data;
    else problems.push("review.json couldn't be read");
  }
  const checks = isObject(checksRaw)
    ? ({ ...checksRaw, warnings: Array.isArray(checksRaw.warnings) ? checksRaw.warnings : [] } as unknown as HardFacts & { warnings: string[] })
    : null;
  if (checksRaw !== null && !checks) problems.push("checks.json couldn't be read");

  let trace: TraceReport | null = null;
  try {
    trace = buildTrace(app.dir, kind, version);
  } catch (e) {
    problems.push(`trace unavailable: ${(e as Error).message}`);
  }

  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
  } catch {
    // listing stays empty
  }
  const pdfName = names.find((n) => n.endsWith(".pdf")) ?? null;

  return {
    kind,
    version,
    dir,
    versions: all.map((v) => summarize(app, kind, v)),
    pdf: pdfName ? { name: pdfName, href: fileHref(app.slug, kind, version, pdfName), path: join(dir, pdfName) } : null,
    trace,
    entries: snapshotEntries(entriesRaw) ?? [],
    review,
    checks,
    meta: isObject(metaRaw) ? metaRaw : {},
    files: names.map((name) => ({ name, path: join(dir, name), href: /\.(pdf|tex|json)$/.test(name) ? fileHref(app.slug, kind, version, name) : null })),
    problems,
  };
}

export function applicationView(root: string, slug: string, o: { kind?: Kind; version?: number } = {}): AppView | null {
  const app = getApplication(layout(root).applications, slug);
  if (!app) return null;
  const byKind = new Map(KINDS.map((k) => [k, versionNumbers(app, k)] as const));
  const kinds = KINDS.filter((k) => byKind.get(k)!.length > 0);
  const problems: string[] = [];

  const kind = o.kind ?? kinds[0];
  let doc: DocView | null = null;
  if (kind) {
    const all = byKind.get(kind)!;
    const version = o.version ?? all.at(-1);
    if (version === undefined || !all.includes(version)) return null;
    doc = docView(app, kind, version, all);
  } else if (o.kind || o.version !== undefined) {
    return null;
  }

  const raw = (() => {
    try {
      return readFileSync(join(app.dir, "job/raw.md"), "utf8");
    } catch {
      return null;
    }
  })();
  const parsed = readJsonOr<ParsedJob | null>(join(app.dir, "job/parsed.json"), null);

  let templates: TemplateInfo[] = [];
  if (doc) {
    try {
      templates = listTemplates(root).filter((t) => t.supports.includes(doc.kind));
    } catch (e) {
      problems.push(`templates couldn't be listed: ${(e as Error).message}`);
    }
  }
  return { app, kinds: [...kinds], doc, job: { parsed, raw }, templates, problems };
}

export type EntryUsage = { slug: string; company: string; role: string; kind: Kind; versions: number[] };

/** Which applications cite each profile entry, from the frozen `entries.snapshot.json` of every version. */
export function entryUsage(appsDir: string): Map<string, EntryUsage[]> {
  const out = new Map<string, EntryUsage[]>();
  for (const app of listApplications(appsDir)) {
    for (const kind of KINDS) {
      const perId = new Map<string, number[]>();
      for (const version of versionNumbers(app, kind)) {
        const entries = snapshotEntries(readJsonOr<unknown>(join(app.dir, kind, `v${version}`, "entries.snapshot.json"), null));
        if (!entries) continue;
        for (const id of new Set(entries.map((e) => e.id))) perId.set(id, [...(perId.get(id) ?? []), version]);
      }
      for (const [id, versions] of perId) {
        const use: EntryUsage = { slug: app.slug, company: app.meta.company, role: app.meta.role, kind, versions };
        out.set(id, [...(out.get(id) ?? []), use]);
      }
    }
  }
  return out;
}

export type ProfileView = {
  profile: Profile | null;
  loadError: string | null;
  context: string | null;
  usage: Map<string, EntryUsage[]>;
  lint: LintIssue[];
  lintError: string | null;
};

const describe = (e: unknown): string => (e instanceof UserError && e.hint ? `${e.message} (${e.hint})` : (e as Error).message);

export function profileView(root: string): ProfileView {
  const l = layout(root);
  let profile: Profile | null = null;
  let loadError: string | null = null;
  try {
    profile = loadProfile(l.profile);
  } catch (e) {
    loadError = describe(e);
  }
  let lint: LintIssue[] = [];
  let lintError: string | null = null;
  try {
    lint = lintProfile(root);
  } catch (e) {
    lintError = describe(e);
  }
  return { profile, loadError, context: profile ? formatProfileContext(profile) : null, usage: entryUsage(l.applications), lint, lintError };
}
