import { existsSync } from "node:fs";
import { extname } from "node:path";
import { UserError } from "../errors";
import { fetchPage, htmlToText } from "../job/intake";
import { spawnWithTimeout } from "../proc";
import { extractPdfTextDetailed } from "../render/pdftext";

export type ImportSource = {
  kind: "pdf" | "docx" | "text" | "html" | "url";
  /** The file path as given, or the URL. */
  ref: string;
  text: string;
  html?: string;
  attachment?: { name: "source.pdf"; bytes: Uint8Array };
  warnings: string[];
};

export type RunCommand = (argv: string[]) => Promise<{ code: number | null; stdout: string } | null>;

const MAX_CHARS = 100_000;
const URL_HINT = "Save the page as PDF (or copy its text into a .md file) and import that file";
const LINKEDIN_HINT = "LinkedIn requires login: use More → Save to PDF on your profile and import the PDF";
const LOGIN_WALL = /sign in|log in|enable javascript/i;
const DOCX_HINT = "Save it as PDF or Markdown and import that";

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Runs argv; null when the binary is not installed. */
const defaultRun: RunCommand = async (argv) => {
  try {
    const r = await spawnWithTimeout(argv, { cwd: process.cwd(), timeoutMs: 30_000 });
    return { code: r.exitCode, stdout: r.stdout };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

/** Text of a DOCX `word/document.xml`: one line per paragraph, tabs and breaks kept, other markup dropped. */
export function docxXmlToText(xml: string): string {
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function fromUrl(url: string, fetchImpl?: typeof fetch): Promise<Omit<ImportSource, "warnings">> {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* fetchPage reports the bad URL */
  }
  const hint = host === "linkedin.com" || host.endsWith(".linkedin.com") ? LINKEDIN_HINT : URL_HINT;
  const { html, text } = await fetchPage(url, { fetchImpl, hint });
  const n = wordCount(text);
  if (n < 30 || LOGIN_WALL.test(text)) throw new UserError(`Couldn't read enough of ${url} (${n} words)`, hint);
  return { kind: "url", ref: url, text, html };
}

async function fromPdf(file: string, bin?: string): Promise<Omit<ImportSource, "warnings">> {
  const bytes = await Bun.file(file).bytes();
  const r = await extractPdfTextDetailed(bytes, { bin });
  if (r.reason === "missing") {
    throw new UserError("pdftotext is required to import PDFs", "macOS: brew install poppler · Debian/Ubuntu: apt install poppler-utils");
  }
  const text = r.text ?? "";
  if (wordCount(text) < 20) {
    throw new UserError(`No extractable text in ${file} (scanned image?)`, "Export a text-based PDF, or paste the text into a .md file and import that");
  }
  return { kind: "pdf", ref: file, text, attachment: { name: "source.pdf", bytes } };
}

async function fromDocx(file: string, run: RunCommand): Promise<Omit<ImportSource, "warnings">> {
  const tries: { argv: string[]; toText: (out: string) => string }[] = [
    { argv: ["textutil", "-convert", "txt", "-stdout", file], toText: (s) => s },
    { argv: ["pandoc", "-t", "plain", "--wrap=none", file], toText: (s) => s },
    { argv: ["unzip", "-p", file, "word/document.xml"], toText: docxXmlToText },
  ];
  let installed = 0;
  for (const t of tries) {
    const r = await run(t.argv);
    if (r === null) continue;
    installed++;
    if (r.code === 0 && r.stdout.trim()) return { kind: "docx", ref: file, text: t.toText(r.stdout) };
  }
  if (installed === 0) throw new UserError("Can't read .docx: none of textutil, pandoc or unzip is installed", DOCX_HINT);
  throw new UserError(`Couldn't read text from ${file}`, DOCX_HINT);
}

/** Read a resume (PDF, DOCX, Markdown, text, HTML) or a web page for `profile import`. Bad input throws `UserError`. */
export async function readImportSource(
  arg: string,
  o: { fetchImpl?: typeof fetch; run?: RunCommand; pdftotext?: string } = {},
): Promise<ImportSource> {
  let src: Omit<ImportSource, "warnings">;
  if (/^https?:\/\//i.test(arg)) {
    src = await fromUrl(arg, o.fetchImpl);
  } else {
    if (!existsSync(arg)) throw new UserError(`File not found: ${arg}`);
    const ext = extname(arg).toLowerCase();
    if (ext === ".pdf") src = await fromPdf(arg, o.pdftotext);
    else if (ext === ".docx") src = await fromDocx(arg, o.run ?? defaultRun);
    else if (ext === ".md" || ext === ".txt") src = { kind: "text", ref: arg, text: await Bun.file(arg).text() };
    else if (ext === ".html" || ext === ".htm") {
      const html = await Bun.file(arg).text();
      src = { kind: "html", ref: arg, text: htmlToText(html), html };
    } else {
      throw new UserError(`Unsupported file type "${ext || arg}"`, "Use .pdf, .docx, .md, .txt, .html or a URL");
    }
  }
  if (!src.text.trim()) throw new UserError(`${src.ref} is empty`);
  const warnings: string[] = [];
  if (src.text.length > MAX_CHARS) {
    src = { ...src, text: src.text.slice(0, MAX_CHARS) };
    warnings.push(`source truncated to ${MAX_CHARS} characters`);
  }
  return { ...src, warnings };
}
