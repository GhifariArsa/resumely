import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";
import { UserError } from "../src/errors";
import { dateIssues, formatLint, lintProfile } from "../src/profile/lint";

const fx = join(import.meta.dir, "fixtures");
const now = new Date("2026-11-11");
let root: string;
let pdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-lint-"));
  initDataRoot(root);
  rmSync(layout(root).profile, { recursive: true, force: true });
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  pdir = layout(root).profile;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lint = () => lintProfile(root, { now });

describe("lintProfile", () => {
  test("Jordan fixture: no errors, one outcome-less bullet, no unused-entry", () => {
    const issues = lint();
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const outcome = issues.filter((i) => i.code === "outcome-less-bullet");
    expect(outcome).toHaveLength(1);
    expect(outcome[0]!.entry_id).toBe("exp-northwind");
    expect(outcome[0]!.message).toContain('Migrated a legacy Python monolith');
    expect(issues.some((i) => i.code === "unused-entry")).toBe(false);
  });

  test("throws UserError when root is not a data root", () => {
    expect(() => lintProfile(join(root, "nope"))).toThrow(UserError);
  });

  test("unused-entry when a trace exists", () => {
    const v = join(root, "applications", "x", "resume", "v1");
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, "trace.json"), JSON.stringify([{ entry_ids: ["exp-atlas-labs"] }]));
    const unused = lint().filter((i) => i.code === "unused-entry").map((i) => i.entry_id).sort();
    expect(unused).toEqual(["edu-udem", "exp-northwind", "proj-ledgerly", "proj-routekit"]);
  });

  test("unreadable trace is ignored (and counts as no trace)", () => {
    const v = join(root, "applications", "x", "resume", "v1");
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, "trace.json"), "{not json");
    const unused = lint().filter((i) => i.code === "unused-entry").map((i) => i.entry_id).sort();
    expect(unused).toEqual([]);
  });

  test("a broken entry gives one parse-error and the rest is still linted", () => {
    writeFileSync(join(pdir, "projects", "routekit.md"), "---\nid: [unclosed\n---\n");
    const issues = lint();
    const pe = issues.filter((i) => i.code === "parse-error");
    expect(pe).toHaveLength(1);
    expect(pe[0]!.file).toBe("profile/projects/routekit.md");
    expect(pe[0]!.severity).toBe("error");
    expect(issues.some((i) => i.code === "outcome-less-bullet" && i.entry_id === "exp-northwind")).toBe(true);
  });

  test("parse-error scrapes the id when present", () => {
    writeFileSync(join(pdir, "projects", "routekit.md"), "---\nid: proj-routekit\ntitle: \n---\n");
    const pe = lint().find((i) => i.code === "parse-error")!;
    expect(pe.entry_id).toBe("proj-routekit");
  });

  test("duplicate-id on the second file in sorted order (atlas-copy.md sorts before atlas-labs.md)", () => {
    cpSync(join(pdir, "experience", "atlas-labs.md"), join(pdir, "experience", "atlas-copy.md"));
    const d = lint().filter((i) => i.code === "duplicate-id");
    expect(d).toHaveLength(1);
    expect(d[0]!.file).toBe("profile/experience/atlas-labs.md");
    expect(d[0]!.severity).toBe("error");
    expect(d[0]!.message).toContain("profile/experience/atlas-copy.md");
  });

  test("duplicate-skill across categories", () => {
    writeFileSync(join(pdir, "skills.yaml"), "Languages: [Go, SQL]\nTools: [go]\n");
    const d = lint().filter((i) => i.code === "duplicate-skill");
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain("Languages");
    expect(d[0]!.message).toContain("Tools");
    expect(d[0]!.entry_id).toBeNull();
    expect(d[0]!.file).toBe("profile/skills.yaml");
  });

  test("invalid skills.yaml is a parse-error", () => {
    writeFileSync(join(pdir, "skills.yaml"), "Languages: [a\n");
    const pe = lint().find((i) => i.code === "parse-error")!;
    expect(pe.file).toBe("profile/skills.yaml");
  });

  test("pending proposals", () => {
    mkdirSync(join(pdir, ".inbox"), { recursive: true });
    writeFileSync(join(pdir, ".inbox", "1-x.json"), "{}");
    const p = lint().find((i) => i.code === "pending-proposals")!;
    expect(p.message).toBe("1 proposal awaiting review");
    expect(p.file).toBe("profile/.inbox");
    expect(p.entry_id).toBeNull();
  });

  test("private-heading warning", () => {
    const f = join(pdir, "projects", "routekit.md");
    writeFileSync(f, readFileSync(f, "utf8") + "\n### Private notes\n\nx\n");
    expect(lint().some((i) => i.code === "private-heading")).toBe(true);
  });

  test("errors sort before warnings", () => {
    cpSync(join(pdir, "experience", "atlas-labs.md"), join(pdir, "experience", "atlas-copy.md"));
    const sev = lint().map((i) => i.severity);
    expect(sev.indexOf("warning")).toBeGreaterThan(sev.lastIndexOf("error"));
  });
});

describe("dateIssues", () => {
  const codes = (r: ReturnType<typeof dateIssues>) => r.map((i) => i.code);
  test("end before start", () => {
    expect(codes(dateIssues({ type: "experience", start: "2024-05", end: "2023-01" }, now))).toContain("end-before-start");
  });
  test("future start", () => {
    expect(codes(dateIssues({ type: "experience", start: "2027-01" }, now))).toContain("future-start");
  });
  test("future end: education exempt, experience warned", () => {
    expect(dateIssues({ type: "education", start: "2023-01", end: "2027-06" }, now)).toEqual([]);
    expect(codes(dateIssues({ type: "experience", start: "2023-01", end: "2027-06" }, now))).toEqual(["future-end"]);
  });
  test("missing dates", () => {
    expect(codes(dateIssues({ type: "experience" }, now))).toEqual(["missing-dates"]);
    expect(dateIssues({ type: "project" }, now)).toEqual([]);
  });
  test("current month is not future", () => {
    expect(dateIssues({ type: "experience", start: "2026-11", end: "2026-11" }, now)).toEqual([]);
  });
});

describe("formatLint", () => {
  test("good profile", () => expect(formatLint([])).toBe("profile looks good"));
  test("lines and summary", () => {
    const out = formatLint([
      { entry_id: "a", file: "profile/x.md", severity: "error", code: "c1", message: "m1" },
      { entry_id: null, file: "profile/y.md", severity: "warning", code: "c2", message: "m2" },
    ]);
    expect(out).toContain("a profile/x.md  c1: m1");
    expect(out).toContain("- profile/y.md  c2: m2");
    expect(out.trim().endsWith("1 errors, 1 warnings")).toBe(true);
  });
});
