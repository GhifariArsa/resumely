import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { UserError } from "../errors";
import { pickVersion } from "../pipeline/version";
import type { Application } from "./store";

export interface TraceRow { section: string; text: string; entry_ids: string[]; basis: "direct" | "inferred"; flags: string[] }
export interface TraceReport { app: string; kind: "resume" | "cover-letter"; version: number; rows: TraceRow[]; gaps: string[]; warnings: string[] }

type ResumeTraceRow = { section: string; item: string; text: string; entry_ids: string[]; basis: "direct" | "inferred" };
type CoverTraceRow = { text: string; entry_ids: string[]; company_fact_ids: string[] };
type ResumeShape = { sections?: { items?: { bullets?: unknown[] }[] }[]; gaps?: { requirement: string; note: string }[] };
type ChecksShape = { warnings?: string[]; fabrication_warnings?: string[]; keywords?: { absent?: string[] } };

function readOptional<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readTrace<T>(path: string): T[] {
  if (!existsSync(path)) throw new UserError(`Missing ${path}`, "This version has no trace.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UserError(`Invalid trace.json at ${path}`, (e as Error).message);
  }
  if (!Array.isArray(raw)) throw new UserError(`Invalid trace.json at ${path}`, "expected an array");
  return raw as T[];
}

/** Row index a fabrication warning's path refers to, plus the unsourced token. Null when it maps to no row. */
function locate(warning: string, kind: "resume" | "cover-letter", offsets: Map<string, number>, hasSummary: boolean, rowCount: number): { row: number; token: string } | null {
  const m = /^(summary|paragraphs\[(\d+)\]|sections\[(\d+)\]\.items\[(\d+)\]\.bullets\[(\d+)\]): "([^"]*)"/.exec(warning);
  if (!m) return null;
  let row: number | undefined;
  if (kind === "resume") {
    if (m[1] === "summary") row = hasSummary ? 0 : undefined;
    else if (m[3] !== undefined) row = offsets.get(`${m[3]}.${m[4]}.${m[5]}`);
  } else if (m[2] !== undefined) row = Number(m[2]);
  return row === undefined || row < 0 || row >= rowCount ? null : { row, token: m[6] ?? "" };
}

/** The bullet-by-bullet source report for one stored document version. */
export function buildTrace(appDir: string, kind: "resume" | "cover-letter", version?: number): TraceReport {
  const app = basename(appDir);
  const picked = pickVersion({ dir: appDir, slug: app } as Application, kind, version);
  const dir = picked.dir;
  const warnings: string[] = [];

  const resume = kind === "resume" ? readOptional<ResumeShape>(join(dir, "resume.json")) : null;
  const checks = readOptional<ChecksShape>(join(dir, "checks.json"));

  let rows: TraceRow[];
  let hasSummary = false;
  if (kind === "resume") {
    const raw = readTrace<ResumeTraceRow>(join(dir, "trace.json"));
    hasSummary = raw[0]?.section === "summary" && raw[0].item === "";
    rows = raw.map((r) => ({ section: r.item ? `${r.section} / ${r.item}` : r.section, text: r.text, entry_ids: r.entry_ids, basis: r.basis, flags: [] }));
  } else {
    const raw = readTrace<CoverTraceRow>(join(dir, "trace.json"));
    rows = raw.map((r, i) => ({ section: `paragraph ${i + 1}`, text: r.text, entry_ids: [...r.entry_ids, ...r.company_fact_ids], basis: "direct" as const, flags: [] }));
  }

  // Flat row index of each resume bullet: the summary (if any), then sections -> items -> bullets.
  const offsets = new Map<string, number>();
  let flat = hasSummary ? 1 : 0;
  resume?.sections?.forEach((s, si) => s.items?.forEach((it, ii) => it.bullets?.forEach((_, bi) => offsets.set(`${si}.${ii}.${bi}`, flat++))));

  warnings.push(...(checks?.warnings ?? []));
  for (const w of checks?.fabrication_warnings ?? []) {
    const hit = locate(w, kind, offsets, hasSummary, rows.length);
    const target = hit ? rows[hit.row] : undefined;
    if (hit && target) target.flags.push(`unsourced "${hit.token}"`);
    else warnings.push(w);
  }
  if (!checks) warnings.push("missing checks.json");
  if (kind === "resume" && !resume) warnings.push("missing resume.json");

  const gaps = (resume?.gaps ?? []).map((g) => `${g.requirement}: ${g.note}`);
  const named = (resume?.gaps ?? []).map((g) => g.requirement.toLowerCase());
  for (const k of checks?.keywords?.absent ?? []) {
    if (!named.some((n) => n.includes(k.toLowerCase()))) gaps.push(`keyword not in profile: ${k}`);
  }

  return { app, kind, version: picked.version, rows, gaps, warnings };
}

export function formatTrace(r: TraceReport): string {
  const out: string[] = [`${r.kind} v${r.version} — ${r.app}`, ""];
  let last: string | null = null;
  for (const row of r.rows) {
    if (row.section !== last) {
      out.push(row.section);
      last = row.section;
    }
    out.push(`  ${`[${row.basis}]`.padEnd(10)} ${row.entry_ids.join(", ")}  ${row.text}`);
    for (const f of row.flags) out.push(`  ! ${f}`);
  }
  if (r.gaps.length) out.push("", "gaps:", ...r.gaps.map((g) => `  ${g}`));
  if (r.warnings.length) out.push("", "warnings:", ...r.warnings.map((w) => `  ${w}`));
  return out.join("\n") + "\n";
}
