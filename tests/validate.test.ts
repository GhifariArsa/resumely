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
