import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { UserError } from "../src/errors";
import { layout } from "../src/paths";
import { importFlags, importProfile, validateImport } from "../src/profile/import";
import { inboxDir } from "../src/profile/inbox";
import { loadProfile } from "../src/profile/load";
import { docxXmlToText, readImportSource } from "../src/profile/source";
import { minimalPdf } from "./fixtures/pdf";

const fx = join(import.meta.dir, "fixtures");
const RESUME = join(fx, "import", "resume.md");
const resumeText = readFileSync(RESUME, "utf8");
const hasPdftotext = Bun.which("pdftotext") !== null;
const hasTextutil = Bun.which("textutil") !== null;

let root: string;
const saved = process.env.FAKE_HARNESS_SCRIPT;
const fakeCmd = `["bun", "${join(fx, "fake-harness.ts")}", "{workspace}"]`;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-import-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  writeFileSync(layout(root).config, `harness = "fake"\n[adapters.fake]\ncommand = ${fakeCmd}\n`);
});
afterEach(() => {
  if (saved === undefined) delete process.env.FAKE_HARNESS_SCRIPT;
  else process.env.FAKE_HARNESS_SCRIPT = saved;
  rmSync(root, { recursive: true, force: true });
});

function script(s: Record<string, Record<string, unknown>[]>) {
  const p = join(root, "script.json");
  writeFileSync(p, JSON.stringify(s));
  rmSync(`${p}.calls`, { force: true });
  process.env.FAKE_HARNESS_SCRIPT = p;
}
const callsFile = () => join(root, "script.json.calls");
const calls = () => (existsSync(callsFile()) ? readFileSync(callsFile(), "utf8").trim().split("\n") : []);
const inboxFiles = () => readdirSync(inboxDir(layout(root).profile)).filter((n) => n.endsWith(".json"));

const acme = {
  kind: "new",
  entry: {
    type: "experience",
    title: "Staff Engineer",
    org: "Acme Robotics",
    start: "2025-01",
    end: "present",
    skills: ["Rust"],
    tags: ["robotics"],
    bullets: ["Cut fleet downtime 35% across 120 robots"],
  },
  rationale: "New role in the source",
};
const atlasUpdate = {
  kind: "update",
  target_id: "exp-atlas-labs",
  entry: {
    type: "experience",
    title: "Senior Software Engineer",
    org: "Atlas Labs",
    location: "Montreal, QC",
    start: "2023-03",
    end: "present",
    skills: ["TypeScript", "React", "PostgreSQL"],
    tags: ["backend", "frontend"],
    bullets: [
      "Led a team of 4 to rebuild the billing dashboard, cutting page load time by 60%.",
      "Designed an event-driven ingestion pipeline processing 2M events per day.",
      "Mentored 3 junior engineers; introduced RFC-based design reviews.",
      "Reduced infra spend by 18%",
    ],
  },
  rationale: "The source adds an infra-spend result",
};
const result = (proposals: unknown[], extra: Record<string, unknown> = {}) => ({
  "out/proposals.json": { proposals, skills: { Languages: ["Rust"] }, about: null, ...extra },
});
const happy = () => result([acme, atlasUpdate]);
const withBullets = (p: typeof acme, bullets: string[]) => ({ ...p, entry: { ...p.entry, bullets } });

