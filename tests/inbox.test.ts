import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";
import { UserError } from "../src/errors";
import { loadProfile } from "../src/profile/load";
import { archiveProposal, findLikelyDuplicate, findProposal, inboxDir, listProposals, listProposalsDetailed, newEntryId, stageDrafts, writeProposal } from "../src/profile/inbox";
import type { Draft, DraftEntry } from "../src/profile/proposal";

const fx = join(import.meta.dir, "fixtures");
let root: string;
let pdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-inbox-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  pdir = layout(root).profile;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const draft = (o: Partial<DraftEntry> & { title: string }): DraftEntry => ({ type: "experience", skills: [], tags: [], bullets: [], context: "", ...o });
const src = { kind: "import", ref: "cv.pdf" } as const;
const newEntry = (id = "exp-acme-robotics") => ({ kind: "new" as const, source: src, rationale: "r", flags: [], entry: { ...draft({ title: "Eng", org: "Acme" }), id } });

describe("newEntryId", () => {
  test("prefix, slug and uniqueness", () => {
    expect(newEntryId("experience", { title: "Staff Engineer", org: "Acme Robotics" }, new Set())).toBe("exp-acme-robotics");
    expect(newEntryId("experience", { title: "Staff Engineer", org: "Acme Robotics" }, new Set(["exp-acme-robotics"]))).toBe("exp-acme-robotics-2");
    expect(newEntryId("project", { title: "RouteKit" }, new Set())).toBe("proj-routekit");
    expect(newEntryId("award", { title: "Best Paper — ICSE" }, new Set())).toBe("award-best-paper-icse");
    expect(newEntryId("education", { title: "B.Sc.", org: "Université de Montréal" }, new Set())).toBe("edu-universite-de-montreal");
  });
});

describe("store", () => {
  test("pids are sequential and never reused", () => {
    const a = writeProposal(pdir, newEntry());
    const b = writeProposal(pdir, { kind: "skills", source: src, rationale: "", flags: [], skills: { X: ["y"] } });
    expect([a.pid, b.pid]).toEqual(["1-exp-acme-robotics", "2-skills"]);
    archiveProposal(pdir, b, { kind: "rejected", at: "now" });
    expect(existsSync(join(inboxDir(pdir), "archive", "2-skills.json"))).toBe(true);
    expect(writeProposal(pdir, newEntry("exp-other")).pid).toBe("3-exp-other");
    expect(listProposals(pdir).map((p) => p.pid)).toEqual(["1-exp-acme-robotics", "3-exp-other"]);
  });
  test("findProposal by pid or number", () => {
    writeProposal(pdir, newEntry());
    expect(findProposal(pdir, "1")).toEqual(findProposal(pdir, "1-exp-acme-robotics"));
    expect(() => findProposal(pdir, "9")).toThrow(UserError);
  });
  test("corrupt files are reported, not fatal", () => {
    writeProposal(pdir, newEntry());
    writeFileSync(join(inboxDir(pdir), "7-x.json"), "{nope");
    const r = listProposalsDetailed(pdir);
    expect(r.broken).toEqual(["7-x.json"]);
    expect(r.proposals).toHaveLength(1);
  });
  test("loader ignores the inbox", () => {
    writeProposal(pdir, newEntry());
    expect(loadProfile(pdir).entries).toHaveLength(5);
  });
});

describe("findLikelyDuplicate", () => {
  const entries = () => loadProfile(pdir).entries;
  test("matches by org and title or overlap", () => {
    expect(findLikelyDuplicate(draft({ title: "Senior Software Engineer", org: "Atlas Labs" }), entries())?.id).toBe("exp-atlas-labs");
    expect(findLikelyDuplicate(draft({ title: "Other", org: "Atlas Labs", start: "2020-01", end: "2020-02" }), entries())).toBeNull();
    expect(findLikelyDuplicate(draft({ title: "Other", org: "Atlas Labs", start: "2024-01", end: "2024-02" }), entries())?.id).toBe("exp-atlas-labs");
    expect(findLikelyDuplicate(draft({ type: "project", title: "routekit" }), entries())?.id).toBe("proj-routekit");
    expect(findLikelyDuplicate(draft({ title: "Eng", org: "Acme" }), entries())).toBeNull();
  });
});

describe("stageDrafts", () => {
  const drafts: Draft[] = [
    { kind: "new", entry: draft({ title: "Engineer", org: "Acme" }), rationale: "a" },
    { kind: "new", entry: draft({ title: "Senior Software Engineer", org: "Atlas Labs" }), rationale: "b" },
  ];
  const extra = { skills: { Languages: ["go", "Rust"] }, about: { name: "Jordan Example", headline: "Backend engineer" } };
  test("stages, classifies and is idempotent", () => {
    const profile = loadProfile(pdir);
    const r = stageDrafts(pdir, profile, drafts, extra, src);
    expect(r.staged.map((p) => p.kind)).toEqual(["new", "duplicate", "skills", "about"]);
    expect(r.staged[0]!.entry!.id).toBe("exp-acme");
    expect(r.staged[1]!.target_id).toBe("exp-atlas-labs");
    expect(r.staged[1]!.entry!.id).toBe("exp-atlas-labs");
    expect(r.staged[2]!.skills).toEqual({ Languages: ["Rust"] });
    expect(r.staged[3]!.about).toEqual({ headline: "Backend engineer" });
    const again = stageDrafts(pdir, profile, drafts, extra, src);
    expect(again.staged).toHaveLength(0);
    expect(again.skipped.join("\n")).toContain("already in the inbox");
  });
});

describe("stageDrafts no-op updates", () => {
  test("an update equal to the live entry is skipped", () => {
    const profile = loadProfile(pdir);
    const live = profile.entries.find((e) => e.id === "proj-routekit")!;
    const same = draft({ type: "project", title: live.title, org: live.org, location: live.location, start: live.start, end: live.end as DraftEntry["end"], url: live.url, skills: live.skills, tags: live.tags, bullets: [] });
    const r = stageDrafts(pdir, profile, [{ kind: "update", target_id: "proj-routekit", entry: { ...same, context: live.body }, rationale: "r" }], {}, src);
    expect(r.staged).toHaveLength(0);
    expect(r.skipped).toContain("proj-routekit: no changes");
  });
});
