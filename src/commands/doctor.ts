import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultConfig, loadConfig, type Config } from "../config";
import { UserError } from "../errors";
import { layout } from "../paths";
import { spawnWithTimeout } from "../proc";
import { loadProfile } from "../profile/load";
import { type AdapterConfig, PRESETS, resolveAdapter } from "../harness/adapter";
import { templateDirs, templateProblems } from "../render/templates";
import { scanTemplates, type TemplateMeta } from "../render/render";

export type Probe = (argv: string[]) => Promise<{ code: number | null; stdout: string; missing: boolean }>;

export type DoctorCheck = {
  group: "Harnesses" | "LaTeX" | "Templates" | "Tools" | "Data root";
  label: string;
  ok: boolean;
  required: boolean;
  detail?: string;
  hint?: string;
};

const PROBE_TIMEOUT_MS = 15_000;

const defaultProbe: Probe = async (argv) => {
  try {
    const r = await spawnWithTimeout(argv, { cwd: process.cwd(), env: process.env, timeoutMs: PROBE_TIMEOUT_MS });
    return { code: r.exitCode, stdout: r.stdout, missing: false };
  } catch (e) {
    return { code: null, stdout: "", missing: (e as NodeJS.ErrnoException).code === "ENOENT" };
  }
};

const AUTH_HINTS: Record<string, string> = {
  claude: "Run: claude auth login",
  codex: "Run: codex login",
  pi: "Configure a provider (pi auth check --provider <name>) and set adapters.pi.auth_check to match",
};

export async function checkHarness(
  name: string,
  a: AdapterConfig,
  probe: Probe,
  required: boolean,
): Promise<{ installed: boolean; authenticated: boolean | null; checks: DoctorCheck[] }> {
  const bin = a.command[0] ?? name;
  const r = await probe(a.check ?? [bin, "--version"]);
  const installed = !r.missing && r.code === 0;
  const firstLine = r.stdout.split("\n").map((l) => l.trim()).find(Boolean);
  const detail = installed ? [firstLine, a.research_command ? "web research" : undefined].filter(Boolean).join(", ") || undefined : undefined;
  const checks: DoctorCheck[] = [
    { group: "Harnesses", label: `${name}: installed`, ok: installed, required, detail, hint: installed ? undefined : `Install ${bin}` },
  ];
  let authenticated: boolean | null = null;
  if (installed && a.auth_check) {
    const ar = await probe(a.auth_check);
    authenticated = !ar.missing && ar.code === 0;
    checks.push({
      group: "Harnesses",
      label: `${name}: authenticated`,
      ok: authenticated,
      required,
      hint: authenticated ? undefined : (AUTH_HINTS[name] ?? `Log in to ${name}`),
    });
  } else if (installed && name === "pi") {
    checks.push({ group: "Harnesses", label: "pi: authenticated", ok: true, required: false, detail: "not checked", hint: AUTH_HINTS.pi });
  }
  return { installed, authenticated, checks };
}

const errText = (e: unknown) => (e instanceof UserError ? `${e.message}${e.hint ? ` (${e.hint})` : ""}` : e instanceof Error ? e.message : String(e));

function dataRootChecks(root: string): { checks: DoctorCheck[]; config: Config } {
  const g = "Data root" as const;
  const l = layout(root);
  const checks: DoctorCheck[] = [];
  const hasRoot = existsSync(l.config);
  checks.push({ group: g, label: "data root", ok: hasRoot, required: true, detail: root, hint: hasRoot ? undefined : "Run: resumely init" });
  if (!hasRoot) return { checks, config: defaultConfig() };

  let config = defaultConfig();
  try {
    config = loadConfig(root);
    checks.push({ group: g, label: "config.toml parses", ok: true, required: true });
  } catch (e) {
    checks.push({ group: g, label: "config.toml parses", ok: false, required: true, detail: errText(e) });
  }

  try {
    const p = loadProfile(l.profile);
    checks.push({ group: g, label: "profile loads", ok: true, required: true, detail: `${p.entries.length} entries` });
    checks.push({ group: g, label: "about.md present", ok: true, required: true });
    const filled = p.about.name !== "Your Name" && p.entries.length > 0;
    checks.push({ group: g, label: "profile filled in", ok: filled, required: true, hint: filled ? undefined : "Edit profile/about.md and add entries" });
  } catch (e) {
    checks.push({ group: g, label: "profile loads", ok: false, required: true, detail: errText(e) });
    const hasAbout = existsSync(join(l.profile, "about.md"));
    checks.push({ group: g, label: "about.md present", ok: hasAbout, required: true, hint: hasAbout ? undefined : "Run: resumely init" });
  }
  return { checks, config };
}

