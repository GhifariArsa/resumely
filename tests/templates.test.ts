import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { atsCheck } from "../src/checks/ats";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";
import { produceCover, produceResume, resumeAtsExpect } from "../src/pipeline/documents";
import { CoverLetterContent, ResumeContent } from "../src/pipeline/schemas";
import { buildAgentPayload } from "../src/profile/context";
import { loadProfile } from "../src/profile/load";
import type { About } from "../src/profile/schema";
import { compileTex } from "../src/render/compile";
import { extractPdfText } from "../src/render/pdftext";
import { findTemplate, renderCoverLetter, renderResume } from "../src/render/render";
import { resolveResume } from "../src/pipeline/resolve";
import { formatTemplateList, listTemplates, newTemplate, templateDirs, templateProblems } from "../src/render/templates";

const fx = join(import.meta.dir, "fixtures");
const tmp = () => mkdtempSync(join(tmpdir(), "resumely-tpl-"));
const initRoot = () => {
  const r = tmp();
  initDataRoot(r);
  return r;
};
const msg = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message + " | " + ((e as { hint?: string }).hint ?? "");
  }
  throw new Error("did not throw");
};

describe("registry", () => {
  test("classic is listed as a built-in with a preview", () => {
    const c = listTemplates(tmp()).find((t) => t.id === "classic")!;
    expect(c.source).toBe("builtin");
    expect(c.engine).toBe("pdflatex");
    expect(c.supports).toEqual(["resume", "cover-letter"]);
    expect(c.preview!.endsWith("templates/classic/preview.png")).toBe(true);
  });

  test("every built-in has LICENSE, preview, packages and supports both kinds", () => {
    for (const t of listTemplates(tmp()).filter((t) => t.source === "builtin")) {
      expect(existsSync(join(t.dir, "LICENSE"))).toBe(true);
      expect(existsSync(join(t.dir, "preview.png"))).toBe(true);
      expect(findTemplate(t.id, templateDirs(tmp())).packages.length).toBeGreaterThan(0);
      expect(t.supports).toEqual(["resume", "cover-letter"]);
    }
  });

  test("a user template overrides a built-in with the same id", () => {
    const root = initRoot();
    mkdirSync(join(layout(root).templates, "mine"), { recursive: true });
    writeFileSync(join(layout(root).templates, "mine/template.toml"), 'id = "classic"\nname = "Mine"\nengine = "pdflatex"\n');
    const l = listTemplates(root).filter((t) => t.id === "classic");
    expect(l).toHaveLength(1);
    expect(l[0]!.source).toBe("user");
  });

  test("invalid templates are skipped and reported, and do not break lookup", () => {
    const root = initRoot();
    mkdirSync(join(layout(root).templates, "broken"), { recursive: true });
    writeFileSync(join(layout(root).templates, "broken/template.toml"), "id = 3\n");
    expect(listTemplates(root).some((t) => t.dir.includes("broken"))).toBe(false);
    const p = templateProblems(root);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("broken");
    expect(findTemplate("classic", templateDirs(root)).id).toBe("classic");
    expect(msg(() => findTemplate("nope", templateDirs(root)))).toContain("invalid templates:");
  });

  test("listTemplates does not need an initialised root", () => {
    expect(listTemplates(join(tmp(), "missing")).length).toBeGreaterThan(0);
  });
});

describe("newTemplate", () => {
  test("copies a base without its preview and rewrites the metadata", () => {
    const root = initRoot();
    const t = newTemplate(root, "mine", "classic");
    expect(t.source).toBe("user");
    expect(listTemplates(root).find((x) => x.id === "mine")!.source).toBe("user");
    const toml = parseToml(readFileSync(join(t.dir, "template.toml"), "utf8"));
    expect(toml.id).toBe("mine");
    expect(toml.name).toBe("Classic (custom)");
    expect(existsSync(join(t.dir, "LICENSE"))).toBe(true);
    expect(existsSync(join(t.dir, "preview.png"))).toBe(false);
    expect(t.preview).toBeNull();
  });

  test("rejects duplicates, bad ids and unknown bases", () => {
    const root = initRoot();
    newTemplate(root, "mine", "classic");
    expect(msg(() => newTemplate(root, "mine", "classic"))).toContain("already exists");
    expect(msg(() => newTemplate(root, "classic", "classic"))).toContain("already exists");
    expect(msg(() => newTemplate(root, "Bad Id", "classic"))).toContain("Invalid template id");
    expect(msg(() => newTemplate(root, "x", "nope"))).toContain("Unknown template");
  });

  test("formatTemplateList prints a table, then descriptions and previews", () => {
    const out = formatTemplateList(listTemplates(tmp()));
    expect(out.split("\n")[0]).toMatch(/^ID\s+NAME\s+ENGINE\s+SUPPORTS\s+SOURCE$/);
    expect(out).toContain("classic: ");
    expect(out).toContain("  preview: ");
  });
});

