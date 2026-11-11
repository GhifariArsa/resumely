import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";
import { UserError } from "../src/errors";
import { buildAgentPayload } from "../src/profile/context";
import { loadAbout, loadProfile, parseEntryText } from "../src/profile/load";
import { inboxDir, writeProposal } from "../src/profile/inbox";
import type { DraftEntry } from "../src/profile/proposal";
import { unifiedDiff } from "../src/profile/diff";
import { acceptProposal, entryMarkdown, previewProposal, rejectProposal } from "../src/profile/accept";

const fx = join(import.meta.dir, "fixtures");
let root: string;
let pdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-accept-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  pdir = layout(root).profile;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const draft = (o: Partial<DraftEntry> & { title: string }): DraftEntry => ({ type: "experience", skills: [], tags: [], bullets: [], context: "", ...o });
const src = { kind: "import", ref: "cv.pdf" } as const;
const mk = (kind: "new" | "update" | "duplicate", id: string, e: Partial<DraftEntry> & { title: string }, target?: string) =>
  writeProposal(pdir, { kind, source: src, rationale: "r", flags: [], ...(target ? { target_id: target } : {}), entry: { ...draft(e), id } });
const archived = (pid: string) => JSON.parse(readFileSync(join(inboxDir(pdir), "archive", `${pid}.json`), "utf8"));

describe("unifiedDiff", () => {
  test("changes and equality", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", { from: "x", to: "y" });
    expect(d).toContain("--- x");
    expect(d).toContain("+++ y");
    expect(d).toContain("-b");
    expect(d).toContain("+B");
    expect(unifiedDiff("a\n", "a\n", { from: "x", to: "y" })).toBe("");
  });
});

describe("entryMarkdown", () => {
  test("renders and round-trips", () => {
    const md = entryMarkdown({ ...draft({ title: "Eng", org: "Acme", start: "2024-05", bullets: ["Cut costs 30%"], context: "Story." }), id: "exp-acme" });
    expect(md).toContain("## Highlights");
    expect(md).toContain("- Cut costs 30%");
    expect(md).toContain("## Context");
    expect(parseEntryText(md, "x.md").start).toBe("2024-05");
  });
});

