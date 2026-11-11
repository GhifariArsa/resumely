import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { slugify } from "../application/slug";
import { UserError } from "../errors";
import { normaliseSkill } from "../pipeline/validate";
import { sameAsLive } from "./accept";
import { loadProfile } from "./load";
import { AboutChange, DraftEntry, Proposal, type Draft } from "./proposal";
import type { Entry, EntryType, Profile } from "./schema";

export function inboxDir(profileDir: string): string {
  return join(profileDir, ".inbox");
}
const archiveDir = (profileDir: string) => join(inboxDir(profileDir), "archive");

const numOf = (name: string): number | null => {
  const m = name.match(/^(\d+)-/);
  return m ? Number(m[1]) : null;
};
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : []);

export function listProposalsDetailed(profileDir: string): { proposals: Proposal[]; broken: string[] } {
  const dir = inboxDir(profileDir);
  const proposals: Proposal[] = [];
  const broken: string[] = [];
  for (const name of jsonFiles(dir)) {
    try {
      const r = Proposal.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (r.success && numOf(name) !== null) proposals.push(r.data);
      else broken.push(name);
    } catch {
      broken.push(name);
    }
  }
  proposals.sort((a, b) => numOf(a.pid)! - numOf(b.pid)!);
  return { proposals, broken: broken.sort() };
}

export function listProposals(profileDir: string): Proposal[] {
  return listProposalsDetailed(profileDir).proposals;
}

function nextNumber(profileDir: string): number {
  const nums = [...jsonFiles(inboxDir(profileDir)), ...jsonFiles(archiveDir(profileDir))].map(numOf).filter((n): n is number => n !== null);
  return 1 + Math.max(0, ...nums);
}

