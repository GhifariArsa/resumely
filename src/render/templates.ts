import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { UserError } from "../errors";
import { layout, requireDataRoot } from "../paths";
import { builtinTemplatesDir, findTemplate, scanTemplates, type TemplateMeta } from "./render";

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  engine: string;
  supports: ("resume" | "cover-letter")[];
  source: "builtin" | "user";
  dir: string;
  preview: string | null;
}

export function templateDirs(root: string): string[] {
  return [builtinTemplatesDir(), layout(root).templates];
}

function toInfo(t: TemplateMeta): TemplateInfo {
  const preview = join(t.dir, "preview.png");
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    engine: t.engine,
    supports: t.supports,
    source: t.dir.startsWith(join(builtinTemplatesDir(), "/")) ? "builtin" : "user",
    dir: t.dir,
    preview: existsSync(preview) ? preview : null,
  };
}

/** The effective templates (a user template overrides a built-in with the same id). Invalid ones are skipped; never throws. */
export function listTemplates(root: string): TemplateInfo[] {
  return scanTemplates(templateDirs(root), []).map(toInfo);
}

export function templateProblems(root: string): string[] {
  const problems: string[] = [];
  scanTemplates(templateDirs(root), problems);
  return problems;
}

export function newTemplate(root: string, id: string, from: string): TemplateInfo {
  requireDataRoot(root);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new UserError(`Invalid template id "${id}"`, "Use lowercase letters, digits and dashes");
  const dirs = templateDirs(root);
  if (scanTemplates(dirs, []).some((t) => t.id === id) || existsSync(join(layout(root).templates, id))) {
    throw new UserError(`Template "${id}" already exists`, "Pick another id");
  }
  const base = findTemplate(from, dirs);
  const dest = join(layout(root).templates, id);
  mkdirSync(layout(root).templates, { recursive: true });
  cpSync(base.dir, dest, { recursive: true, filter: (src) => src !== join(base.dir, "preview.png") });
  const file = join(dest, "template.toml");
  const toml = parseToml(readFileSync(file, "utf8"));
  writeFileSync(file, stringifyToml({ ...toml, id, name: `${base.name} (custom)` }));
  return toInfo(findTemplate(id, dirs));
}

export function formatTemplateList(ts: TemplateInfo[]): string {
  const rows = [["ID", "NAME", "ENGINE", "SUPPORTS", "SOURCE"], ...ts.map((t) => [t.id, t.name, t.engine, t.supports.join(","), t.source])];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const table = rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
  const details = ts.flatMap((t) => [`${t.id}: ${t.description}`, ...(t.preview ? [`  preview: ${t.preview}`] : [])]);
  return [...table, "", ...details].join("\n");
}
