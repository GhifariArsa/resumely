import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { UserError } from "../errors";
import { spawnWithTimeout } from "../proc";

export type JobSource = {
  kind: "file" | "clipboard" | "url" | "editor";
  text: string;
  url?: string;
  path?: string;
  html?: string;
};

const CLIP_HINT = "Copy the job text and run: resumely apply --clip";
const THIN_RE = /enable javascript|sign in to view|log in to see/i;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BLOCK_PARA = "p,h1,h2,h3,h4,h5,h6,div,section,article,ul,ol,table,blockquote,pre,header,footer";
const BLOCK_LINE = "li,tr,dt,dd";

/** Insert newline text nodes at block boundaries so textContent keeps words apart. */
function markBlocks(document: Document): void {
  for (const br of Array.from(document.querySelectorAll("br"))) br.replaceWith(document.createTextNode("\n"));
  for (const el of Array.from(document.querySelectorAll(BLOCK_PARA))) {
    el.before(document.createTextNode("\n\n"));
    el.after(document.createTextNode("\n\n"));
  }
  for (const el of Array.from(document.querySelectorAll(BLOCK_LINE))) {
    el.before(document.createTextNode("\n"));
    el.after(document.createTextNode("\n"));
  }
}

function htmlToText(html: string): string {
  const { document } = parseHTML(html);
  markBlocks(document as unknown as Document);
  let text: string | null | undefined;
  try {
    text = new Readability(document as unknown as Document).parse()?.textContent;
  } catch {
    text = null;
  }
  if (!text || !text.trim()) text = document.body?.textContent ?? "";
  return normalise(text);
}

export function isThin(text: string): boolean {
  return wordCount(text) < 150 || THIN_RE.test(text);
}

export async function readJobFile(path: string): Promise<JobSource> {
  const ext = extname(path).toLowerCase();
  if (ext !== ".md" && ext !== ".txt" && ext !== ".html" && ext !== ".htm") {
    throw new UserError(`Unsupported job file type "${ext || path}"`, "Use a .md, .txt or .html file, or run: resumely apply --clip");
  }
  const f = Bun.file(path);
  if (!(await f.exists())) throw new UserError(`Job file not found: ${path}`);
  const raw = await f.text();
  const isHtml = ext === ".html" || ext === ".htm";
  const text = isHtml ? htmlToText(raw) : raw;
  if (!text.trim()) throw new UserError(`Job file is empty: ${path}`);
  return isHtml ? { kind: "file", path, html: raw, text } : { kind: "file", path, text };
}

const CLIP_CMDS = [["pbpaste"], ["wl-paste"], ["xclip", "-selection", "clipboard", "-o"]];

async function defaultRun(cmd: string[]): Promise<string> {
  const r = await spawnWithTimeout(cmd, { cwd: process.cwd(), timeoutMs: 5000 });
  if (r.timedOut || r.exitCode !== 0) throw new Error(`${cmd[0]} failed`);
  return r.stdout;
}

export async function readClipboard(run: (cmd: string[]) => Promise<string> = defaultRun): Promise<JobSource> {
  for (const cmd of CLIP_CMDS) {
    let out: string;
    try {
      out = await run(cmd);
    } catch {
      continue; // binary missing or failed; try next
    }
    if (out.trim()) return { kind: "clipboard", text: out };
    throw new UserError("Clipboard is empty", "Copy the job description text, then rerun");
  }
  throw new UserError("Couldn't read the clipboard", "Install pbpaste, wl-paste or xclip, or pass a file instead");
}

export async function fetchJobUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<JobSource> {
  let html: string;
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": "resumely/0.1" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new UserError(`Couldn't fetch ${url} (HTTP ${res.status})`, CLIP_HINT);
    html = await res.text();
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`Couldn't fetch ${url} (${e instanceof Error ? e.message : String(e)})`, CLIP_HINT);
  }
  const text = htmlToText(html);
  if (isThin(text)) {
    throw new UserError(`Couldn't read enough of that page (${wordCount(text)} words)`, CLIP_HINT);
  }
  return { kind: "url", url, text, html };
}

const EDITOR_HEADER = "<!-- resumely: paste the job posting below, then save and close the editor. Leave it empty to cancel. -->";

const defaultSpawn = (argv: string[], env: Record<string, string | undefined>): Promise<number | null> =>
  Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } }).exited;

/** Open `$VISUAL`/`$EDITOR` (split into argv, never through a shell) on a temp file and read the pasted posting back. */
export async function readFromEditor(
  o: { env?: Record<string, string | undefined>; spawn?: (argv: string[]) => Promise<number | null> } = {},
): Promise<JobSource> {
  const env = o.env ?? process.env;
  const editor = env.VISUAL || env.EDITOR || "vi";
  const argv = existsSync(editor) ? [editor] : editor.trim().split(/\s+/);
  const dir = mkdtempSync(join(tmpdir(), "resumely-job-"));
  try {
    const file = join(dir, "job.md");
    writeFileSync(file, `${EDITOR_HEADER}\n\n`);
    const full = [...argv, file];
    let code: number | null;
    try {
      code = await (o.spawn ?? ((a) => defaultSpawn(a, env)))(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new UserError(`Editor not found: ${argv[0]}`, "Set $EDITOR, or use --clip or a file");
      throw e;
    }
    if (code !== 0) throw new UserError(`Editor exited with status ${code}`, "Nothing was saved");
    const text = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.startsWith("<!-- resumely:"))
      .join("\n")
      .trim();
    if (!text) throw new UserError("No job text entered", "Nothing was saved");
    return { kind: "editor", text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function resolveJobInput(
  arg: string | undefined,
  opts: { clip?: boolean; interactive?: boolean; editor?: Parameters<typeof readFromEditor>[0] },
): Promise<JobSource> {
  if (opts.clip) return readClipboard();
  if (!arg) {
    if (opts.interactive) return readFromEditor(opts.editor);
    throw new UserError("No job given", "resumely apply <url|file>, --clip, or run it in a terminal to paste into $EDITOR");
  }
  if (/^https?:\/\//i.test(arg)) return fetchJobUrl(arg);
  if (existsSync(arg)) return readJobFile(arg);
  throw new UserError(`Job file not found: ${arg}`, "resumely apply <url|file> or --clip");
}