describe("acceptProposal", () => {
  test("new writes the file and archives", () => {
    const p = mk("new", "exp-acme", { title: "Engineer", org: "Acme", bullets: ["Did things"] });
    const r = acceptProposal(pdir, p);
    expect(r.file).toBe("experience/acme.md");
    expect(loadProfile(pdir).entries).toHaveLength(6);
    expect(archived(p.pid).decision.kind).toBe("accepted");
    expect(existsSync(join(inboxDir(pdir), `${p.pid}.json`))).toBe(false);
  });
  test("new with a taken filename gets -2", () => {
    writeFileSync(join(pdir, "experience", "acme.md"), "---\nid: exp-other\ntitle: X\n---\n");
    const r = acceptProposal(pdir, mk("new", "exp-acme", { title: "Engineer", org: "Acme" }));
    expect(r.file).toBe("experience/acme-2.md");
  });
  test("new whose id got taken is reassigned", () => {
    const p = mk("new", "exp-acme", { title: "Engineer", org: "Acme" });
    acceptProposal(pdir, mk("new", "exp-acme-x", { title: "Engineer", org: "Other Co" }));
    writeFileSync(join(pdir, "experience", "zz.md"), "---\nid: exp-acme\ntitle: X\n---\n");
    const r = acceptProposal(pdir, p);
    expect(r.id).toBe("exp-acme-2");
  });
  test("update preserves private sections", () => {
    const p = mk("update", "exp-atlas-labs", { title: "Senior Software Engineer", org: "Atlas Labs", start: "2023-03", end: "present", skills: ["TypeScript"], bullets: ["Brand new bullet"] }, "exp-atlas-labs");
    expect(previewProposal(pdir, p)).toContain("--- a/profile/experience/atlas-labs.md");
    const r = acceptProposal(pdir, p);
    expect(r.file).toBe("experience/atlas-labs.md");
    const text = readFileSync(join(pdir, r.file), "utf8");
    expect(text).toContain("## Private");
    expect(text).toContain("Compensation: 145000 CAD plus equity.");
    expect(text).toContain("Brand new bullet");
    const profile = loadProfile(pdir);
    expect(profile.entries.find((e) => e.id === "exp-atlas-labs")!.body).toContain("Brand new bullet");
    expect(JSON.stringify(buildAgentPayload(profile))).not.toContain("Compensation");
  });
  test("update keeps unknown frontmatter keys and comments", () => {
    const f = join(pdir, "experience", "atlas-labs.md");
    const live = readFileSync(f, "utf8");
    writeFileSync(f, live.replace("org: Atlas Labs\n", "org: Atlas Labs\n# keep me\nvisibility: internal\n").replace("tags: [backend, frontend]\n", ""));
    const p = mk("update", "exp-atlas-labs", { title: "Staff Engineer", org: "Atlas Labs", start: "2023-03", end: "present", skills: ["TypeScript"], bullets: ["Fresh"] }, "exp-atlas-labs");
    acceptProposal(pdir, p);
    const text = readFileSync(f, "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("visibility: internal");
    expect(text).toContain("title: Staff Engineer");
    expect(text).toContain("Compensation: 145000 CAD plus equity.");
    expect(loadProfile(pdir).entries.find((e) => e.id === "exp-atlas-labs")!.title).toBe("Staff Engineer");
  });
  test("duplicate needs --as", () => {
    const p = mk("duplicate", "exp-atlas-labs", { title: "Senior Software Engineer", org: "Atlas Labs", bullets: ["x"] }, "exp-atlas-labs");
    try {
      acceptProposal(pdir, p);
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as UserError).hint).toContain("--as update");
    }
    const r = acceptProposal(pdir, p, { as: "new" });
    expect(r.id).toBe("exp-atlas-labs-2");
    expect(r.file).toBe("experience/atlas-labs-2.md");
    expect(loadProfile(pdir).entries).toHaveLength(6);
  });
  test("update with missing target throws and writes nothing", () => {
    const p = mk("update", "exp-atlas-labs", { title: "Senior Software Engineer", org: "Atlas Labs" }, "exp-atlas-labs");
    unlinkSync(join(pdir, "experience", "atlas-labs.md"));
    expect(() => acceptProposal(pdir, p)).toThrow("no longer exists");
    expect(existsSync(join(pdir, "experience", "atlas-labs.md"))).toBe(false);
    expect(existsSync(join(inboxDir(pdir), "archive", `${p.pid}.json`))).toBe(false);
  });
  test("skills merge keeps comments", () => {
    const f = join(pdir, "skills.yaml");
    writeFileSync(f, "# my skills\n" + readFileSync(f, "utf8"));
    const p = writeProposal(pdir, { kind: "skills", source: src, rationale: "", flags: [], skills: { Languages: ["Rust", "go"], Cloud: ["AWS"] } });
    expect(acceptProposal(pdir, p).file).toBe("skills.yaml");
    const text = readFileSync(f, "utf8");
    expect(text).toContain("# my skills");
    const s = loadProfile(pdir).skills;
    expect(s.Languages).toEqual(["TypeScript", "Python", "Go", "SQL", "Rust"]);
    expect(s.Cloud).toEqual(["AWS"]);
    expect(previewProposal(pdir, p)).toContain("+ Cloud: AWS");
  });
  test("about keeps private and merges links", () => {
    const p = writeProposal(pdir, { kind: "about", source: src, rationale: "", flags: [], about: { headline: "Backend engineer", links: [{ label: "Site", url: "https://jordan.dev" }] } });
    expect(previewProposal(pdir, p)).toContain("about.md");
    expect(acceptProposal(pdir, p).file).toBe("about.md");
    const a = loadAbout(pdir);
    expect(a.privateKeys).toBe(1);
    expect(a.about.headline).toBe("Backend engineer");
    expect(a.about.links).toHaveLength(3);
  });
  test("about summary replaces body", () => {
    const p = writeProposal(pdir, { kind: "about", source: src, rationale: "", flags: [], about: { summary: "New summary." } });
    acceptProposal(pdir, p);
    expect(loadAbout(pdir).about.body).toBe("New summary.");
  });
  test("reject archives and leaves profile", () => {
    const p = mk("new", "exp-acme", { title: "Engineer", org: "Acme" });
    rejectProposal(pdir, p);
    expect(archived(p.pid).decision.kind).toBe("rejected");
    expect(loadProfile(pdir).entries).toHaveLength(5);
  });
});