describe("importProfile", () => {
  test("happy path stages new, update and skills proposals", async () => {
    script({ import: [happy()] });
    const r = await importProfile({ root, source: RESUME });
    expect(r.staged.map((p) => p.kind)).toEqual(["new", "update", "skills"]);
    expect(r.staged.map((p) => p.entry?.id).filter(Boolean)).toEqual(["exp-acme-robotics", "exp-atlas-labs"]);
    expect(r.staged[0]!.source).toEqual({ kind: "import", ref: "resume.md", run: expect.any(String) });
    expect(r.staged[2]!.skills).toEqual({ Languages: ["Rust"] });
    expect(calls()).toEqual(["import"]);
    expect(r.workspace.endsWith(join("import"))).toBe(true);
    const payload = readFileSync(join(r.workspace, "profile.json"), "utf8");
    expect(payload).toContain("Atlas Labs");
    expect(payload).not.toContain("Compensation");
    expect(readFileSync(join(r.workspace, "source.txt"), "utf8")).toBe(resumeText);
    expect(JSON.parse(readFileSync(join(r.workspace, "import.schema.json"), "utf8")).type).toBe("object");
    expect(readFileSync(join(r.workspace, "instructions.md"), "utf8")).toContain("source.txt");
    expect(inboxFiles()).toHaveLength(3);
  });

  test("a fabricated number is rejected and retried", async () => {
    script({ import: [result([withBullets(acme, ["Cut fleet downtime 50%"])]), result([acme])] });
    const r = await importProfile({ root, source: RESUME });
    expect(calls()).toEqual(["import", "import"]);
    expect(readFileSync(join(r.workspace, "errors.md"), "utf8")).toContain(`"50%" does not appear in the source`);
    expect(r.staged[0]!.entry!.bullets).toEqual(["Cut fleet downtime 35% across 120 robots"]);
  });

  test("an unsourced proper noun is a warning recorded as a flag", async () => {
    script({ import: [result([withBullets(acme, ["Cut fleet downtime 35% across 120 robots on Kubernetes"])])] });
    const r = await importProfile({ root, source: RESUME });
    expect(calls()).toEqual(["import"]);
    expect(r.staged[0]!.flags).toContain(`unsourced "Kubernetes"`);
    expect(r.warnings.some((w) => w.includes("Kubernetes"))).toBe(true);
  });

  test("an unsourced skill fails after 3 attempts and stages nothing", async () => {
    script({ import: [result([{ ...acme, entry: { ...acme.entry, skills: ["Kafka"] } }])] });
    const err = await importProfile({ root, source: RESUME }).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain("Agent output invalid after 3 attempts");
    expect(calls()).toHaveLength(3);
    expect(existsSync(inboxDir(layout(root).profile))).toBe(false);
  });

  test("importing the same resume twice stages nothing the second time", async () => {
    script({ import: [happy()] });
    await importProfile({ root, source: RESUME });
    script({ import: [happy()] });
    const r = await importProfile({ root, source: RESUME });
    expect(r.staged).toHaveLength(0);
    expect(r.skipped).toHaveLength(3);
    expect(inboxFiles()).toHaveLength(3);
  });

  test("a new entry matching a live one is staged as a duplicate", async () => {
    const atlasNew = {
      kind: "new",
      entry: { ...atlasUpdate.entry, skills: ["TypeScript"], bullets: ["Reduced infra spend by 18%"] },
      rationale: "Atlas Labs role",
    };
    script({ import: [result([atlasNew], { skills: {} })] });
    const r = await importProfile({ root, source: RESUME });
    expect(r.staged).toHaveLength(1);
    expect(r.staged[0]!.kind).toBe("duplicate");
    expect(r.staged[0]!.target_id).toBe("exp-atlas-labs");
  });

  describe("bad sources fail before any agent call", () => {
    beforeEach(() => script({ import: [happy()] }));
    afterEach(() => {
      expect(existsSync(callsFile())).toBe(false);
      expect(existsSync(inboxDir(layout(root).profile))).toBe(false);
    });
    test("unsupported extension", async () => {
      const f = join(root, "resume.rtf");
      writeFileSync(f, "{\\rtf1 Jordan}");
      await expect(importProfile({ root, source: f })).rejects.toThrow('Unsupported file type ".rtf"');
    });
    test("missing file", async () => {
      await expect(importProfile({ root, source: join(root, "nope.pdf") })).rejects.toThrow("File not found");
    });
    test("login-walled LinkedIn page", async () => {
      const page = `<html><body><p>Sign in to see the full profile of Jordan. ${Array(40).fill("word").join(" ")}</p></body></html>`;
      const fetchImpl = (async () => new Response(page, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
      const err = await importProfile({ root, source: "https://www.linkedin.com/in/x", fetchImpl }).catch((e) => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message).toBe("Login wall at https://www.linkedin.com/in/x");
      expect(err.hint).toContain("Save to PDF");
    });
  });
});

describe("validateImport", () => {
  const profile = () => loadProfile(join(fx, "profile-jordan"));
  const base = { proposals: [], skills: {}, about: null };

  test("update of an unknown id is an error", () => {
    const r = validateImport({ ...base, proposals: [{ ...atlasUpdate, target_id: "exp-ghost" }] }, { profile: profile(), sourceText: resumeText });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("unknown");
  });

  test("new must not carry a target_id; update must keep the target's type", () => {
    const r = validateImport(
      { ...base, proposals: [{ ...acme, target_id: "exp-atlas-labs" }, { ...atlasUpdate, entry: { ...atlasUpdate.entry, type: "project" } }] },
      { profile: profile(), sourceText: resumeText },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith("proposals[0].target_id"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("proposals[1].entry.type"))).toBe(true);
    }
  });

  test("error paths name the field", () => {
    const r = validateImport(
      { ...base, proposals: [withBullets(acme, ["Cut fleet downtime 35% across 120 robots", "Saved 40%"])] },
      { profile: profile(), sourceText: resumeText },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain(`proposals[0].entry.bullets[1]: "40%" does not appear in the source`);
  });

  test("an update may reuse numbers from its target entry", () => {
    const r = validateImport({ ...base, proposals: [atlasUpdate] }, { profile: profile(), sourceText: resumeText });
    expect(r.ok).toBe(true);
  });

  test("dates: impossible ranges and unsourced years are errors", () => {
    const r = validateImport(
      {
        ...base,
        proposals: [
          { ...acme, entry: { ...acme.entry, start: "2025-01", end: "2019-01" } },
          { ...acme, entry: { ...acme.entry, title: "Robot Wrangler", start: "2021-04" } },
        ],
      },
      { profile: profile(), sourceText: resumeText, now: new Date("2026-11-11") },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith("proposals[0]") && e.includes("before start"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("proposals[0].entry.end") && e.includes("2019"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("proposals[1].entry.start") && e.includes("2021"))).toBe(true);
    }
  });

  test("two new proposals for the same item are an error", () => {
    const r = validateImport({ ...base, proposals: [acme, acme] }, { profile: profile(), sourceText: resumeText });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("proposals[1]: duplicates proposals[0]");
  });

  test("skills additions must appear in the source", () => {
    const r = validateImport({ ...base, skills: { Languages: ["Rust", "Kafka"] } }, { profile: profile(), sourceText: resumeText });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([`skills.Languages[1]: "Kafka" does not appear in the source`]);
  });

  test("about fields must appear in the source", () => {
    const ok = validateImport(
      { ...base, about: { name: "Jordan Example", email: "JORDAN@example.com", phone: "+1 (514) 555-0100", links: [{ label: "Site", url: "https://jordan.dev/" }] } },
      { profile: profile(), sourceText: resumeText, sourceHtml: '<a href="https://jordan.dev">site</a>' },
    );
    expect(ok.ok).toBe(true);
    const bad = validateImport(
      { ...base, about: { name: "Jordan Smith", email: "j@other.com", phone: "+1 999 555 0100", links: [{ label: "GitHub", url: "https://github.com/jx" }], summary: "Engineer with 12 years" } },
      { profile: profile(), sourceText: resumeText },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      for (const f of ["about.name", "about.email", "about.phone", "about.links[0].url", "about.summary"]) {
        expect(bad.errors.some((e) => e.startsWith(f))).toBe(true);
      }
    }
  });

  test("characters the renderer can't typeset are errors", () => {
    const r = validateImport(
      { ...base, proposals: [{ ...acme, entry: { ...acme.entry, title: "Staff Engineer ★" } }] },
      { profile: profile(), sourceText: resumeText + "\nStaff Engineer ★" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("proposals[0].entry.title") && e.includes("★"))).toBe(true);
  });

  test("schema errors use the agent-facing path", () => {
    const r = validateImport({ proposals: [{ kind: "new", entry: { type: "experience" }, rationale: "x" }] }, { profile: profile(), sourceText: resumeText });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("proposals[0].entry.title"))).toBe(true);
  });
});

