import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadProfile } from "../src/profile/load";
import { validateParsedJob, validateResume } from "../src/pipeline/validate";
import { jsonSchemaFor } from "../src/pipeline/schemas";

const profile = loadProfile(join(import.meta.dir, "fixtures/profile-jordan"));
const fixture = () => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/resume-content.json"), "utf8"));

const errs = (r: { ok: boolean; errors?: string[] }) => (r.ok ? [] : r.errors!);

test("valid fixture content passes", () => {
  const r = validateResume(fixture(), profile, "truthful");
  expect(r.ok).toBe(true);
});

test("unknown entry_id on item fails", () => {
  const c = fixture();
  c.sections[0].items[1].entry_id = "nope";
  const r = validateResume(c, profile, "truthful");
  expect(errs(r)).toContain('sections[0].items[1]: unknown entry id "nope"');
});

test("unknown bullet entry id fails", () => {
  const c = fixture();
  c.sections[1].items[0].bullets[1].entry_ids = ["proj-ledgerly", "ghost"];
  const r = validateResume(c, profile, "truthful");
  expect(errs(r).join("\n")).toContain('unknown entry id "ghost"');
});

test("inferred bullet rejected in truthful mode", () => {
  const c = fixture();
  c.sections[0].items[0].bullets[2].basis = "inferred";
  const r = validateResume(c, profile, "truthful");
  expect(errs(r)).toContain("sections[0].items[0].bullets[2]: inferred claims are not allowed in truthful mode");
});

test("missing entry_ids fails with path", () => {
  const c = fixture();
  delete c.sections[0].items[0].bullets[0].entry_ids;
  const r = validateResume(c, profile, "truthful");
  expect(r.ok).toBe(false);
  expect(errs(r).some((e) => e.startsWith("sections[0].items[0].bullets[0].entry_ids: "))).toBe(true);
});

test("empty sections fails", () => {
  const c = fixture();
  c.sections = [];
  const r = validateResume(c, profile, "truthful");
  expect(r.ok).toBe(false);
  expect(errs(r).join("\n")).toContain("sections");
});

test("non-object input fails", () => {
  expect(validateResume("hello", profile, "truthful").ok).toBe(false);
  expect(validateResume(null, profile, "truthful").ok).toBe(false);
  expect(validateParsedJob(42).ok).toBe(false);
});

test("parsed job validates", () => {
  const ok = validateParsedJob({ company: "Acme", role: "Dev", requirements: ["Go"], nice_to_haves: [], keywords: ["go"], language: "en" });
  expect(ok.ok).toBe(true);
  const bad = validateParsedJob({ company: "Acme" });
  expect(bad.ok).toBe(false);
  expect(errs(bad).some((e) => e.startsWith("role: "))).toBe(true);
});

test("jsonSchemaFor produces object schemas", () => {
  const s = jsonSchemaFor("resume") as any;
  expect(s.type).toBe("object");
  expect(s.required).toContain("sections");
  const j = jsonSchemaFor("parsed-job") as any;
  expect(j.required).toContain("requirements");
});

test("summary with empty entry_ids fails", () => {
  const c = fixture();
  c.summary.entry_ids = [];
  expect(validateResume(c, profile, "truthful").ok).toBe(false);
});

test("agent-written heading/subheading/dates are ignored (not part of the schema)", () => {
  const c = fixture();
  Object.assign(c.sections[0].items[0], { heading: "Principal Staff Engineer", subheading: "Google", dates: "2010 -- Present", location: "Mars" });
  const r = validateResume(c, profile, "truthful");
  expect(r.ok).toBe(true);
  const item = (r as { value: any }).value.sections[0].items[0];
  expect(Object.keys(item).sort()).toEqual(["bullets", "entry_id"]);
});

test("bullet must cite its item's entry", () => {
  const c = fixture();
  c.sections[0].items[0].bullets[1].entry_ids = ["exp-northwind"];
  expect(errs(validateResume(c, profile, "truthful"))).toContain('sections[0].items[0].bullets[1]: bullet must cite its item\'s entry "exp-atlas-labs"');
});

test("entry type must match section kind", () => {
  const c = fixture();
  c.sections[0].items[0].entry_id = "proj-ledgerly";
  c.sections[0].items[0].bullets.forEach((b: any) => (b.entry_ids = ["proj-ledgerly"]));
  expect(errs(validateResume(c, profile, "truthful"))).toContain('sections[0].items[0]: entry "proj-ledgerly" (project) does not belong in a experience section');
  const d = fixture();
  d.sections[2].kind = "extras";
  expect(errs(validateResume(d, profile, "truthful"))).toContain('sections[2].items[0]: entry "edu-udem" (education) does not belong in a extras section');
});

test("skills must come from the profile (normalised compare)", () => {
  const c = fixture();
  c.skills = [{ category: "Streaming", items: ["Kafka", "Rust", "  typescript ", "node.js", "GitHub   Actions", "React"] }];
  const e = errs(validateResume(c, profile, "truthful"));
  expect(e).toEqual(['skills[0].items[0]: "Kafka" is not in your profile', 'skills[0].items[1]: "Rust" is not in your profile']);
});

