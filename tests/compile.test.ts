import { test, expect } from "bun:test";
import { join } from "node:path";
import { compileTex } from "../src/render/compile";
import { renderResume, findTemplate, builtinTemplatesDir } from "../src/render/render";
import { loadProfile } from "../src/profile/load";
import { ResumeContent } from "../src/pipeline/schemas";
import { UserError } from "../src/errors";

const about = loadProfile(join(import.meta.dir, "fixtures/profile-jordan")).about;
const content = ResumeContent.parse(await Bun.file(join(import.meta.dir, "fixtures/resume-content.json")).json());
const t = findTemplate("classic", [builtinTemplatesDir()]);
const skip = !Bun.which("latexmk");

test.skipIf(skip)("compiles fixture to one page", async () => {
  const r = await compileTex(renderResume(t, { about, content }), t.engine);
  expect(r.pages).toBe(1);
  expect(new TextDecoder().decode(r.pdf.slice(0, 4))).toBe("%PDF");
}, 150000);

test.skipIf(skip)("compiles accented heading", async () => {
  const c = structuredClone(content);
  c.sections[0]!.items[0]!.heading = "José Núñez — Société Générale";
  const r = await compileTex(renderResume(t, { about, content: c }), t.engine);
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
