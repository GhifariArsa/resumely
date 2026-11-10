import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, loadVoiceSamples } from "../src/profile/load";
import { CompanyResearch, CoverLetterContent, type ParsedJob } from "../src/pipeline/schemas";
import { validateCoverLetter, type CoverLetterOptions } from "../src/pipeline/validate";
import { DEFAULT_BANNED } from "../src/pipeline/banned";
import { renderCoverLetter, formatLetterDate, findTemplate, builtinTemplatesDir } from "../src/render/render";
import { compileTex } from "../src/render/compile";
import { UserError } from "../src/errors";

const fx = (f: string) => join(import.meta.dir, "fixtures", f);
const profile = loadProfile(fx("profile-jordan"));
const research = CompanyResearch.parse(await Bun.file(fx("company.json")).json());
const letter = CoverLetterContent.parse(await Bun.file(fx("cover-letter.json")).json());
const job: ParsedJob = { company: "Atlas Freight", role: "Senior Backend Engineer", requirements: [], nice_to_haves: [], keywords: [], language: "en" };
const jobText = "Atlas Freight is hiring a Senior Backend Engineer. Contact: Priya Raman.";
const base: CoverLetterOptions = { profile, research, banned: DEFAULT_BANNED, mode: "truthful", jobText, job };
const withP = (i: number, text: string, extra: object = {}) => ({
  ...letter,
  paragraphs: letter.paragraphs.map((p, k) => (k === i ? { ...p, text, ...extra } : p)),
});
const errs = (raw: unknown, o: Partial<CoverLetterOptions> = {}) => {
  const r = validateCoverLetter(raw, { ...base, ...o });
  return r.ok ? [] : r.errors;
};