describe("importFlags", () => {
  test("lists unsourced proper nouns once", () => {
    const flags = importFlags(
      { ...acme.entry, type: "experience", context: "Ran Kubernetes upgrades.", bullets: ["Moved to Kubernetes and Envoy"] } as never,
      [resumeText],
    );
    expect(flags).toEqual([`unsourced "Kubernetes"`, `unsourced "Envoy"`]);
  });
});

describe("readImportSource", () => {
  test("LinkedIn login wall gives the Save to PDF hint", async () => {
    const page = `<html><body><p>Sign in to LinkedIn. ${Array(40).fill("word").join(" ")}</p></body></html>`;
    const fetchImpl = (async () => new Response(page)) as unknown as typeof fetch;
    const err = await readImportSource("https://www.linkedin.com/in/x", { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.hint).toContain("Save to PDF");
  });

  test("a thin non-LinkedIn page gives the generic hint", async () => {
    const fetchImpl = (async () => new Response("<html><body><p>hello there</p></body></html>")) as unknown as typeof fetch;
    const err = await readImportSource("https://jordan.dev/", { fetchImpl }).catch((e) => e);
    expect(err.message).toMatch(/Couldn't read enough of https:\/\/jordan\.dev\/ \(2 words\)/);
    expect(err.hint).toBe("Save the page as PDF (or copy its text into a .md file) and import that file");
  });

  test("LinkedIn login wall applies at any length", async () => {
    const page = `<html><body><p>Sign in to LinkedIn. ${Array(400).fill("word").join(" ")}</p></body></html>`;
    const fetchImpl = (async () => new Response(page)) as unknown as typeof fetch;
    await expect(readImportSource("https://linkedin.com/in/x", { fetchImpl })).rejects.toThrow("Login wall at https://linkedin.com/in/x");
  });

  test("a thin non-LinkedIn page with Sign in is a login wall", async () => {
    const page = `<html><body><p>Sign in to continue. ${Array(40).fill("word").join(" ")}</p></body></html>`;
    const fetchImpl = (async () => new Response(page)) as unknown as typeof fetch;
    const err = await readImportSource("https://jordan.dev/", { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe("Login wall at https://jordan.dev/");
    expect(err.hint).toBe("Save the page as PDF (or copy its text into a .md file) and import that file");
  });

  test("a real page mentioning design in / Sign in is not a login wall", async () => {
    const words = Array(160).fill("engineering").join(" ");
    const page = `<html><body><header><a href="/login">Sign in</a></header><article><p>Led the API design in 2023. Wrote a blog in Go. ${words}</p></article></body></html>`;
    const fetchImpl = (async () => new Response(page)) as unknown as typeof fetch;
    const s = await readImportSource("https://jordan.dev/", { fetchImpl });
    expect(s.text).toContain("Led the API design in 2023.");
    const short = `<html><body><p>Led the API design in 2023 and kept a catalog in order. ${Array(40).fill("word").join(" ")}</p></body></html>`;
    const s2 = await readImportSource("https://jordan.dev/", { fetchImpl: (async () => new Response(short)) as unknown as typeof fetch });
    expect(s2.text).toContain("design in 2023");
  });

  test("a readable page", async () => {
    const words = Array(40).fill("engineering").join(" ");
    const fetchImpl = (async () => new Response(`<html><body><article><p>Jordan Example builds robots. ${words}</p></article></body></html>`)) as unknown as typeof fetch;
    const s = await readImportSource("https://jordan.dev/", { fetchImpl });
    expect(s.kind).toBe("url");
    expect(s.ref).toBe("https://jordan.dev/");
    expect(s.text).toContain("Jordan Example builds robots.");
    expect(s.html).toContain("<article>");
  });

  test("markdown is read as is; html is converted", async () => {
    const md = await readImportSource(RESUME);
    expect(md).toMatchObject({ kind: "text", text: resumeText, warnings: [] });
    const dir = mkdtempSync(join(tmpdir(), "import-src-"));
    const h = join(dir, "cv.html");
    writeFileSync(h, "<html><body><h1>Jordan Example</h1><p>Staff Engineer</p></body></html>");
    const html = await readImportSource(h);
    expect(html.kind).toBe("html");
    expect(html.text).toContain("Jordan Example");
    expect(html.text).not.toContain("<h1>");
    expect(html.html).toContain("<h1>");
  });

  test("long text is truncated with a warning; empty text is an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-src-"));
    const long = join(dir, "long.txt");
    writeFileSync(long, "word ".repeat(30_000));
    const s = await readImportSource(long);
    expect(s.text).toHaveLength(100_000);
    expect(s.warnings).toEqual(["source truncated to 100000 characters"]);
    const empty = join(dir, "empty.md");
    writeFileSync(empty, "  \n");
    await expect(readImportSource(empty)).rejects.toThrow(`${empty} is empty`);
  });

  test("pdftotext missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-src-"));
    const f = join(dir, "cv.pdf");
    writeFileSync(f, minimalPdf("Jordan Example"));
    const err = await readImportSource(f, { pdftotext: "/nonexistent/pdftotext" }).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe("pdftotext is required to import PDFs");
    expect(err.hint).toContain("brew install poppler");
  });

  test.skipIf(!hasPdftotext)("text PDF is extracted and attached; an empty PDF is rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-src-"));
    const f = join(dir, "cv.pdf");
    writeFileSync(
      f,
      minimalPdf(
        "Jordan Example Staff Engineer at Acme Robotics since 2025. Cut fleet downtime 35% across 120 robots. Before that a Senior Software Engineer at Atlas Labs in Montreal.",
      ),
    );
    const s = await readImportSource(f);
    expect(s.kind).toBe("pdf");
    expect(s.text).toContain("Acme Robotics");
    expect(s.text).toContain("Atlas Labs");
    expect(s.attachment?.name).toBe("source.pdf");
    expect(s.attachment?.bytes.length).toBeGreaterThan(0);
    const blank = join(dir, "blank.pdf");
    writeFileSync(blank, minimalPdf(""));
    await expect(readImportSource(blank)).rejects.toThrow(`No extractable text in ${blank} (scanned image?)`);
  });

  test("docx falls back through textutil, pandoc and unzip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-src-"));
    const f = join(dir, "cv.docx");
    writeFileSync(f, "not really a docx");
    const seen: string[] = [];
    const run = async (argv: string[]) => {
      seen.push(argv[0]!);
      return argv[0] === "unzip" ? { code: 0, stdout: "<w:p><w:r><w:t>Jordan Example</w:t></w:r></w:p>" } : null;
    };
    const s = await readImportSource(f, { run });
    expect(seen).toEqual(["textutil", "pandoc", "unzip"]);
    expect(s).toMatchObject({ kind: "docx", text: "Jordan Example\n" });
    await expect(readImportSource(f, { run: async () => null })).rejects.toThrow(
      "Can't read .docx: none of textutil, pandoc or unzip is installed",
    );
  });

  test.skipIf(!hasTextutil)("a real .docx round-trips through textutil", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-src-"));
    const txt = join(dir, "cv.txt");
    const text = "Jordan Example\nStaff Engineer, Acme Robotics\nR&D lead, C#";
    writeFileSync(txt, text);
    const proc = Bun.spawnSync(["textutil", "-convert", "docx", "-output", join(dir, "cv.docx"), txt]);
    expect(proc.exitCode).toBe(0);
    const s = await readImportSource(join(dir, "cv.docx"));
    expect(s.kind).toBe("docx");
    expect(s.text.trim()).toBe(text);
  });
});

describe("docxXmlToText", () => {
  test("paragraphs, entities", () => {
    expect(docxXmlToText("<w:p><w:r><w:t>R&amp;D lead</w:t></w:r></w:p><w:p><w:r><w:t>C#</w:t></w:r></w:p>")).toBe("R&D lead\nC#\n");
  });
  test("tabs and breaks", () => {
    expect(docxXmlToText('<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t xml:space="preserve">&lt;c&gt; &quot;d&quot; &apos;e&apos;</w:t></w:r></w:p>')).toBe(
      "a\tb\n<c> \"d\" 'e'\n",
    );
  });
});