test("empty section items rejected", () => {
  const c = fixture();
  c.sections[2].items = [];
  expect(errs(validateResume(c, profile, "truthful")).some((e) => e.startsWith("sections[2].items: "))).toBe(true);
});

test("unsupported characters are rejected with code point; mapped symbols pass", () => {
  const c = fixture();
  c.sections[0].items[0].bullets[0].text = "Cut latency ≈ 60% → shipped 🚀";
  c.summary.text = "Engineer ☃";
  c.skills[0].category = "Langs ✨";
  c.sections[1].title = "Projects – Selected";
  const e = errs(validateResume(c, profile, "truthful"));
  expect(e).toEqual([
    'summary: unsupported character "☃" (U+2603)',
    'sections[0].items[0].bullets[0]: unsupported character "🚀" (U+1F600)'.replace("1F600", "1F680"),
    'skills[0].category: unsupported character "✨" (U+2728)',
  ]);
  const d = fixture();
  d.sections[0].items[0].bullets[0].text = "Grew revenue × ≈ 4 — “fast” • the team’s…";
  expect(validateResume(d, profile, "truthful").ok).toBe(true);
});

test("fabricated proper noun is an error in truthful, a warning in stretch", () => {
  const c = fixture();
  c.sections[0].items[0].bullets[0].text = "Scaled Kafka pipelines.";
  const t = validateResume(c, profile, "truthful");
  expect(errs(t)).toContain('sections[0].items[0].bullets[0]: "Kafka" is not supported by the cited entries');
  const s = validateResume(c, profile, "stretch");
  expect(s.ok).toBe(true);
  if (s.ok) expect(s.warnings).toContain('sections[0].items[0].bullets[0]: "Kafka" is not supported by the cited entries');
});

test("fabricated number in summary is caught", () => {
  const c = fixture();
  c.summary.text = "Engineer with 15 years of experience.";
  expect(errs(validateResume(c, profile, "truthful")).join("\n")).toContain('summary: "15" is not supported');
});

test("inferred basis is accepted in stretch", () => {
  const c = fixture();
  c.sections[0].items[0].bullets[2].basis = "inferred";
  expect(validateResume(c, profile, "stretch").ok).toBe(true);
});

test("body-only skill accepted in stretch, rejected in truthful", () => {
  const c = fixture();
  c.skills[2].items.push("Kubernetes");
  expect(errs(validateResume(c, profile, "truthful"))).toContain('skills[2].items[4]: "Kubernetes" is not in your profile');
  expect(validateResume(c, profile, "stretch").ok).toBe(true);
  c.skills[2].items.push("Haskell");
  expect(validateResume(c, profile, "stretch").ok).toBe(false);
});

test("stretch keeps unsourced numbers as errors", () => {
  const c = fixture();
  c.sections[0].items[0].bullets[0].text = "Increased conversion 30%.";
  const r = validateResume(c, profile, "stretch");
  expect(errs(r)).toContain('sections[0].items[0].bullets[0]: "30%" is not supported by the cited entries');
});

test("entry start year sources a year claim", () => {
  const c = fixture();
  c.sections[0].items[0].bullets[0].text = "Owned billing since 2023.";
  expect(validateResume(c, profile, "truthful").ok).toBe(true);
});

test("stretch body skill must match case-sensitively", () => {
  const c = fixture();
  c.skills[2].items.push("kubernetes");
  expect(validateResume(c, profile, "stretch").ok).toBe(false);
});

test("stretch: invented x2 multiplier is an error", () => {
  const c = fixture();
  c.sections[0].items[0].bullets[0].text = "Scaled throughput x2.";
  expect(errs(validateResume(c, profile, "stretch")).join("\n")).toContain('"2x" is not supported');
});

test("R14: summary accepts prose openers and structural nouns", () => {
  const c = fixture();
  c.summary.text = "My focus is billing and data pipelines in TypeScript and Go.";
  expect(validateResume(c, profile, "truthful").ok).toBe(true);
  c.summary.text = "Skills include TypeScript, Node.js and PostgreSQL. Previously built REST services in Go.";
  expect(validateResume(c, profile, "truthful").ok).toBe(true);
});

test("R14: a sentence-initial word used lowercase elsewhere in the document is exempt", () => {
  const c = fixture();
  c.summary.text = "Engineer who keeps feedback loops fast, in TypeScript and Go.";
  c.sections[0].items[1].bullets[2].text = "Fast CI came from parallelizing test suites, cutting it from 25 to 9 minutes.";
  expect(validateResume(c, profile, "truthful").ok).toBe(true);
  c.summary.text = "Engineer working in TypeScript and Go.";
  expect(errs(validateResume(c, profile, "truthful"))).toContain('sections[0].items[1].bullets[2]: "Fast" is not supported by the cited entries');
});
