import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../src/errors";
import { dirname } from "node:path";
import { fetchJobUrl, isThin, readClipboard, readFromEditor, readJobFile, resolveJobInput } from "../src/job/intake";

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
  test("non-interactive with no input -> No job given", async () => {
    await expect(resolveJobInput(undefined, { interactive: false })).rejects.toThrow("No job given");
  });
  test("interactive with no input opens the editor", async () => {
    const j = await resolveJobInput(undefined, { interactive: true, editor: { env: { EDITOR: "x" }, spawn: async (argv) => (await Bun.write(argv.at(-1)!, "pasted posting"), 0) } });
    expect(j).toMatchObject({ kind: "editor", text: "pasted posting" });
  });
  test("file path", async () => {
    expect((await resolveJobInput(FIXTURE, {})).kind).toBe("file");
  });
  test("missing path -> UserError", async () => {
    await expect(resolveJobInput("/nope/missing.md", {})).rejects.toBeInstanceOf(UserError);
  });
});

describe("readFromEditor", () => {
  const FAKE = join(import.meta.dir, "fixtures/fake-editor.ts");
  const env = (extra: Record<string, string | undefined> = {}) => ({ EDITOR: `bun ${FAKE}`, FAKE_EDITOR_TEXT_FILE: FIXTURE, ...extra });

  test("returns what the editor saved, without the instruction line", async () => {
    const j = await readFromEditor({ env: env() });
    expect(j.kind).toBe("editor");
    expect(j.text).toBe((await Bun.file(FIXTURE).text()).trim());
    expect(j.text).not.toContain("<!-- resumely:");
  });
  test("VISUAL wins over EDITOR", async () => {
    const j = await readFromEditor({ env: env({ VISUAL: `bun ${FAKE}`, EDITOR: "definitely-not-an-editor" }) });
    expect(j.kind).toBe("editor");
  });
  test("non-zero exit", async () => {
    await expect(readFromEditor({ env: env({ FAKE_EDITOR_EXIT: "3" }) })).rejects.toThrow("status 3");
  });
  test("nothing entered", async () => {
    await expect(readFromEditor({ env: env({ FAKE_EDITOR_TEXT_FILE: undefined }) })).rejects.toThrow("No job text entered");
  });
  test("editor not found", async () => {
    await expect(readFromEditor({ env: { EDITOR: "definitely-not-an-editor" } })).rejects.toThrow("Editor not found");
  });
  test("EDITOR is split into argv, the temp file is last, and its dir is removed afterwards", async () => {
    let argv: string[] = [];
    const j = await readFromEditor({
      env: { EDITOR: "code --wait" },
      spawn: async (a) => {
        argv = a;
        expect(await Bun.file(a.at(-1)!).text()).toStartWith("<!-- resumely: paste the job posting below");
        await Bun.write(a.at(-1)!, "Hello posting\n");
        return 0;
      },
    });
    expect(argv.slice(0, 2)).toEqual(["code", "--wait"]);
    expect(argv).toHaveLength(3);
    expect(existsSync(dirname(argv[2]!))).toBe(false);
    expect(j.text).toBe("Hello posting");
  });
  test("an EDITOR that is an existing path is not split", async () => {
    let argv: string[] = [];
    await readFromEditor({ env: { EDITOR: FIXTURE }, spawn: async (a) => ((argv = a), await Bun.write(a.at(-1)!, "x"), 0) });
    expect(argv[0]).toBe(FIXTURE);
  });
});
