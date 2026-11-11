import { test, expect } from "bun:test";
import { join } from "node:path";
import { compileTex, DEFAULT_TIMEOUT_MS, parseFill } from "../src/render/compile";
import { renderResume, findTemplate, builtinTemplatesDir } from "../src/render/render";
import { loadProfile } from "../src/profile/load";
import { ResumeContent } from "../src/pipeline/schemas";
import { resolveResume } from "../src/pipeline/resolve";
import { buildAgentPayload } from "../src/profile/context";
import { UserError } from "../src/errors";

const profile = loadProfile(join(import.meta.dir, "fixtures/profile-jordan"));
const about = profile.about;
const content = ResumeContent.parse(await Bun.file(join(import.meta.dir, "fixtures/resume-content.json")).json());
const resume = resolveResume(content, buildAgentPayload(profile).entries);
const t = findTemplate("classic", [builtinTemplatesDir()]);
const skip = !Bun.which("latexmk");

test.skipIf(skip)("compiles fixture to one page", async () => {
  const r = await compileTex(renderResume(t, { about, resume }), t.engine);
  expect(r.pages).toBe(1);
  expect(new TextDecoder().decode(r.pdf.slice(0, 4))).toBe("%PDF");
}, 150000);

test.skipIf(skip)("compiles accented heading", async () => {
  const c = structuredClone(resume);
  c.sections[0]!.items[0]!.heading = "José Núñez — Société Générale";
  const r = await compileTex(renderResume(t, { about, resume: c }), t.engine);
  expect(r.pages).toBeGreaterThanOrEqual(1);
}, 150000);

test.skipIf(skip)("compile failure gives UserError with log hint", async () => {
  try {
    await compileTex("\\documentclass{article}\\begin{document}\\undefinedmacro\\end{document}", "pdflatex");
    throw new Error("should fail");
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    expect((e as UserError).message).toBe("LaTeX compile failed");
    expect((e as UserError).hint).toContain("Undefined control sequence");
  }
}, 150000);

test.skipIf(skip)("times out on a looping document quickly", async () => {
  const start = Date.now();
  try {
    await compileTex("\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}", "pdflatex", { timeoutMs: 1500 });
    throw new Error("should time out");
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    expect((e as UserError).message).toBe("LaTeX compile timed out");
  }
  expect(Date.now() - start).toBeLessThan(6000);
}, 30000);

test.skipIf(skip)("hostile text is escaped and compiles", async () => {
  const c = structuredClone(resume);
  const a = { ...about, name: "Zoë José Núñez", location: "R&D Park, QC" };
  c.sections[0]!.items[0]!.heading = "Société Générale";
  c.sections[0]!.items[0]!.bullets[0]!.text = "snake_case ~ ^ \\ {} 100% $5M R&D C#";
  c.skills[0]!.items = ["C#", "snake_case"];
  const tex = renderResume(t, { about: a, resume: c });
  for (const s of ["\\_", "\\textasciitilde{}", "\\textasciicircum{}", "\\textbackslash{}", "\\{", "\\}", "R\\&D", "C\\#"]) {
    expect(tex).toContain(s);
  }
  const r = await compileTex(tex, t.engine);
  expect(r.pages).toBeGreaterThanOrEqual(1);
}, 150000);

test.skipIf(skip)("every character validation accepts compiles under the classic template", async () => {
  const c = structuredClone(resume);
  let latin = "";
  for (let cp = 0xa0; cp <= 0x17f; cp++) latin += String.fromCodePoint(cp);
  c.sections[0]!.items[0]!.bullets[0]!.text = latin;
  c.sections[0]!.items[0]!.bullets[1]!.text = "≈ → ← ≥ ≤ × ✓ ✔ • … ™ ® © € a\u00a0b – — ‘ ’ “ ” ′";
  const r = await compileTex(renderResume(t, { about, resume: c }), t.engine);
  expect(r.pages).toBeGreaterThanOrEqual(1);
}, 150000);

test.skipIf(skip)("fill ratio is in (0,1] for the fixture", async () => {
  const r = await compileTex(renderResume(t, { about, resume }), t.engine);
  expect(r.fill).not.toBeNull();
  expect(r.fill!).toBeGreaterThan(0);
  expect(r.fill!).toBeLessThanOrEqual(1);
}, 150000);

test("parseFill parses pt values, clamps, and rejects bad input", () => {
  expect(parseFill("x RESUMELY-FILL 350.0pt 700.0pt y")).toBeCloseTo(0.5);
  expect(parseFill("RESUMELY-FILL 900.5pt 700.0pt")).toBe(1);
  expect(parseFill("RESUMELY-FILL 5pt 0.0pt")).toBeNull();
  expect(parseFill("no marker")).toBeNull();
});

test("default compile timeouts are per engine (cold luaotfload cache is slow)", () => {
  expect(DEFAULT_TIMEOUT_MS).toEqual({ pdflatex: 120000, xelatex: 120000, lualatex: 300000 });
});
