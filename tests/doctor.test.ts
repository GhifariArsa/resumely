import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { formatDoctor, runDoctor, type Probe } from "../src/commands/doctor";
import { layout } from "../src/paths";

const fx = join(import.meta.dir, "fixtures");
const ALL_FILES = [
  "latexsym.sty", "amssymb.sty", "fullpage.sty", "titlesec.sty", "marvosym.sty", "color.sty", "verbatim.sty", "enumitem.sty", "hyperref.sty", "fancyhdr.sty", "babel.sty", "tabularx.sty",
  "fontspec.sty", "accsupp.sty", "xcolor.sty", "geometry.sty", "fontawesome5.sty", "moderncv.cls",
  "SourceSansPro-Regular.otf", "SourceSansPro-Bold.otf", "SourceSansPro-RegularIt.otf", "SourceSansPro-BoldIt.otf", "SourceSansPro-Light.otf",
  "texgyretermes-regular.otf", "texgyretermes-bold.otf", "texgyretermes-italic.otf", "texgyretermes-bolditalic.otf",
];

function fakeProbe(table: Record<string, { code: number | null; stdout?: string }>, opts: { without?: string[] } = {}): Probe {
  return async (argv) => {
    if (argv[0] === "kpsewhich") {
      const found = argv.slice(1).filter((f) => ALL_FILES.includes(f) && !(opts.without ?? []).includes(f));
      return { code: 0, stdout: found.map((f) => `/tex/${f}`).join("\n"), missing: false };
    }
    const hit = table[argv.join(" ")];
    return hit ? { code: hit.code, stdout: hit.stdout ?? "", missing: false } : { code: null, stdout: "", missing: true };
  };
}
const okTable = {
  "claude --version": { code: 0, stdout: "2.1.0 (Claude Code)\n" },
  "claude auth status": { code: 0 },
  "codex --version": { code: 0, stdout: "codex 0.5\n" },
  "codex login status": { code: 0 },
  "pi --version": { code: 0, stdout: "pi 1.0\n" },
};
const which = (b: string) => `/usr/bin/${b}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-doctor-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = async (probe: Probe, r = root) => formatDoctor(await runDoctor({ root: r, probe, which }));

describe("doctor", () => {
  test("everything OK", async () => {
    const { text, failed } = await run(fakeProbe(okTable));
    expect(failed).toBe(0);
    expect(text).toContain("✓ claude: installed");
    expect(text).toContain("All required checks passed.");
    expect(text).not.toContain("✗");
  });

  test("claude auth failure is required and hinted", async () => {
    const { text, failed } = await run(fakeProbe({ ...okTable, "claude auth status": { code: 1 } }));
    expect(failed).toBe(1);
    expect(text).toContain("✗ claude: authenticated");
    expect(text).toContain("hint: Run: claude auth login");
  });

  test("pi auth is reported as not checked, not a failure", async () => {
    const { text, failed } = await run(fakeProbe(okTable));
    expect(failed).toBe(0);
    expect(text).toContain("pi: authenticated — not checked");
    expect(text).toContain("adapters.pi.auth_check");
  });

  test("missing non-default harness is optional", async () => {
    const table = { ...okTable } as Record<string, { code: number | null; stdout?: string }>;
    delete table["codex --version"];
    const { text, failed } = await run(fakeProbe(table));
    expect(text).toContain("✗ codex: installed (optional)");
    expect(text).toContain("hint: Install codex");
    expect(failed).toBe(0);
  });

  test("missing package: optional for a non-default template, required for the default", async () => {
    const probe = fakeProbe(okTable, { without: ["fontawesome5.sty"] });
    const a = await run(probe);
    expect(a.failed).toBe(0);
    expect(a.text).toMatch(/✗ minimal.*missing fontawesome5\.sty.*\(optional\)/);
    writeFileSync(layout(root).config, 'template = "minimal"\n');
    const b = await run(probe);
    expect(b.failed).toBe(1);
    expect(b.text).toContain("hint: tlmgr install fontawesome5");
  });

  test("no data root", async () => {
    const empty = mkdtempSync(join(tmpdir(), "resumely-doctor-empty-"));
    try {
      const { text, failed } = await run(fakeProbe(okTable), empty);
      expect(text).toContain("✗ data root");
      expect(text).toContain("hint: Run: resumely init");
      expect(text).toContain("Harnesses");
      expect(text).toContain("LaTeX");
      expect(failed).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("bad profile entry names the file", async () => {
    writeFileSync(join(layout(root).profile, "experience", "broken-entry.md"), "no frontmatter here\n");
    const { text, failed } = await run(fakeProbe(okTable));
    expect(failed).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/✗ profile loads.*broken-entry\.md/);
  });

  test("invalid user template is an optional line", async () => {
    mkdirSync(join(layout(root).templates, "broken"), { recursive: true });
    writeFileSync(join(layout(root).templates, "broken", "template.toml"), "id = 3\n");
    const { text, failed } = await run(fakeProbe(okTable));
    expect(failed).toBe(0);
    expect(text).toMatch(/✗ .*broken.*\(optional\)/);
  });

  test("CLI with an empty RESUMELY_HOME exits 1", async () => {
    const empty = mkdtempSync(join(tmpdir(), "resumely-doctor-cli-"));
    try {
      const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "doctor"], { env: { ...process.env, RESUMELY_HOME: empty }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(1);
      expect(out).toContain("Data root");
      expect(out).toContain("resumely init");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
