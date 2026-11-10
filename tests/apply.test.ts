import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";
import { applyJob, renderApplication, formatApplicationList } from "../src/pipeline/apply";
import { readJobFile } from "../src/job/intake";
import { findApplication, listApplications } from "../src/application/store";
import { UserError } from "../src/errors";

const fx = join(import.meta.dir, "fixtures");
const hasLatex = Bun.which("latexmk") !== null;
const parsedJob = {
  company: "Atlas Freight",
  role: "Senior Backend Engineer",
  requirements: ["Rust", "Kafka"],
  nice_to_haves: [],
  keywords: ["Go", "PostgreSQL"],
  language: "en",
};
const resume = JSON.parse(readFileSync(join(fx, "resume-content.json"), "utf8"));
const badResume = structuredClone(resume);
badResume.sections[0].items[0].bullets[0].entry_ids = ["ghost"];

let root: string;
let savedEnv: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-apply-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  writeFileSync(
    layout(root).config,
    `harness = "fake"\n[adapters.fake]\ncommand = ["bun", "${join(fx, "fake-harness.ts")}", "{workspace}"]\n`,
  );
  savedEnv = process.env.FAKE_HARNESS_SCRIPT;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.FAKE_HARNESS_SCRIPT;
  else process.env.FAKE_HARNESS_SCRIPT = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

function script(s: Record<string, Record<string, unknown>>) {
  const p = join(root, "script.json");
  writeFileSync(p, JSON.stringify(s));
  process.env.FAKE_HARNESS_SCRIPT = p;
}
const parseOut = { "out/parsed-job.json": parsedJob };
const writeOut = (r: unknown) => ({ "out/resume.json": r });
const run = async () => applyJob({ root, input: await readJobFile(join(fx, "jobs/backend.md")), open: false });

describe.skipIf(!hasLatex)("applyJob (compiles)", () => {
  test("happy path", async () => {
    script({ "0": parseOut, "1": writeOut(resume) });
    const { app, pages } = await run();
    expect(app.slug).toMatch(/-atlas-freight-/);
    const v1 = join(app.dir, "resume/v1");
    for (const f of ["resume.json", "resume.tex", "Jordan_Example_Resume_AtlasFreight.pdf", "trace.json", "entries.snapshot.json", "meta.json"]) {
      expect(existsSync(join(v1, f))).toBe(true);
    }
    const meta = JSON.parse(readFileSync(join(v1, "meta.json"), "utf8"));
    expect(meta.mode).toBe("truthful");
    expect(meta.template).toBe("classic");
    expect(meta.pages).toBe(pages);
    expect(meta.target_pages).toBe(1);
    expect(existsSync(meta.run)).toBe(true);
    const snap = JSON.parse(readFileSync(join(v1, "entries.snapshot.json"), "utf8")) as { id: string }[];
    const ids = new Set<string>();
    const walk = (c: any) => {
      c.summary?.entry_ids.forEach((i: string) => ids.add(i));
      for (const s of c.sections) for (const it of s.items) { ids.add(it.entry_id); it.bullets.forEach((b: any) => b.entry_ids.forEach((i: string) => ids.add(i))); }
    };
    walk(resume);
    expect(snap.map((e) => e.id).sort()).toEqual([...ids].sort());
    const trace = JSON.parse(readFileSync(join(v1, "trace.json"), "utf8"));
    expect(trace[0]).toMatchObject({ section: "summary", item: "", bullet: 0 });
    expect(trace[1]).toMatchObject({ section: "Experience", item: "Senior Software Engineer", bullet: 0, basis: "direct" });
  });

  test("retry after invalid JSON keeps errors.md", async () => {
    script({ "0": parseOut, "1": { "out/resume.json": "INVALID" }, "2": writeOut(resume) });
    const { app } = await run();
    expect(existsSync(join(app.dir, "resume/v1/resume.json"))).toBe(true);
    const runs = layout(root).runs;
    const runDir = join(runs, readdirSync(runs)[0]!);
    expect(existsSync(join(runDir, "write/errors.md"))).toBe(true);
  });

  test("render into a new version with another template", async () => {
    script({ "0": parseOut, "1": writeOut(resume) });
    const { app } = await run();
    const r = await renderApplication({ root, query: "atlas", template: "classic", open: false });
    expect(r.version).toBe(2);
    const a = readFileSync(join(app.dir, "resume/v1/resume.json"), "utf8");
    expect(readFileSync(join(app.dir, "resume/v2/resume.json"), "utf8")).toBe(a);
    const meta = JSON.parse(readFileSync(join(app.dir, "resume/v2/meta.json"), "utf8"));
    expect(meta.rendered_from).toBe(1);
    expect(existsSync(join(app.dir, "resume/v2/trace.json"))).toBe(true);
    expect(existsSync(join(app.dir, "resume/v2/entries.snapshot.json"))).toBe(true);
    expect(findApplication(layout(root).applications, "atlas").slug).toBe(app.slug);
    const out = formatApplicationList(listApplications(layout(root).applications));
    expect(out).toContain("Atlas Freight");
    expect(out).toContain("v2");
  });

  test("render resolves from the frozen snapshot and recomputes trace from edited content", async () => {
    script({ "0": parseOut, "1": writeOut(resume) });
    const { app } = await run();
    const live = join(layout(root).profile, "experience/atlas-labs.md");
    writeFileSync(live, readFileSync(live, "utf8").replace("title: Senior Software Engineer", "title: Chief Everything Officer"));
    const edited = structuredClone(resume);
    edited.sections[0].items[0].bullets[0].text = "Rebuilt the billing dashboard with a team of 4.";
    writeFileSync(join(app.dir, "resume/v1/resume.json"), JSON.stringify(edited));
    await renderApplication({ root, query: "atlas", template: "classic", open: false });
    const tex = readFileSync(join(app.dir, "resume/v2/resume.tex"), "utf8");
    expect(tex).toContain("{Senior Software Engineer}{Mar 2023 – Present}");
    expect(tex).not.toContain("Chief Everything Officer");
    const trace = JSON.parse(readFileSync(join(app.dir, "resume/v2/trace.json"), "utf8"));
    expect(trace[1]).toMatchObject({ item: "Senior Software Engineer", text: "Rebuilt the billing dashboard with a team of 4." });
    expect(readFileSync(join(app.dir, "resume/v2/entries.snapshot.json"), "utf8")).toBe(readFileSync(join(app.dir, "resume/v1/entries.snapshot.json"), "utf8"));
  });

  test("compile failure after a valid agent run names the saved content", async () => {
    const tpl = join(layout(root).templates, "broken");
    mkdirSync(tpl, { recursive: true });
    writeFileSync(join(tpl, "template.toml"), 'id = "broken"\nengine = "pdflatex"\n');
    writeFileSync(join(tpl, "resume.tex.njk"), "\\documentclass{article}\\begin{document}\\undefinedmacro\\end{document}\n");
    script({ "0": parseOut, "1": writeOut(resume) });
    const e = (await applyJob({ root, input: await readJobFile(join(fx, "jobs/backend.md")), template: "broken", open: false }).catch((x) => x)) as UserError;
    expect(e).toBeInstanceOf(UserError);
    expect(e.message).toBe("LaTeX compile failed");
    expect(e.hint).toMatch(/^! Undefined control sequence\. — content saved at .*\/\.runs\/[^/]+\/write\/out\/resume\.json$/);
    expect(existsSync(e.hint!.split("content saved at ")[1]!)).toBe(true);
  });
});