function harnessNames(config: Config): string[] {
  return [...new Set([config.harness, ...Object.keys(PRESETS), ...Object.keys(config.adapters)])];
}

async function templateChecks(root: string, config: Config, probe: Probe, which: (b: string) => string | null): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const problems: string[] = [];
  let templates: TemplateMeta[] = [];
  try {
    templates = scanTemplates(templateDirs(root), problems);
  } catch (e) {
    problems.push(errText(e));
  }
  const defaultTpl = templates.find((t) => t.id === config.template);
  const texHint = "Install TeX Live (macOS: brew install --cask mactex-no-gui)";

  checks.push({ group: "LaTeX", label: "latexmk", ok: !!which("latexmk"), required: true, hint: which("latexmk") ? undefined : texHint });
  for (const engine of [...new Set(templates.map((t) => t.engine))].sort()) {
    const users = templates.filter((t) => t.engine === engine).map((t) => t.id);
    const found = !!which(engine);
    checks.push({ group: "LaTeX", label: engine, ok: found, required: defaultTpl?.engine === engine, detail: `used by ${users.join(", ")}`, hint: found ? undefined : texHint });
  }

  if (!defaultTpl) checks.push({ group: "Templates", label: `${config.template}: not found`, ok: false, required: true, hint: "Run: resumely templates list" });
  for (const t of templates) {
    const files = [...t.packages.map((p) => (p.includes(".") ? p : `${p}.sty`)), ...t.fonts];
    const required = t.id === config.template;
    const r = files.length ? await probe(["kpsewhich", ...files]) : { code: 0, stdout: "", missing: false };
    if (r.missing) {
      checks.push({ group: "Templates", label: t.id, ok: false, required, detail: "kpsewhich not found", hint: texHint });
      continue;
    }
    const found = new Set(r.stdout.split("\n").map((l) => basename(l.trim())).filter(Boolean));
    const missing = files.filter((f) => !found.has(f));
    if (missing.length === 0) {
      checks.push({ group: "Templates", label: t.id, ok: true, required, detail: `${t.packages.length} packages, ${t.fonts.length} fonts` });
    } else {
      checks.push({ group: "Templates", label: t.id, ok: false, required, detail: `missing ${missing.join(", ")}`, hint: `tlmgr install ${missing.map((f) => f.replace(/\.[^.]+$/, "")).join(" ")}` });
    }
  }
  for (const p of problems) checks.push({ group: "Templates", label: "template problem", ok: false, required: false, detail: p });
  return checks;
}

export async function runDoctor(o: { root: string; probe?: Probe; which?: (bin: string) => string | null }): Promise<DoctorCheck[]> {
  const probe = o.probe ?? defaultProbe;
  const which = o.which ?? ((b: string) => Bun.which(b));
  const { checks: rootChecks, config } = dataRootChecks(o.root);
  const out: DoctorCheck[] = [];

  for (const name of harnessNames(config)) {
    let adapter: AdapterConfig;
    try {
      adapter = resolveAdapter(name, config);
    } catch (e) {
      out.push({ group: "Harnesses", label: `${name}: installed`, ok: false, required: name === config.harness, detail: errText(e) });
      continue;
    }
    out.push(...(await checkHarness(name, adapter, probe, name === config.harness)).checks);
  }
  out.push(...(await templateChecks(o.root, config, probe, which)));
  out.push({
    group: "Tools",
    label: "pdftotext",
    ok: !!which("pdftotext"),
    required: false,
    hint: which("pdftotext") ? undefined : "Install poppler (macOS: brew install poppler) for the ATS check",
  });
  out.push(...rootChecks);
  return out;
}

const GROUPS: DoctorCheck["group"][] = ["Data root", "Harnesses", "LaTeX", "Templates", "Tools"];

export function formatDoctor(checks: DoctorCheck[]): { text: string; failed: number } {
  const lines: string[] = [];
  for (const g of GROUPS) {
    const items = checks.filter((c) => c.group === g);
    if (!items.length) continue;
    lines.push(g);
    for (const c of items) {
      lines.push(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}${!c.ok && !c.required ? " (optional)" : ""}`);
      if (c.hint) lines.push(`      hint: ${c.hint}`);
    }
    lines.push("");
  }
  const failed = checks.filter((c) => !c.ok && c.required).length;
  lines.push(failed === 0 ? "All required checks passed." : `${failed} required check(s) failed.`);
  return { text: lines.join("\n"), failed };
}