export function writeProposal(profileDir: string, p: Omit<Proposal, "pid" | "created">, now: Date = new Date()): Proposal {
  const dir = inboxDir(profileDir);
  mkdirSync(dir, { recursive: true });
  const slug = p.entry?.id ?? (p.kind === "skills" ? "skills" : "about");
  for (;;) {
    const pid = `${nextNumber(profileDir)}-${slug}`;
    const full = Proposal.parse({ ...p, pid, created: now.toISOString() });
    try {
      writeFileSync(join(dir, `${pid}.json`), JSON.stringify(full, null, 2) + "\n", { flag: "wx" });
      return full;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

export function findProposal(profileDir: string, ref: string): Proposal {
  const all = listProposals(profileDir);
  const hit = /^\d+$/.test(ref) ? all.find((p) => numOf(p.pid) === Number(ref)) : all.find((p) => p.pid === ref);
  if (!hit) throw new UserError(`No pending proposal "${ref}"`, "resumely profile review --list");
  return hit;
}

export function saveProposal(profileDir: string, p: Proposal): void {
  writeFileSync(join(inboxDir(profileDir), `${p.pid}.json`), JSON.stringify(Proposal.parse(p), null, 2) + "\n");
}

export function archiveProposal(profileDir: string, p: Proposal, decision: NonNullable<Proposal["decision"]>): void {
  mkdirSync(archiveDir(profileDir), { recursive: true });
  writeFileSync(join(archiveDir(profileDir), `${p.pid}.json`), JSON.stringify(Proposal.parse({ ...p, decision }), null, 2) + "\n");
  const pending = join(inboxDir(profileDir), `${p.pid}.json`);
  if (existsSync(pending)) unlinkSync(pending);
}

export const ID_PREFIX: Record<EntryType, string> = {
  experience: "exp",
  project: "proj",
  education: "edu",
  award: "award",
  publication: "pub",
  volunteering: "vol",
  certification: "cert",
  other: "extra",
};

export function newEntryId(type: EntryType, e: { title: string; org?: string }, taken: Set<string>): string {
  const useOrg = type === "experience" || type === "education";
  const base = `${ID_PREFIX[type]}-${slugify((useOrg ? e.org : undefined) ?? e.title, 30)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function takenIds(profileDir: string, profile: Profile): Set<string> {
  const ids = new Set(profile.entries.map((e) => e.id));
  for (const p of listProposals(profileDir)) if (p.kind === "new" && p.entry) ids.add(p.entry.id);
  return ids;
}

const monthNow = (d: Date) => d.toISOString().slice(0, 7);

function overlaps(a: { start?: string; end?: string }, b: { start?: string; end?: string }, now: Date): boolean {
  const lo = "0000-00";
  const hi = "9999-99";
  const end = (x?: string) => (x === "present" ? monthNow(now) : (x ?? hi));
  return (a.start ?? lo) <= end(b.end) && (b.start ?? lo) <= end(a.end);
}

export function findLikelyDuplicate(e: DraftEntry, entries: Entry[], now: Date = new Date()): Entry | null {
  const sameKind = entries.filter((x) => x.type === e.type);
  if (e.type === "experience" || e.type === "education") {
    const org = slugify(e.org ?? "");
    return (
      sameKind.find((x) => slugify(x.org ?? "") === org && (slugify(x.title) === slugify(e.title) || overlaps(e, x, now))) ?? null
    );
  }
  return sameKind.find((x) => slugify(x.title) === slugify(e.title)) ?? null;
}

function stripId(e: Record<string, unknown>) {
  const { id: _id, body: _body, ...rest } = e;
  return rest;
}

export function stageDrafts(
  profileDir: string,
  profile: Profile,
  drafts: Draft[],
  extra: { skills?: Record<string, string[]>; about?: AboutChange | null },
  source: Proposal["source"],
  now: Date = new Date(),
): { staged: Proposal[]; skipped: string[] } {
  const staged: Proposal[] = [];
  const skipped: string[] = [];
  const taken = takenIds(profileDir, profile);
  let pending = listProposals(profileDir);
  const stage = (p: Omit<Proposal, "pid" | "created">) => {
    const w = writeProposal(profileDir, p, now);
    staged.push(w);
    pending = [...pending, w];
  };

  for (const d of drafts) {
    const entry = DraftEntry.parse(d.entry);
    let kind = d.kind;
    let target_id = d.target_id;
    if (kind === "new") {
      const dup = findLikelyDuplicate(entry, profile.entries, now);
      if (dup) {
        kind = "duplicate";
        target_id = dup.id;
      }
    }
    if (kind === "update") {
      const liveEntry = profile.entries.find((x) => x.id === target_id);
      if (liveEntry && sameAsLive({ ...entry, id: target_id! }, liveEntry)) {
        skipped.push(`${target_id}: no changes`);
        continue;
      }
    }
    const same = pending.find(
      (p) => p.kind === kind && p.target_id === target_id && p.entry && isDeepStrictEqual(stripId(p.entry), stripId(entry)),
    );
    if (same) {
      skipped.push(`${entry.title}: already in the inbox (${same.pid})`);
      continue;
    }
    let id: string;
    if (kind === "new") {
      id = newEntryId(entry.type, entry, taken);
      taken.add(id);
    } else {
      id = target_id!;
    }
    stage({
      kind,
      source,
      rationale: d.rationale,
      flags: d.flags ?? [],
      ...(target_id ? { target_id } : {}),
      entry: { ...entry, id },
    });
  }

  if (extra.skills) {
    const known = new Set(Object.values(profile.skills).flat().map(normaliseSkill));
    const skills: Record<string, string[]> = {};
    for (const [group, items] of Object.entries(extra.skills)) {
      const keep = items.filter((i) => !known.has(normaliseSkill(i)));
      if (keep.length) skills[group] = keep;
    }
    if (Object.keys(skills).length) {
      const same = pending.find((p) => p.kind === "skills" && isDeepStrictEqual(p.skills, skills));
      if (same) skipped.push(`skills: already in the inbox (${same.pid})`);
      else stage({ kind: "skills", source, rationale: "", flags: [], skills });
    }
  }

  if (extra.about) {
    const live: Record<string, unknown> = { ...profile.about, summary: profile.about.body };
    const about: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra.about)) {
      if (v !== undefined && !isDeepStrictEqual(v, live[k])) about[k] = v;
    }
    if (Object.keys(about).length) {
      const same = pending.find((p) => p.kind === "about" && isDeepStrictEqual(p.about, about));
      if (same) skipped.push(`about: already in the inbox (${same.pid})`);
      else stage({ kind: "about", source, rationale: "", flags: [], about: about as AboutChange });
    }
  }
  return { staged, skipped };
}

/** What `apply` should know before starting: an empty profile is an error, pending proposals a warning. */
export function profileReadiness(profileDir: string): { error?: UserError; warnings: string[] } {
  const warnings: string[] = [];
  const pending = listProposals(profileDir).length;
  if (pending) warnings.push(`${pending} profile proposals awaiting review (resumely profile review)`);
  if (loadProfile(profileDir).entries.length === 0) {
    return { error: new UserError("Your profile has no entries yet", "Run: resumely profile import <resume.pdf>, then resumely profile review"), warnings };
  }
  return { warnings };
}
