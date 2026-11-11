import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { slugify } from "../application/slug";
import { hasToken, scanClaims } from "../checks/fabrication";
import { loadConfig } from "../config";
import { resolveAdapter } from "../harness/adapter";
import { layout } from "../paths";
import { schemaErrors, type ValidationResult } from "../pipeline/validate";
import { createRunWorkspace, newRunId, runAgentStep } from "../pipeline/workspace";
import { unsupportedChars } from "../render/latex-escape";
import { buildAgentPayload } from "./context";
import { stageDrafts } from "./inbox";
import { dateIssues } from "./lint";
import { loadProfile } from "./load";
import { ImportResult, type Draft, type DraftEntry, type Proposal } from "./proposal";
import type { Entry, Profile } from "./schema";
import { readImportSource } from "./source";

const yearOf = (d?: string) => (d && /^\d{4}/.test(d) ? [d.slice(0, 4)] : []);

/** What a proposal may draw facts from: the document, plus (for update/duplicate) the entry it targets. */
function proposalSources(sourceText: string, target?: Entry): string[] {
  if (!target) return [sourceText];
  return [sourceText, target.title, target.org ?? "", target.body, ...target.skills, ...yearOf(target.start), ...yearOf(target.end)];
}

/** The free-text fields of an entry that `scanClaims` checks, with their agent-facing paths. */
function scannedFields(e: DraftEntry, at: string): [string, string][] {
  const out: [string, string][] = [[`${at}.title`, e.title]];
  if (e.org) out.push([`${at}.org`, e.org]);
  if (e.location) out.push([`${at}.location`, e.location]);
  e.bullets.forEach((b, j) => out.push([`${at}.bullets[${j}]`, b]));
  if (e.context) out.push([`${at}.context`, e.context]);
  return out;
}

const isNumberToken = (tok: string) => /^[$\d]/.test(tok);