describe("validateCoverLetter", () => {
  test("fixture passes in truthful mode with no warnings", () => {
    const r = validateCoverLetter(letter, base);
    expect(r.ok && r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
  });
  test("fixture is about 280 words", () => {
    const n = letter.paragraphs.flatMap((p) => p.text.split(/\s+/).filter(Boolean)).length;
    expect(n).toBeGreaterThanOrEqual(250);
    expect(n).toBeLessThanOrEqual(350);
  });
  test("short letter fails word count", () => {
    const short = { ...letter, paragraphs: letter.paragraphs.map((p) => ({ ...p, text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen." })) };
    expect(errs(short).some((e) => /^word count \d+ \(must be 200–400\)$/.test(e))).toBe(true);
  });
  test("banned phrase, case-insensitive and word-bounded", () => {
    expect(errs(withP(0, letter.paragraphs[0]!.text + " I was Thrilled."), {})).toContain('paragraphs[0]: banned phrase "thrilled"');
    expect(errs(withP(0, letter.paragraphs[0]!.text + " Our leveraging approach."))).toContain('paragraphs[0]: banned phrase "leveraging"');
    expect(errs(withP(0, letter.paragraphs[0]!.text + " The dynamics of freight.")).some((e) => e.includes("banned"))).toBe(false);
  });
  test("user-extended banned list", () => {
    expect(errs(letter, { banned: [...DEFAULT_BANNED, "dispatch"] }).some((e) => e.includes('banned phrase "dispatch"'))).toBe(true);
  });
  test("unknown fact and entry ids", () => {
    expect(errs(withP(0, letter.paragraphs[0]!.text, { company_fact_ids: ["co-9"] }))).toContain('paragraphs[0]: unknown company fact id "co-9"');
    expect(errs(withP(1, letter.paragraphs[1]!.text, { entry_ids: ["nope"] }))).toContain('paragraphs[1]: unknown entry id "nope"');
  });
  test("company_fact_ids must be empty without research", () => {
    expect(errs(letter, { research: null }).some((e) => e.includes("unknown company fact id"))).toBe(true);
  });
  test("greeting: default ok, named person must be in the JD", () => {
    expect(errs({ ...letter, greeting: "Dear Priya Raman," })).toEqual([]);
    expect(errs({ ...letter, greeting: "Dear Sarah Chen," }).some((e) => e.includes("greeting") && e.includes("Sarah Chen"))).toBe(true);
    expect(errs({ ...letter, greeting: "Hello there" }).some((e) => e.includes("greeting"))).toBe(true);
  });
  test("unsourced number is an error in both modes", () => {
    const t = letter.paragraphs[1]!.text + " I also saved $10M.";
    expect(errs(withP(1, t)).some((e) => e.includes('"$10M"'))).toBe(true);
    expect(errs(withP(1, t), { mode: "stretch" }).some((e) => e.includes('"$10M"'))).toBe(true);
  });
  test("unsourced proper noun: error in truthful, warning in stretch", () => {
    const t = letter.paragraphs[1]!.text + " I used Snowflake daily.";
    expect(errs(withP(1, t)).some((e) => e.includes('"Snowflake"'))).toBe(true);
    const r = validateCoverLetter(withP(1, t), { ...base, mode: "stretch" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.some((w) => w.includes('"Snowflake"'))).toBe(true);
  });
  test("company facts and role title count as sources", () => {
    const t = letter.paragraphs[0]!.text + " Kafka matters.";
    expect(errs(withP(0, t))).toEqual([]);
    expect(errs(withP(3, letter.paragraphs[3]!.text + " Kafka matters.")).some((e) => e.includes('"Kafka"'))).toBe(true);
  });
  test("unsupported characters", () => {
    expect(errs(withP(1, letter.paragraphs[1]!.text + " 🚀")).some((e) => e.includes("unsupported character"))).toBe(true);
  });
  test("paragraph count 3..5 via schema", () => {
    expect(errs({ ...letter, paragraphs: letter.paragraphs.slice(0, 2) }).length).toBeGreaterThan(0);
  });
});

describe("renderCoverLetter", () => {
  const t = findTemplate("classic", [builtinTemplatesDir()]);
  const data = { about: profile.about, letter, job: { company: "R&D Freight", role: "Senior Backend Engineer" }, date: formatLetterDate(new Date(2026, 10, 10)) };
  test("formatLetterDate", () => expect(formatLetterDate(new Date(2026, 10, 10))).toBe("November 10, 2026"));
  const tex = renderCoverLetter(t, data);
  test("structure", () => {
    expect(tex).toContain("Re: Senior Backend Engineer");
    expect(tex).toContain("R\\&D Freight");
    expect(tex).toContain("November 10, 2026");
    expect(tex).toContain("Dear Hiring Team,");
    expect(tex).toContain("\\pdfgentounicode=1");
    expect(tex).toContain("pdftitle={Jordan Example — Cover Letter}");
    expect(tex).toContain("RESUMELY-FILL");
    expect(tex).toContain("\\textbf{\\Huge \\scshape Jordan Example}");
    expect(tex.indexOf("Sincerely,")).toBeGreaterThan(tex.indexOf("Dear Hiring Team,"));
  });
  test("throws when template lacks cover-letter", () => {
    expect(() => renderCoverLetter({ ...t, supports: ["resume"] }, data)).toThrow(UserError);
  });
  test.skipIf(!Bun.which("latexmk"))("compiles to one page", async () => {
    const real = renderCoverLetter(t, { ...data, job: { company: "Atlas Freight", role: "Senior Backend Engineer" } });
    const r = await compileTex(real, t.engine);
    expect(r.pages).toBe(1);
    if (process.env.COVER_PDF_OUT) await Bun.write(process.env.COVER_PDF_OUT, r.pdf);
  }, 150000);
});

describe("loadVoiceSamples", () => {
  test("strips private, skips empty, caps count and length", () => {
    const d = mkdtempSync(join(tmpdir(), "voice-"));
    mkdirSync(join(d, "voice"));
    writeFileSync(join(d, "voice/a.md"), "Hello there.\n\n## Private\n\nsecret stuff\n");
    writeFileSync(join(d, "voice/b.txt"), "x".repeat(5000));
    writeFileSync(join(d, "voice/c.md"), "   \n");
    writeFileSync(join(d, "voice/d.md"), "four");
    writeFileSync(join(d, "voice/e.md"), "five");
    writeFileSync(join(d, "voice/ignored.pdf"), "nope");
    const s = loadVoiceSamples(d);
    expect(s.map((x) => x.name)).toEqual(["a.md", "b.txt", "d.md"]);
    expect(s[0]!.text).toBe("Hello there.");
    expect(s[1]!.text.length).toBe(3000);
  });
  test("missing dir gives []", () => expect(loadVoiceSamples(mkdtempSync(join(tmpdir(), "v-")))).toEqual([]));
});

test("prose openers are exempt only when opted in", async () => {
  const { scanClaims, PROSE_OPENERS } = await import("../src/checks/fabrication");
  expect(scanClaims("My work was good.", [])).toEqual(["My"]);
  expect(scanClaims("My work was good.", [], { openers: PROSE_OPENERS })).toEqual([]);
  expect(scanClaims("Snowflake was good.", [], { openers: PROSE_OPENERS })).toEqual(["Snowflake"]);
});