describe("cli", () => {
  async function cli(root: string, ...args: string[]) {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { env: { ...process.env, RESUMELY_HOME: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  }
  test("templates list", async () => {
    const r = await cli(initRoot(), "templates", "list");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("classic");
    expect(r.stdout).toContain("preview:");
  });
  test("templates new", async () => {
    const root = initRoot();
    const r = await cli(root, "templates", "new", "mine", "--from", "classic");
    expect(r.code).toBe(0);
    expect(existsSync(join(layout(root).templates, "mine/template.toml"))).toBe(true);
    expect(r.stdout).toContain("hint: edit ");
  });
});

// --- per-built-in compile tests (need latexmk) ---
const skip = !Bun.which("latexmk");
const skipPdf = skip || !Bun.which("pdftotext");
const profile = loadProfile(join(fx, "profile-jordan"));
const entries = buildAgentPayload(profile).entries;
const content = ResumeContent.parse(await Bun.file(join(fx, "resume-content.json")).json());
const letter = CoverLetterContent.parse(await Bun.file(join(fx, "cover-letter.json")).json());
const job = { company: "Atlas Freight", role: "Senior Backend Engineer" };
const common = { about: profile.about, job, targetPages: 1, keywords: [] as string[], profileText: "" };
const marker = { pdflatex: "\\pdfgentounicode=1", lualatex: "\\pdfvariable gentounicode", xelatex: "fontspec" } as const;

async function pdfInfo(pdf: Uint8Array, ...flags: string[]): Promise<string> {
  const f = join(tmp(), "x.pdf");
  writeFileSync(f, pdf);
  const p = Bun.spawn(["pdfinfo", ...flags, f], { stdout: "pipe" });
  return await new Response(p.stdout).text();
}

/** Link targets from `pdfinfo -url` (one per annotation). */
async function pdfUrls(pdf: Uint8Array): Promise<string[]> {
  return (await pdfInfo(pdf, "-url"))
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[2])
    .filter((u): u is string => !!u);
}

const hostileLinks = [
  { label: "GitHub", url: "https://github.com/first_last/" },
  { label: "LinkedIn", url: "https://www.linkedin.com/in/first_last-123/details/" },
  { label: "Site", url: "https://example.com/~me/a_b?q=1%20#frag" },
];

for (const info of listTemplates(tmp()).filter((t) => t.source === "builtin")) {
  const template = findTemplate(info.id, templateDirs(tmp()));
  describe(`built-in template ${info.id}`, () => {
    test.skipIf(skip)("resume compiles to one filled page with clean ATS text and metadata", async () => {
      const r = await produceResume({ ...common, template, content, entries });
      expect(r.pages).toBe(1);
      expect(r.fill !== null && r.fill > 0.4).toBe(true);
      expect(r.tex).toContain(marker[template.engine]);
      if (Bun.which("pdftotext")) expect(r.facts.ats).toEqual({ status: "ok", problems: [] });
      if (Bun.which("pdfinfo")) {
        const i = await pdfInfo(r.pdf);
        expect(i).toMatch(/^Title:\s+Jordan Example — Resume$/m);
        expect(i).toMatch(/^Author:\s+Jordan Example$/m);
        expect(i).toMatch(/^Subject:\s+Senior Backend Engineer at Atlas Freight$/m);
      }
    }, 300_000);

    test.skipIf(skip)("cover letter compiles to one page with clean ATS text and metadata", async () => {
      const r = await produceCover({ ...common, template, letter, date: "November 11, 2026" });
      expect(r.pages).toBe(1);
      expect(r.tex).toContain("Re: ");
      expect(r.tex).toContain("Atlas Freight");
      expect(r.tex).toContain(marker[template.engine]);
      if (Bun.which("pdftotext")) expect(r.facts.ats).toEqual({ status: "ok", problems: [] });
      if (Bun.which("pdfinfo")) {
        const i = await pdfInfo(r.pdf);
        expect(i).toMatch(/^Title:\s+Jordan Example — Cover Letter$/m);
        expect(i).toMatch(/^Author:\s+Jordan Example$/m);
        expect(i).toMatch(/^Subject:\s+Senior Backend Engineer at Atlas Freight$/m);
      }
    }, 300_000);

    test.skipIf(skipPdf)("sparse profile with hostile text still compiles and extracts", async () => {
      const about: About = { name: "Zoë José Núñez", email: "z@example.com", links: [], body: "" };
      const sparse = structuredClone(content);
      delete sparse.summary;
      sparse.skills = [];
      const items = sparse.sections.flatMap((s) => s.items);
      items[0]!.bullets = [];
      items.find((i) => i.bullets.length)!.bullets[0]!.text = "Łódź R&D snake_case ~ ^ \\ {} 100% $5M C# → ≈ ✓ € “q” —";
      const resume = resolveResume(sparse, entries);
      const { pdf, pages } = await compileTex(renderResume(template, { about, resume, job }), template.engine);
      expect(pages).toBeGreaterThanOrEqual(1);
      const text = (await extractPdfText(pdf))!;
      expect(text).toContain("Zoë José Núñez");
      expect(text).toContain("Łódź R&D");
      expect(atsCheck(text, resumeAtsExpect(about, sparse)).status).toBe("ok");
    }, 300_000);

    test.skipIf(skipPdf || !Bun.which("pdfinfo"))("contact links keep their raw targets and show readable text (resume and cover letter)", async () => {
      const about: About = { ...profile.about, links: hostileLinks };
      const resume = resolveResume(content, entries);
      for (const tex of [renderResume(template, { about, resume, job }), renderCoverLetter(template, { about, letter, job, date: "November 11, 2026" })]) {
        const { pdf } = await compileTex(tex, template.engine);
        const urls = await pdfUrls(pdf);
        for (const l of hostileLinks) expect(urls).toContain(l.url);
        const text = (await extractPdfText(pdf))!.replace(/\s+/g, " ");
        expect(text).toContain("github.com/first_last");
        expect(text).toContain("linkedin.com/in/first_last-123/details");
        expect(text).toContain("example.com/~me/a_b");
      }
    }, 300_000);
  });
}
