import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../proc";

/** Text as an ATS would see it, via pdftotext; null when pdftotext is not installed or fails. */
export async function extractPdfText(pdf: Uint8Array, opts: { bin?: string } = {}): Promise<string | null> {
  return (await extractPdfTextDetailed(pdf, opts)).text;
}

/** Like extractPdfText, but says why the text is null: "missing" (not installed) or "failed". */
export async function extractPdfTextDetailed(
  pdf: Uint8Array,
  opts: { bin?: string } = {},
): Promise<{ text: string | null; reason?: "missing" | "failed" }> {
  const dir = mkdtempSync(join(tmpdir(), "resumely-pdf-"));
  try {
    const file = join(dir, "in.pdf");
    writeFileSync(file, pdf);
    const res = await spawnWithTimeout([opts.bin ?? "pdftotext", "-enc", "UTF-8", file, "-"], { cwd: dir, timeoutMs: 10_000 });
    if (res.timedOut || res.exitCode !== 0) return { text: null, reason: "failed" };
    return { text: res.stdout };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { text: null, reason: "missing" };
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
