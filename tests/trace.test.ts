import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/profile/load";
import { buildAgentPayload } from "../src/profile/context";
import { CoverLetterContent, ResumeContent } from "../src/pipeline/schemas";
import { resolveResume, type EntryLike } from "../src/pipeline/resolve";
import { coverTrace, resumeTrace } from "../src/pipeline/version";
import { buildTrace, formatTrace } from "../src/application/trace";
import { UserError } from "../src/errors";

const fx = (p: string) => join(import.meta.dir, "fixtures", p);
const entries = (buildAgentPayload(loadProfile(fx("profile-jordan"))) as { entries: EntryLike[] }).entries;
const content = ResumeContent.parse(JSON.parse(readFileSync(fx("resume-content.json"), "utf8")));
const letter = CoverLetterContent.parse(JSON.parse(readFileSync(fx("cover-letter.json"), "utf8")));
const w = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));

let root: string;
let appDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trace-"));
  appDir = join(root, "acme-backend");
  for (const v of ["v1", "v2"]) {
    const d = join(appDir, "resume", v);
    mkdirSync(d, { recursive: true });
    w(join(d, "resume.json"), content);
    w(join(d, "trace.json"), resumeTrace(resolveResume(content, entries)));
    w(join(d, "checks.json"), {
      pages: 1, target_pages: 1, fill: 0.9, overflow: false, underflow: false, word_count: 300,
      keywords: { present: [], missed_in_profile: [], absent: ["Rust", "Kafka"] },
      ats: { status: "passed", problems: [] },
      fabrication_warnings: ['sections[0].items[1].bullets[2]: "Kafka" is not supported by the cited entries'],
      warnings: ["fabrication: x"],
    });
  }
  w(join(appDir, "resume", "v1", "resume.json"), { ...content, gaps: [{ requirement: "Rust", note: "No Rust experience in the profile; omitted." }] });
  const c = join(appDir, "cover-letter", "v1");
  mkdirSync(c, { recursive: true });
  w(join(c, "trace.json"), coverTrace(letter));
  w(join(c, "checks.json"), {
    keywords: { present: [], missed_in_profile: [], absent: ["Kafka"] },
    fabrication_warnings: ['paragraphs[2]: "Redis" is not supported by the cited entries'],
    warnings: [],
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("resume rows, flags, gaps and warnings", () => {
  const r = buildTrace(appDir, "resume", 1);
  expect(r.app).toBe("acme-backend");
  expect(r.rows.length).toBe(11);
  expect(r.rows[0]!.section).toBe("summary");
  expect(r.rows[0]!.entry_ids).toEqual(["exp-atlas-labs", "exp-northwind"]);
  expect(r.rows[1]!.section).toBe("Experience / Senior Software Engineer");
  expect(r.rows[6]!.flags).toEqual(['unsourced "Kafka"']);
  r.rows.forEach((row, i) => i !== 6 && expect(row.flags).toEqual([]));
  expect(r.gaps).toEqual(["Rust: No Rust experience in the profile; omitted.", "keyword not in profile: Kafka"]);
  expect(r.warnings).toContain("fabrication: x");
});

test("picks the highest version by default, or the one asked for", () => {
  expect(buildTrace(appDir, "resume").version).toBe(2);
  expect(buildTrace(appDir, "resume", 1).version).toBe(1);
  expect(() => buildTrace(appDir, "resume", 9)).toThrow("has no resume v9");
  expect(() => buildTrace(appDir, "cover-letter", 2)).toThrow(UserError);
  rmSync(join(appDir, "cover-letter"), { recursive: true });
  expect(() => buildTrace(appDir, "cover-letter")).toThrow("has no cover letter versions yet");
});

test("missing trace.json is a UserError naming the path; missing checks/resume become warnings", () => {
  const d = join(appDir, "resume", "v2");
  rmSync(join(d, "checks.json"));
  rmSync(join(d, "resume.json"));
  const r = buildTrace(appDir, "resume", 2);
  expect(r.rows.length).toBe(11);
  expect(r.warnings).toContain("missing checks.json");
  expect(r.warnings).toContain("missing resume.json");
  rmSync(join(d, "trace.json"));
  expect(() => buildTrace(appDir, "resume", 2)).toThrow(join(d, "trace.json"));
  writeFileSync(join(d, "trace.json"), "{nope");
  expect(() => buildTrace(appDir, "resume", 2)).toThrow(UserError);
});

test("unmapped fabrication warnings surface as warnings", () => {
  const p = join(appDir, "resume", "v1", "checks.json");
  const c = JSON.parse(readFileSync(p, "utf8"));
  c.fabrication_warnings.push('sections[9].items[0].bullets[0]: "Go" is not supported');
  w(p, c);
  expect(buildTrace(appDir, "resume", 1).warnings).toContain('sections[9].items[0].bullets[0]: "Go" is not supported');
});

test("cover rows", () => {
  const r = buildTrace(appDir, "cover-letter");
  expect(r.kind).toBe("cover-letter");
  expect(r.rows.map((x) => x.section)).toEqual(letter.paragraphs.map((_, i) => `paragraph ${i + 1}`));
  expect(r.rows[0]!.entry_ids).toEqual(["co-1", "co-2"]);
  expect(r.rows[2]!.flags).toEqual(['unsourced "Redis"']);
  expect(r.rows.filter((x) => x.flags.length).length).toBe(1);
  expect(r.rows.every((x) => x.basis === "direct")).toBe(true);
  expect(r.gaps).toEqual(["keyword not in profile: Kafka"]);
});

test("formatTrace", () => {
  const out = formatTrace(buildTrace(appDir, "resume", 1));
  expect(out).toContain("resume v1 — acme-backend");
  expect(out).toContain('! unsourced "Kafka"');
  expect(out).toContain("[direct]");
  expect(out).toContain("gaps:");
  expect(out).toContain("warnings:");
});
