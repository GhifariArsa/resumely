import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latexEscape, latexUrl } from "../src/render/latex-escape";
import { renderResume, findTemplate, listTemplates, builtinTemplatesDir } from "../src/render/render";
import { loadProfile } from "../src/profile/load";
import { ResumeContent } from "../src/pipeline/schemas";
import { resolveResume, type ResolvedResume } from "../src/pipeline/resolve";
import { buildAgentPayload } from "../src/profile/context";
import { UserError } from "../src/errors";

const profile = loadProfile(join(import.meta.dir, "fixtures/profile-jordan"));
const about = profile.about;
const content = ResumeContent.parse(await Bun.file(join(import.meta.dir, "fixtures/resume-content.json")).json());
const resume = resolveResume(content, buildAgentPayload(profile).entries);

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
  const tex = renderResume(t, { about, resume });
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
  test("headings and dates come from the resolved entries", () => {
    expect(tex).toContain("{Senior Software Engineer}{Mar 2023 – Present}");
    expect(tex).toContain("{Atlas Labs}{Montreal, QC}");
    expect(tex).toContain("\\textbf{Ledgerly} $|$ \\emph{TypeScript, PostgreSQL}}{Jan 2022 – Present}");
  });
  test("raw URL with % is escaped for href", () => {
    const a = { ...about, links: [{ label: "Me", url: "https://x.com/a%20b#f" }] };
    expect(renderResume(t, { about: a, resume })).toContain("\\href{https://x.com/a\\%20b\\#f}");
  });
  test("omits summary when absent", () => {
    const { summary: _s, ...rest } = resume;
    expect(renderResume(t, { about, resume: rest as ResolvedResume })).not.toContain("Backend-leaning");
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
