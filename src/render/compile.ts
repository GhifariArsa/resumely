import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../errors";
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
    let proc;
    try {
      proc = Bun.spawn(["latexmk", FLAG[engine], "-interaction=nonstopmode", "-halt-on-error", "main.tex"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
    } catch {
      throw new UserError("latexmk not found", "Install a TeX distribution (e.g. TeX Live or MacTeX) that provides latexmk");
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (timedOut) throw new UserError("LaTeX compile timed out", `Exceeded ${Math.round(timeoutMs / 1000)}s`);
    let log = "";
    try {
      log = readFileSync(join(dir, "main.log"), "utf8");
    } catch {
      log = stdout + stderr;
    }
    if (proc.exitCode !== 0) {
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
