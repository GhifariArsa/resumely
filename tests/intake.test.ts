import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../src/errors";
import { fetchJobUrl, isThin, readClipboard, readJobFile, resolveJobInput } from "../src/job/intake";

const FIXTURE = join(import.meta.dir, "fixtures/jobs/backend.md");

// genuinely minified: no whitespace between tags; "- " bullet lines become <li>
function minify(block: string): string {
  const lines = block.split("\n");
  if (lines.every((l) => l.startsWith("- "))) return `<ul>${lines.map((l) => `<li>${l.slice(2)}</li>`).join("")}</ul>`;
  return `<p>${block.replace(/\n/g, "<br>")}</p>`;
}

function serve(html: string) {
  return Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });
}

describe("readJobFile", () => {
  test("reads markdown raw", async () => {
    const j = await readJobFile(FIXTURE);
    expect(j.kind).toBe("file");
    expect(j.text).toContain("Atlas Freight");
    expect(j.path).toBe(FIXTURE);
  });
  test("html extracted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "intake-"));
    const p = join(dir, "job.html");
    const body = (await Bun.file(FIXTURE).text()).split("\n\n").map(minify).join("");
    writeFileSync(p, `<html><head><title>t</title></head><body><article>${body}</article></body></html>`);
    const j = await readJobFile(p);
    expect(j.text).toContain("Atlas Freight");
    expect(j.text).not.toContain("<p>");
    expect(j.text).not.toMatch(/[a-z.][A-Z][a-z]+\.[A-Z]/); // no glued boundaries
    expect(j.text).toContain("PostgreSQL, including schema migrations on live tables.\n");
    expect(j.text).toContain("\nModel data and tune queries in PostgreSQL");
  });
  test("empty files rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "intake-"));
    writeFileSync(join(dir, "a.md"), "  \n");
    writeFileSync(join(dir, "b.html"), "<html><body></body></html>");
    await expect(readJobFile(join(dir, "a.md"))).rejects.toThrow("Job file is empty");
    await expect(readJobFile(join(dir, "b.html"))).rejects.toThrow("Job file is empty");
  });
  test("pdf rejected", async () => {
    await expect(readJobFile("/x/job.pdf")).rejects.toBeInstanceOf(UserError);
  });
});

describe("readClipboard", () => {
  test("empty -> UserError", async () => {
    await expect(readClipboard(async () => "  ")).rejects.toThrow("Clipboard is empty");
  });
  test("returns text", async () => {
    const j = await readClipboard(async () => "hello job");
    expect(j).toEqual({ kind: "clipboard", text: "hello job" });
  });
  test("falls through missing binaries", async () => {
    const calls: string[] = [];
    const j = await readClipboard(async (cmd) => {
      calls.push(cmd[0]!);
      if (cmd[0] !== "xclip") throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return "from xclip";
    });
    expect(calls).toEqual(["pbpaste", "wl-paste", "xclip"]);
    expect(j.text).toBe("from xclip");
  });
});

describe("isThin", () => {
  test("20 words thin", () => expect(isThin(Array(20).fill("word").join(" "))).toBe(true));
  test("js wall thin", () =>
    expect(isThin(Array(300).fill("word").join(" ") + " Please enable JavaScript")).toBe(true));
  test("300 words ok", () => expect(isThin(Array(300).fill("word").join(" "))).toBe(false));
});

describe("fetchJobUrl", () => {
  test("extracts article text", async () => {
    const md = await Bun.file(FIXTURE).text();
    const body = md.split("\n\n").map(minify).join("");
    const s = serve(`<html><head><title>Job</title></head><body><nav>Menu</nav><article>${body}</article></body></html>`);
    try {
      const j = await fetchJobUrl(`http://localhost:${s.port}/job`);
      expect(j.kind).toBe("url");
      expect(j.text).toContain("Atlas Freight");
      expect(j.html).toContain("<article>");
      expect(j.text).toContain("tables.\n");
      expect(j.text).toContain("\nBuild event-driven pipelines");
      expect(j.text).not.toContain("tables.Build");
    } finally {
      s.stop(true);
    }
  });
  test("thin page -> UserError", async () => {
    const s = serve(`<html><body><article><p>${Array(30).fill("word").join(" ")}</p></article></body></html>`);
    try {
      await expect(fetchJobUrl(`http://localhost:${s.port}/`)).rejects.toThrow(/Couldn't read enough of that page \(\d+ words\)/);
    } finally {
      s.stop(true);
    }
  });
  test("non-2xx -> UserError", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 404 }) });
    try {
      await expect(fetchJobUrl(`http://localhost:${s.port}/`)).rejects.toThrow(/HTTP 404/);
    } finally {
      s.stop(true);
    }
  });
  test("network error -> UserError", async () => {
    const f = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(fetchJobUrl("http://x.invalid/", f)).rejects.toBeInstanceOf(UserError);
  });
});

describe("resolveJobInput", () => {
  test("nothing", async () => {
    await expect(resolveJobInput(undefined, {})).rejects.toThrow("No job given");
  });
  test("file path", async () => {
    expect((await resolveJobInput(FIXTURE, {})).kind).toBe("file");
  });
  test("missing path -> UserError", async () => {
    await expect(resolveJobInput("/nope/missing.md", {})).rejects.toBeInstanceOf(UserError);
  });
});