test("missing latexmk fails before any agent call", async () => {
  script({ "0": parseOut, "1": writeOut(resume) });
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  let e: UserError | undefined;
  try {
    e = await run().catch((x) => x);
  } finally {
    process.env.PATH = saved;
  }
  expect(e).toBeInstanceOf(UserError);
  expect(e!.message).toBe("latexmk not found");
  expect(e!.hint).toBe("Install TeX Live (macOS: brew install --cask mactex-no-gui)");
  expect(existsSync(join(root, "script.json.count"))).toBe(false);
});

test.skipIf(!hasLatex)("unknown entry id on all write attempts: app exists, no version", async () => {
  script({ "0": parseOut, "1": writeOut(badResume), "2": writeOut(badResume), "3": writeOut(badResume) });
  let err: unknown;
  await run().catch((e) => (err = e));
  expect(err).toBeInstanceOf(UserError);
  expect((err as UserError).message).toContain("after 3 attempts");
  const apps = listApplications(layout(root).applications);
  expect(apps.length).toBe(1);
  expect(existsSync(join(apps[0]!.dir, "resume"))).toBe(false);
});

test.skipIf(!hasLatex)("invalid parse on all attempts: no application dir", async () => {
  script({ "0": { "out/parsed-job.json": "INVALID" }, "1": { "out/parsed-job.json": "INVALID" }, "2": { "out/parsed-job.json": "INVALID" } });
  await expect(run()).rejects.toThrow("after 3 attempts");
  expect(listApplications(layout(root).applications)).toEqual([]);
  expect(existsSync(layout(root).applications) ? readdirSync(layout(root).applications) : []).toEqual([]);
});

test("ls with no applications", () => {
  expect(formatApplicationList([])).toBe("No applications yet. Try: resumely apply --clip");
});
