import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../errors";
import { spawnWithTimeout } from "../proc";
import type { TemplateMeta } from "./render";

const FLAG = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" } as const;

export async function compileTex(
  tex: string,
  engine: TemplateMeta["engine"],
  opts: { timeoutMs?: number } = {},
): Promise<{ pdf: Uint8Array; pages: number; log: string }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const dir = mkdtempSync(join(tmpdir(), "resumely-tex-"));
  try {
    writeFileSync(join(dir, "main.tex"), tex);
    let res;
    try {
      res = await spawnWithTimeout(["latexmk", FLAG[engine], "-interaction=nonstopmode", "-halt-on-error", "main.tex"], {
        cwd: dir,
        timeoutMs,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UserError("latexmk not found", "Install TeX Live (macOS: brew install --cask mactex-no-gui)");
      }
      throw e;
    }
    if (res.timedOut) {
      throw new UserError("LaTeX compile timed out", `Exceeded ${Math.round(timeoutMs / 1000)}s`);
    }
    const { stdout, stderr } = res;
    let log = "";
    try {
      log = readFileSync(join(dir, "main.log"), "utf8");
    } catch {
      log = stdout + stderr;
    }
    if (res.exitCode !== 0) {
      const err = log.split("\n").find((l) => l.startsWith("!")) ?? (stderr.trim().split("\n")[0] || "see LaTeX log");
      throw new UserError("LaTeX compile failed", err);
    }
    const pdf = new Uint8Array(readFileSync(join(dir, "main.pdf")));
    const m = /Output written on .*?\((\d+) pages?/.exec(log);
    return { pdf, pages: m ? Number(m[1]) : 0, log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
