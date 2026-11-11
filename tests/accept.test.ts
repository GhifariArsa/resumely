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
    acceptProposal(pdir, mk("new", "exp-acme-x", { title: "Engineer", org: "Acme" }));
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
