import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nunjucks from "nunjucks";
import { parse as parseToml } from "smol-toml";
import { UserError } from "../errors";
import type { About } from "../profile/schema";
import type { ResumeContent } from "../pipeline/schemas";
import { escapeDeep, latexUrl } from "./latex-escape";

export type TemplateMeta = {
  id: string;
  name: string;
  description: string;
  engine: "pdflatex" | "xelatex" | "lualatex";
  supports: ("resume" | "cover-letter")[];
  packages: string[];
  dir: string;
};

/** Built-in templates live in <repo>/templates, resolved independent of cwd. */
export function builtinTemplatesDir(): string {
  return join(import.meta.dir, "../../templates");
}

function readMeta(dir: string): TemplateMeta | undefined {
  const file = join(dir, "template.toml");
  if (!existsSync(file)) return undefined;
  let t: Record<string, unknown>;
  try {
    t = parseToml(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UserError(`Invalid template metadata: ${file}`, (e as Error).message);
  }
  if (typeof t.id !== "string" || !["pdflatex", "xelatex", "lualatex"].includes(t.engine as string)) {
    throw new UserError(`Invalid template metadata: ${file}`, "Needs string `id` and engine = pdflatex|xelatex|lualatex");
  }
  return {
    id: t.id,
    name: typeof t.name === "string" ? t.name : t.id,
    description: typeof t.description === "string" ? t.description : "",
    engine: t.engine as TemplateMeta["engine"],
    supports: (Array.isArray(t.supports) ? t.supports : ["resume"]) as TemplateMeta["supports"],
    packages: Array.isArray(t.packages) ? (t.packages as string[]) : [],
    dir,
  };
}

/** Later dirs override earlier ones with the same id. */
export function listTemplates(dirs: string[]): TemplateMeta[] {
  const byId = new Map<string, TemplateMeta>();
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const m = readMeta(join(d, e.name));
      if (m) byId.set(m.id, m);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function findTemplate(id: string, dirs: string[]): TemplateMeta {
  const all = listTemplates(dirs);
  const found = all.find((t) => t.id === id);
  if (!found) throw new UserError(`Unknown template "${id}"`, `Available templates: ${all.map((t) => t.id).join(", ") || "(none)"}`);
  return found;
}

export function renderResume(t: TemplateMeta, data: { about: About; content: ResumeContent }): string {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(t.dir), {
    autoescape: false,
    tags: {
      blockStart: "((*",
      blockEnd: "*))",
      variableStart: "(((",
      variableEnd: ")))",
      commentStart: "((=",
      commentEnd: "=))",
    },
  });
  env.addFilter("latexUrl", latexUrl);
  return env.render("resume.tex.njk", { ...escapeDeep(data), raw: data });
}
