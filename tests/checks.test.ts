import { test, expect } from "bun:test";
import { join } from "node:path";
import { compileTex } from "../src/render/compile";
import { extractPdfText, extractPdfTextDetailed } from "../src/render/pdftext";
import { renderResume, findTemplate, builtinTemplatesDir } from "../src/render/render";
import { loadProfile } from "../src/profile/load";
import { ResumeContent } from "../src/pipeline/schemas";
import { resolveResume } from "../src/pipeline/resolve";
import { buildAgentPayload } from "../src/profile/context";
import { atsCheck } from "../src/checks/ats";
import { keywordCoverage } from "../src/checks/keywords";
import { buildHardFacts } from "../src/checks/facts";

test("keywordCoverage splits present / missed_in_profile / absent", () => {
  const r = keywordCoverage(["TypeScript", "C#", "Rust", "Kafka"], "I wrote typescript and C# daily", "also Kafka");
  expect(r).toEqual({ present: ["TypeScript", "C#"], missed_in_profile: ["Kafka"], absent: ["Rust"] });
});

test("keywordCoverage is whole-token and handles specials and dupes", () => {
  expect(keywordCoverage(["Java"], "JavaScript only", "").absent).toEqual(["Java"]);
  expect(keywordCoverage(["Java"], "Java, Kotlin", "").present).toEqual(["Java"]);
  const r = keywordCoverage(["Node.js", "C++", "node.js"], "Node.js and C++.", "");
  expect(r.present).toEqual(["Node.js", "C++"]);
  expect(keywordCoverage(["Nodexjs"], "Node.js", "").absent).toEqual(["Nodexjs"]);
});

const expectBase = { name: "Jordan Example", headings: [] as string[], snippets: [] as string[] };

test("atsCheck skipped when text is null", () => {
  const r = atsCheck(null, expectBase);
  expect(r.status).toBe("skipped");
  expect(r.hint).toBe("Install poppler for the ATS check (macOS: brew install poppler)");
});

test("atsCheck normalises ligatures, soft hyphens, hyphenation", () => {
  const text = "Jordan  Example\n\nSigni­ﬁcant work on ﬂow of e­mail, built a dis-\ntributed system";
  const r = atsCheck(text, { ...expectBase, headings: [], snippets: ["significant work on flow", "a distributed system"] });
  expect(r).toEqual({ status: "ok", problems: [] });
});

test("atsCheck reports each problem", () => {
  const text = "Skills\nExperience\nbad � char";
  const r = atsCheck(text, {
    name: "Jordan Example",
    email: "j@x.dev",
    phone: "+1 (555) 123-4567",
    headings: ["Experience", "Skills"],
    snippets: ["a snippet that is definitely not present anywhere in text"],
  });
  expect(r.status).toBe("failed");
  expect(r.problems).toEqual([
    "name not extractable",
    "email not extractable",
    "phone not extractable",
    'heading "Skills" missing or out of order',
    "garbled text (U+FFFD)",
    "text not continuous: \"a snippet that is definitely not present…\"",
  ]);
});

test("atsCheck phone compares digits only", () => {
  const r = atsCheck("call 555.123.4567 now Jordan Example", { ...expectBase, phone: "(555) 123-4567" });
  expect(r.status).toBe("ok");
});

test("buildHardFacts computes overflow/underflow and word count", async () => {
  const base = { pdf: new Uint8Array(), keywords: ["A"], profileText: "", contentText: "one two three", atsExpect: expectBase };
  const o = await buildHardFacts({ ...base, pages: 2, fill: 0.5, targetPages: 1 }, { text: null });
  expect(o.overflow).toBe(true);
  expect(o.underflow).toBe(false);
  expect(o.word_count).toBe(3);
  expect(o.ats.status).toBe("skipped");
  expect(o.fabrication_warnings).toEqual([]);
  const u = await buildHardFacts({ ...base, pages: 1, fill: 0.6, targetPages: 1 }, { text: "a b c d" });
  expect(u.underflow).toBe(true);
  expect(u.word_count).toBe(4);
  expect(Object.keys(u).sort()).toEqual(
    ["ats", "fabrication_warnings", "fill", "keywords", "overflow", "pages", "target_pages", "underflow", "word_count"],
  );
});

test("extractPdfText resolves null when pdftotext is missing", async () => {
  expect(await extractPdfText(new Uint8Array([37, 80]), { bin: "pdftotext-does-not-exist" })).toBeNull();
});

const real = !!Bun.which("latexmk") && !!Bun.which("pdftotext");
test.skipIf(!real)("real fixture: text extraction and ATS ok", async () => {
  const profile = loadProfile(join(import.meta.dir, "fixtures/profile-jordan"));
  const content = ResumeContent.parse(await Bun.file(join(import.meta.dir, "fixtures/resume-content.json")).json());
  const resume = resolveResume(content, buildAgentPayload(profile).entries);
  const t = findTemplate("classic", [builtinTemplatesDir()]);
  const { pdf } = await compileTex(renderResume(t, { about: profile.about, resume }), t.engine);
  const text = await extractPdfText(pdf);
  expect(text).toContain("Jordan Example");
  const headings = resume.sections.map((s) => s.title);
  const snippets = resume.sections.flatMap((s) => s.items.flatMap((i) => i.bullets.map((b) => b.text)));
  const r = atsCheck(text, { name: profile.about.name, email: profile.about.email, phone: profile.about.phone, headings, snippets });
  expect(r).toEqual({ status: "ok", problems: [] });
}, 150000);

test("atsCheck: genuine hyphen wrapped at line end still matches", () => {
  const r = atsCheck("Jordan Example\nbuilt end-to-\nend pipelines", { ...expectBase, snippets: ["built end-to-end pipelines"] });
  expect(r).toEqual({ status: "ok", problems: [] });
});

test("atsCheck skip hint distinguishes failed pdftotext", () => {
  expect(atsCheck(null, expectBase, "failed").hint).toBe("pdftotext failed to read the PDF");
});

test("keywordCoverage: C does not match inside C# or C++", () => {
  expect(keywordCoverage(["C"], "C# and C++", "").absent).toEqual(["C"]);
});

test("extractPdfText: bad PDF is failed, missing binary is missing", async () => {
  if (Bun.which("pdftotext")) {
    expect((await extractPdfTextDetailed(new Uint8Array([1, 2, 3]))).reason).toBe("failed");
  }
  expect((await extractPdfTextDetailed(new Uint8Array(), { bin: "nope-nope" })).reason).toBe("missing");
});