describe("final review fixes", () => {
  test("C1: an about summary replaces only the prose before the first ## heading", () => {
    const f = join(pdir, "about.md");
    const live = readFileSync(f, "utf8");
    writeFileSync(f, live.replace(/\n\n[^\n]*\n$/, "\n\nOld summary.\n\n## Career goals\n\nLead a platform team.\n\n## Private\n\nsecret-note\n\n## Preferences\n\nRemote only.\n"));
    const p = writeProposal(pdir, { kind: "about", source: src, rationale: "", flags: [], about: { summary: "New summary." } });
    acceptProposal(pdir, p);
    const text = readFileSync(f, "utf8");
    expect(text).not.toContain("Old summary.");
    for (const s of ["New summary.", "## Career goals", "Lead a platform team.", "## Private", "secret-note", "## Preferences", "Remote only."]) expect(text).toContain(s);
    expect(text.indexOf("New summary.")).toBeLessThan(text.indexOf("## Career goals"));
  });

  test("I1: an update keeps live sections other than Highlights and Context", () => {
    const f = join(pdir, "experience", "atlas-labs.md");
    writeFileSync(f, readFileSync(f, "utf8") + "\n## Stack notes\n\nBun, Postgres.\n");
    const p = mk("update", "exp-atlas-labs", { title: "Senior Software Engineer", org: "Atlas Labs", location: "Montreal, QC", start: "2023-03", end: "present", skills: ["TypeScript"], bullets: ["Brand new bullet"] }, "exp-atlas-labs");
    expect(previewProposal(pdir, p)).not.toContain("-## Stack notes");
    acceptProposal(pdir, p);
    const text = readFileSync(f, "utf8");
    expect(text).toContain("Brand new bullet");
    expect(text).not.toContain("Led a team of 4");
    for (const s of ["## Stack notes", "Bun, Postgres.", "## Notes", "Shipped the new onboarding flow", "Compensation: 145000 CAD plus equity."]) expect(text).toContain(s);
  });

  test("I2: private sections from a review edit are written at accept and kept out of the inbox", () => {
    const p = mk("update", "exp-atlas-labs", { title: "Senior Software Engineer", org: "Atlas Labs", start: "2023-03", end: "present", bullets: ["Fresh"] }, "exp-atlas-labs");
    acceptProposal(pdir, p, { privateText: "## Private\n\nRaise promised: 999k.\n" });
    const text = readFileSync(join(pdir, "experience", "atlas-labs.md"), "utf8");
    expect(text).toContain("Raise promised: 999k.");
    expect(text).toContain("Compensation: 145000 CAD plus equity.");
    expect(readFileSync(join(inboxDir(pdir), "archive", `${p.pid}.json`), "utf8")).not.toContain("999k");
    expect(JSON.stringify(buildAgentPayload(loadProfile(pdir)))).not.toContain("999k");
    const n = mk("new", "exp-acme", { title: "Engineer", org: "Acme", bullets: ["Did things"] });
    const r = acceptProposal(pdir, n, { privateText: "## Private\n\nLeft over a dispute.\n" });
    expect(readFileSync(join(pdir, r.file), "utf8")).toContain("Left over a dispute.");
    expect(loadProfile(pdir).entries.find((e) => e.id === "exp-acme")!.privateLines).toBe(1);
  });

  test("I3: a new proposal that duplicates a live entry needs --as at accept time", () => {
    const a = mk("new", "exp-acme-robotics", { title: "Senior Engineer", org: "Acme Robotics", start: "2024-01", end: "present", bullets: ["A"] });
    const b = mk("new", "exp-acme-robotics-2", { title: "Sr. Engineer", org: "Acme Robotics", start: "2024-01", end: "present", bullets: ["B"] });
    acceptProposal(pdir, a);
    expect(() => acceptProposal(pdir, b)).toThrow("possible duplicate of exp-acme-robotics");
    expect(existsSync(join(pdir, "experience", "acme-robotics-2.md"))).toBe(false);
    const r = acceptProposal(pdir, b, { as: "update" });
    expect(r.file).toBe("experience/acme-robotics.md");
    expect(loadProfile(pdir).entries.filter((e) => e.org === "Acme Robotics").map((e) => e.title)).toEqual(["Sr. Engineer"]);
    expect(archived(b.pid).decision.as).toBe("update");
    const c = mk("new", "exp-acme-robotics-3", { title: "Senior Engineer", org: "Acme Robotics", start: "2024-01", end: "present" });
    expect(acceptProposal(pdir, c, { as: "new" }).file).toBe("experience/acme-robotics-3.md");
  });

  test("M2: a broken skills.yaml is a UserError at accept", () => {
    writeFileSync(join(pdir, "skills.yaml"), "Languages: [oops\n");
    const p = writeProposal(pdir, { kind: "skills", source: src, rationale: "", flags: [], skills: { Languages: ["Rust"] } });
    expect(() => acceptProposal(pdir, p)).toThrow(UserError);
    expect(readFileSync(join(pdir, "skills.yaml"), "utf8")).toBe("Languages: [oops\n");
  });
});