function charErrors(where: string, text: string, errors: string[]): void {
  for (const c of unsupportedChars(text)) {
    errors.push(`${where}: unsupported character "${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
  }
}

/** Unsourced proper nouns in a draft's scanned fields, as review flags. Numbers are already guaranteed sourced. */
export function importFlags(entry: DraftEntry, sources: string[]): string[] {
  const toks = new Set<string>();
  for (const [, text] of scannedFields(entry, "entry")) {
    for (const tok of scanClaims(text, sources)) if (!isNumberToken(tok)) toks.add(tok);
  }
  return [...toks].map((t) => `unsourced "${t}"`);
}

/**
 * Validate the agent's `out/proposals.json`: every number, skill, date year and contact detail must come from the
 * source document (or, for update/duplicate, the targeted entry). Unsourced proper nouns are warnings.
 */
export function validateImport(
  raw: unknown,
  o: { profile: Profile; sourceText: string; sourceHtml?: string; now?: Date },
): ValidationResult<ImportResult> {
  const r = ImportResult.safeParse(raw);
  if (!r.success) return { ok: false, errors: schemaErrors(r.error.issues) };
  const v = r.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(o.profile.entries.map((e) => [e.id, e]));
  const firstNew = new Map<string, number>();

  v.proposals.forEach((p, i) => {
    const at = `proposals[${i}]`;
    const e = p.entry;
    let target: Entry | undefined;
    if (p.kind === "new") {
      if (p.target_id !== undefined) errors.push(`${at}.target_id: must be omitted for kind "new"`);
      const key = `${e.type}|${slugify(e.org ?? "")}|${slugify(e.title)}`;
      const prev = firstNew.get(key);
      if (prev !== undefined) errors.push(`${at}: duplicates proposals[${prev}]`);
      else firstNew.set(key, i);
    } else if (!p.target_id) {
      errors.push(`${at}.target_id: required for kind "${p.kind}"`);
    } else {
      target = byId.get(p.target_id);
      if (!target) errors.push(`${at}.target_id: unknown entry id "${p.target_id}"`);
      else if (p.kind === "update" && e.type !== target.type) {
        errors.push(`${at}.entry.type: "${e.type}" does not match ${target.id}'s type "${target.type}"`);
      }
    }
    const sources = proposalSources(o.sourceText, target);
    const joined = sources.join("\n");

    for (const d of dateIssues(e, o.now)) if (d.severity === "error") errors.push(`${at}.entry: ${d.message}`);
    for (const f of ["start", "end"] as const) {
      const year = yearOf(e[f])[0];
      if (year && !new RegExp(`(?<!\\d)${year}(?!\\d)`).test(joined)) {
        errors.push(`${at}.entry.${f}: year ${year} does not appear in the source`);
      }
    }

    for (const [where, text] of scannedFields(e, `${at}.entry`)) {
      for (const tok of scanClaims(text, sources)) {
        if (isNumberToken(tok)) errors.push(`${where}: "${tok}" does not appear in the source`);
        else warnings.push(`${at}: unsourced "${tok}"`);
      }
    }
    e.skills.forEach((s, j) => {
      if (!hasToken(joined, s, s.length <= 3)) errors.push(`${at}.entry.skills[${j}]: "${s}" does not appear in the source`);
      charErrors(`${at}.entry.skills[${j}]`, s, errors);
    });
    charErrors(`${at}.entry.title`, e.title, errors);
    if (e.org) charErrors(`${at}.entry.org`, e.org, errors);
    if (e.location) charErrors(`${at}.entry.location`, e.location, errors);
  });

  for (const [group, items] of Object.entries(v.skills)) {
    items.forEach((s, j) => {
      if (!hasToken(o.sourceText, s, s.length <= 3)) errors.push(`skills.${group}[${j}]: "${s}" does not appear in the source`);
      charErrors(`skills.${group}[${j}]`, s, errors);
    });
  }

  const a = v.about;
  if (a) {
    const src = o.sourceText;
    if (a.name !== undefined) {
      for (const tok of a.name.split(/\s+/).filter(Boolean)) {
        if (!hasToken(src, tok)) errors.push(`about.name: "${tok}" does not appear in the source`);
      }
      charErrors("about.name", a.name, errors);
    }
    if (a.email !== undefined && !src.toLowerCase().includes(a.email.toLowerCase())) {
      errors.push(`about.email: "${a.email}" does not appear in the source`);
    }
    if (a.phone !== undefined) {
      const digits = a.phone.replace(/\D/g, "");
      if (!digits || !src.replace(/\D/g, "").includes(digits)) errors.push(`about.phone: "${a.phone}" does not appear in the source`);
    }
    const linkText = `${src}\n${o.sourceHtml ?? ""}`.toLowerCase();
    a.links?.forEach((l, j) => {
      const bare = l.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "").toLowerCase();
      if (!bare || !linkText.includes(bare)) errors.push(`about.links[${j}].url: "${l.url}" does not appear in the source`);
    });
    for (const f of ["headline", "summary"] as const) {
      const text = a[f];
      if (!text) continue;
      for (const tok of scanClaims(text, [src])) {
        if (isNumberToken(tok)) errors.push(`about.${f}: "${tok}" does not appear in the source`);
        else warnings.push(`about: unsourced "${tok}"`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: v, warnings };
}

const PROMPT = join(import.meta.dir, "..", "pipeline", "prompts", "import-profile.md");

/** Headless `profile import`: read the source, run the agent's `import` step, stage its proposals in the inbox. */
export async function importProfile(o: {
  root: string;
  source: string;
  harness?: string;
  onProgress?: (m: string) => void;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{ staged: Proposal[]; skipped: string[]; warnings: string[]; workspace: string }> {
  const l = layout(o.root);
  const config = loadConfig(o.root);
  const harness = o.harness ?? config.harness;
  const adapter = resolveAdapter(harness, config);
  const profile = loadProfile(l.profile);
  o.onProgress?.("reading source…");
  const src = await readImportSource(o.source, { fetchImpl: o.fetchImpl });

  const runId = newRunId(o.now);
  const workspace = createRunWorkspace(l.runs, "import", runId);
  if (src.attachment) writeFileSync(join(workspace, src.attachment.name), src.attachment.bytes);

  o.onProgress?.("extracting proposals…");
  const { value, warnings } = await runAgentStep({
    adapter,
    name: harness,
    workspace,
    instructions: await Bun.file(PROMPT).text(),
    files: {
      "profile.json": JSON.stringify(buildAgentPayload(profile), null, 2) + "\n",
      "source.txt": src.text,
      "import.schema.json": JSON.stringify(z.toJSONSchema(ImportResult), null, 2) + "\n",
    },
    outFile: "proposals.json",
    validate: (raw) => validateImport(raw, { profile, sourceText: src.text, sourceHtml: src.html, now: o.now }),
    timeoutMs: config.timeout_minutes * 60_000,
    onProgress: o.onProgress,
  });

  const byId = new Map(profile.entries.map((e) => [e.id, e]));
  const drafts: Draft[] = value.proposals.map((p) => ({
    kind: p.kind,
    ...(p.target_id ? { target_id: p.target_id } : {}),
    entry: p.entry,
    rationale: p.rationale,
    flags: importFlags(p.entry, proposalSources(src.text, p.target_id ? byId.get(p.target_id) : undefined)),
  }));
  const ref = src.kind === "url" ? src.ref : basename(src.ref);
  const { staged, skipped } = stageDrafts(
    l.profile,
    profile,
    drafts,
    { skills: value.skills, about: value.about },
    { kind: "import", ref, run: runId },
    o.now,
  );
  return { staged, skipped, warnings: [...src.warnings, ...warnings], workspace };
}
