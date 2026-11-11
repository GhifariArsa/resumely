import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

describe("final review fixes", () => {
  test("C1: an about summary equal to the prose before the first ## heading is not staged", () => {
    const f = join(pdir, "about.md");
    writeFileSync(f, readFileSync(f, "utf8").trimEnd() + "\n\n## Career goals\n\nLead a platform team.\n");
    const profile = loadProfile(pdir);
    const summary = "Full-stack engineer with 8 years of experience building data-heavy web products and developer tooling.";
    expect(stageDrafts(pdir, profile, [], { about: { summary: `  ${summary}\n` } }, src).staged).toHaveLength(0);
    expect(stageDrafts(pdir, profile, [], { about: { summary: "Different." } }, src).staged).toHaveLength(1);
  });

  test("I1: an update equal to the live Highlights is a no-op even with other live sections", () => {
    const profile = loadProfile(pdir);
    const live = profile.entries.find((e) => e.id === "exp-atlas-labs")!;
    const bullets = live.body.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    const e = draft({ title: live.title, org: live.org, location: live.location, start: live.start, end: live.end as DraftEntry["end"], skills: live.skills, tags: live.tags, bullets });
    const r = stageDrafts(pdir, profile, [{ kind: "update", target_id: "exp-atlas-labs", entry: e, rationale: "r" }], {}, src);
    expect(r.staged).toHaveLength(0);
    expect(r.skipped).toContain("exp-atlas-labs: no changes");
  });

  test("I3: a new draft resembling a pending new proposal is flagged", () => {
    const profile = loadProfile(pdir);
    const a = { kind: "new" as const, entry: draft({ title: "Senior Engineer", org: "Acme Robotics", start: "2024-01", end: "present" }), rationale: "a" };
    const b = { kind: "new" as const, entry: draft({ title: "Sr. Engineer", org: "Acme Robotics", start: "2024-01", end: "present" }), rationale: "b" };
    const r = stageDrafts(pdir, profile, [a, b], {}, src);
    expect(r.staged[0]!.flags).toEqual([]);
    expect(r.staged[1]!.flags.join("\n")).toContain(`possible duplicate of pending proposal ${r.staged[0]!.pid}`);
  });

  test("I7: an ambiguous numeric ref is a UserError listing the pids", () => {
    const a = writeProposal(pdir, newEntry("exp-a"));
    writeFileSync(join(inboxDir(pdir), "1-exp-b.json"), readFileSync(join(inboxDir(pdir), `${a.pid}.json`), "utf8").replaceAll("exp-a", "exp-b"));
    try {
      findProposal(pdir, "1");
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as UserError).message).toContain("1-exp-a");
      expect((e as UserError).message).toContain("1-exp-b");
    }
    expect(findProposal(pdir, "1-exp-b").pid).toBe("1-exp-b");
  });

  test("I7: concurrent writers get distinct numbers", async () => {
    const go = join(root, "go");
    const inbox = join(import.meta.dir, "../src/profile/inbox.ts");
    const n = 8;
    const procs = Array.from({ length: n }, (_, i) =>
      Bun.spawn(["bun", "-e", `
        import { existsSync } from "node:fs";
        import { writeProposal } from ${JSON.stringify(inbox)};
        while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(1);
        writeProposal(${JSON.stringify(pdir)}, { kind: "new", source: { kind: "manual", ref: "m" }, rationale: "", flags: [], entry: { type: "project", title: "P${i}", skills: [], tags: [], bullets: [], context: "", id: "proj-p${i}" } });
      `], { stdout: "ignore", stderr: "pipe" }),
    );
    await Bun.sleep(1500);
    writeFileSync(go, "");
    for (const p of procs) expect(await p.exited).toBe(0);
    const nums = listProposals(pdir).map((p) => p.pid.split("-")[0]);
    expect(nums).toHaveLength(n);
    expect(new Set(nums).size).toBe(n);
  }, 30_000);
});