describe("integration A: partial updates keep live data", () => {
  const atlas = () => join(pdir, "experience", "atlas-labs.md");
  const northwind = () => join(pdir, "experience", "northwind.md");
  const live = (id: string) => loadProfile(pdir).entries.find((e) => e.id === id)!;

  test("A1: frontmatter keys the update leaves out (and empty skills/tags) keep their live values", () => {
    const p = mk("update", "exp-atlas-labs", { title: "Staff Engineer", bullets: ["Brand new bullet"] }, "exp-atlas-labs");
    expect(previewProposal(pdir, p)).not.toContain("-location: Montreal, QC");
    acceptProposal(pdir, p);
    const e = live("exp-atlas-labs");
    expect(e.title).toBe("Staff Engineer");
    expect(e.org).toBe("Atlas Labs");
    expect(e.location).toBe("Montreal, QC");
    expect(e.start).toBe("2023-03");
    expect(e.end).toBe("present");
    expect(e.skills).toEqual(["TypeScript", "React", "PostgreSQL"]);
    expect(e.tags).toEqual(["backend", "frontend"]);
    expect(readFileSync(atlas(), "utf8")).not.toContain("skills: []");
  });

  test("A1: explicit values replace live ones, including a listed skills array", () => {
    const p = mk("update", "exp-atlas-labs", { title: "Senior Software Engineer", location: "Remote", skills: ["TypeScript", "Go"], bullets: ["x"] }, "exp-atlas-labs");
    acceptProposal(pdir, p);
    const e = live("exp-atlas-labs");
    expect(e.location).toBe("Remote");
    expect(e.skills).toEqual(["TypeScript", "Go"]);
    expect(e.tags).toEqual(["backend", "frontend"]);
  });

  test("A1: an update with no bullets or context keeps the live body", () => {
    acceptProposal(pdir, mk("update", "exp-atlas-labs", { title: "Staff Engineer" }, "exp-atlas-labs"));
    expect(live("exp-atlas-labs").body).toContain("Led a team of 4");
    acceptProposal(pdir, mk("update", "proj-ledgerly", { type: "project", title: "Ledgerly v2" }, "proj-ledgerly"));
    expect(live("proj-ledgerly").body).toContain("Open-source double-entry bookkeeping library.");
  });

  test("A2: the live preamble above ## Highlights survives an update", () => {
    writeFileSync(atlas(), readFileSync(atlas(), "utf8").replace("\n## Highlights", "\nLed billing at a fintech scale-up.\n\n## Highlights"));
    acceptProposal(pdir, mk("update", "exp-atlas-labs", { title: "Senior Software Engineer", bullets: ["Brand new bullet"] }, "exp-atlas-labs"));
    const text = readFileSync(atlas(), "utf8");
    expect(text).toContain("Led billing at a fintech scale-up.");
    expect(text.indexOf("Led billing")).toBeLessThan(text.indexOf("## Highlights"));
    expect(text).toContain("Brand new bullet");
    expect(text).not.toContain("Led a team of 4");
  });

  test("A2: bullets kept in the preamble (no ## Highlights) are replaced by the proposal's Highlights", () => {
    acceptProposal(pdir, mk("update", "exp-northwind", { title: "Software Engineer", bullets: ["New northwind bullet"] }, "exp-northwind"));
    const text = readFileSync(northwind(), "utf8");
    expect(text).toContain("## Highlights\n\n- New northwind bullet");
    expect(text).not.toContain("Built internal REST services");
  });

  test("A3: Highlights replacing preamble bullets go where the bullets were, above other sections", () => {
    writeFileSync(northwind(), readFileSync(northwind(), "utf8") + "\n## Notes\n\nOn-call lead for a year.\n");
    acceptProposal(pdir, mk("update", "exp-northwind", { title: "Software Engineer", bullets: ["New northwind bullet"] }, "exp-northwind"));
    const text = readFileSync(northwind(), "utf8");
    expect(text).not.toContain("Built internal REST services");
    expect(text).toContain("On-call lead for a year.");
    expect(text.indexOf("## Highlights")).toBeLessThan(text.indexOf("## Notes"));
  });
});
