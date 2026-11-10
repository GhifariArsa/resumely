import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latexEscape, latexUrl } from "../src/render/latex-escape";
import { renderResume, findTemplate, listTemplates, builtinTemplatesDir } from "../src/render/render";
import { loadProfile } from "../src/profile/load";
import { ResumeContent } from "../src/pipeline/schemas";
import { UserError } from "../src/errors";

const about = loadProfile(join(import.meta.dir, "fixtures/profile-jordan")).about;
const content = ResumeContent.parse(await Bun.file(join(import.meta.dir, "fixtures/resume-content.json")).json());

describe("latexEscape", () => {
  const table: [string, string][] = [
    ["&", "\\&"], ["%", "\\%"], ["$", "\\$"], ["#", "\\#"], ["_", "\\_"],
    ["{", "\\{"], ["}", "\\}"], ["~", "\\textasciitilde{}"], ["^", "\\textasciicircum{}"],
    ["\\", "\\textbackslash{}"],
    ["R&D at 100% for $5M", "R\\&D at 100\\% for \\$5M"],
    ["Zoë", "Zoë"],
    ["a\\&b", "a\\textbackslash{}\\&b"],
  ];
  for (const [i, o] of table) test(JSON.stringify(i), () => expect(latexEscape(i)).toBe(o));
});

test("latexUrl escapes % and # only", () => {
  expect(latexUrl("https://x.com/a%20b#frag?q=1&r=2_z")).toBe("https://x.com/a\\%20b\\#frag?q=1&r=2_z");
});

describe("renderResume", () => {
  const t = findTemplate("classic", [builtinTemplatesDir()]);
  const tex = renderResume(t, { about, content });
  test("escapes content", () => {
    expect(tex).toContain("R\\&D");
    expect(tex).toContain("C\\#");
    expect(tex).toContain("100\\%");
    expect(tex).toContain("\\$5M");
    expect(tex).not.toContain("R&D");
  });
  test("header and preamble", () => {
    expect(tex).toContain("Jordan Example");
    expect(tex).toContain("Montreal, QC");
    expect(tex).toContain("\\pdfgentounicode=1");
    expect(tex).toContain("\\href{https://github.com/jordan-example}");
  });
  test("summary and section order, skills last", () => {
    expect(tex).toContain("Backend-leaning");
    const idx = ["Experience", "Projects", "Education", "Technical Skills"].map((s) => tex.indexOf("\\section{" + s + "}"));
    expect(idx.every((n) => n > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(tex).toContain("\\resumeProjectHeading");
  });
  test("raw URL with % is escaped for href", () => {
    const a = { ...about, links: [{ label: "Me", url: "https://x.com/a%20b#f" }] };
    expect(renderResume(t, { about: a, content })).toContain("\\href{https://x.com/a\\%20b\\#f}");
  });
  test("omits summary when absent", () => {
    const { summary: _s, ...rest } = content;
    expect(renderResume(t, { about, content: rest as ResumeContent })).not.toContain("Backend-leaning");
  });
});

describe("templates", () => {
  test("listTemplates: user overrides builtin id", () => {
    const user = mkdtempSync(join(tmpdir(), "tpl-"));
    mkdirSync(join(user, "classic"));
    writeFileSync(join(user, "classic/template.toml"), 'id="classic"\nname="Mine"\ndescription="d"\nengine="xelatex"\nsupports=["resume"]\npackages=[]\n');
    const l = listTemplates([builtinTemplatesDir(), user]);
    expect(l.filter((x) => x.id === "classic")).toHaveLength(1);
    expect(l.find((x) => x.id === "classic")!.name).toBe("Mine");
  });
  test("findTemplate missing lists ids", () => {
    try { findTemplate("nope", [builtinTemplatesDir()]); throw new Error("no"); }
    catch (e) { expect(e).toBeInstanceOf(UserError); expect((e as UserError).hint).toContain("classic"); }
  });
});
