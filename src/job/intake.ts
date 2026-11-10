import { existsSync } from "node:fs";
import { extname } from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { UserError } from "../errors";
import { spawnWithTimeout } from "../proc";

export type JobSource = {
  kind: "file" | "clipboard" | "url";
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

function htmlToText(html: string): string {
  const { document } = parseHTML(html);
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
  if (ext === ".html" || ext === ".htm") return { kind: "file", path, html: raw, text: htmlToText(raw) };
  return { kind: "file", path, text: raw };
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
    const res = await fetchImpl(url, { headers: { "User-Agent": "resumely/0.1" }, redirect: "follow" });
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

export async function resolveJobInput(arg: string | undefined, opts: { clip?: boolean }): Promise<JobSource> {
  if (opts.clip) return readClipboard();
  if (!arg) throw new UserError("No job given", "resumely apply <url|file> or --clip");
  if (/^https?:\/\//i.test(arg)) return fetchJobUrl(arg);
  if (existsSync(arg)) return readJobFile(arg);
  throw new UserError(`Job file not found: ${arg}`, "resumely apply <url|file> or --clip");
}
