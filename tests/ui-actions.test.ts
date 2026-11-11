import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setStatus } from "../src/application/tracking";
import { UserError } from "../src/errors";
import { launchDetached, revealArgv } from "../src/commands/open";
import { layout } from "../src/paths";
import type { renderApplication } from "../src/pipeline/rerender";
import { getApplication } from "../src/ui/data";
import { startUiServer, type UiServer } from "../src/ui/server";
import { makeUiRoot } from "./fixtures/ui-root";

type RenderOpts = Parameters<typeof renderApplication>[0];

/** A fresh data root with two servers: `spy` (spied reveal + render) and `real` (spied reveal, real renderApplication). */
function setup() {
  const ctx = {
    fx: null as unknown as ReturnType<typeof makeUiRoot>,
    spy: null as unknown as UiServer,
    real: null as unknown as UiServer,
    reveals: [] as string[],
    renders: [] as RenderOpts[],
    renderImpl: async (_o: RenderOpts): Promise<{ version: number }> => ({ version: 7 }),
  };
  beforeAll(() => {
    ctx.fx = makeUiRoot();
    const reveal = async (file: string) => {
      ctx.reveals.push(file);
    };
    ctx.spy = startUiServer({
      root: ctx.fx.root,
      port: 0,
      token: "tok",
      reveal,
      render: (o) => {
        ctx.renders.push(o);
        return ctx.renderImpl(o);
      },
    });
    ctx.real = startUiServer({ root: ctx.fx.root, port: 0, token: "tok", reveal });
  });
  afterAll(async () => {
    await ctx.spy.stop();
    await ctx.real.stop();
  });
  return ctx;
}

const post = (server: UiServer, path: string, fields: Record<string, string>) =>
  fetch(server.url + path.replace(/^\//, ""), { method: "POST", body: new URLSearchParams({ _token: "tok", ...fields }), redirect: "manual" });

const appOf = (root: string, slug: string) => getApplication(layout(root).applications, slug)!;
const versionsOf = (root: string, slug: string, kind: string) => readdirSync(join(layout(root).applications, slug, kind)).sort();

describe("status", () => {
  const c = setup();

  test("a known status is saved and redirects back", async () => {
    const res = await post(c.spy, `/app/${c.fx.hostile}/status`, { status: "rejected" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/${c.fx.hostile}`);
    expect(readFileSync(join(layout(c.fx.root).applications, c.fx.hostile, "application.toml"), "utf8")).toContain(`status = "rejected"`);
  });

  test("an unknown status is a 400", async () => {
    const res = await post(c.spy, `/app/${c.fx.hostile}/status`, { status: "bogus" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown status");
    expect(appOf(c.fx.root, c.fx.hostile).meta.status).toBe("rejected");
  });
});

describe("status: applying with a not-ready version", () => {
  const c = setup();

  test("is a 409 with a retry form, and force=1 applies it", async () => {
    setStatus(appOf(c.fx.root, c.fx.atlas), "drafted");
    const res = await post(c.spy, `/app/${c.fx.atlas}/status`, { status: "applied", kind: "resume", v: "2" });
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("resume v2 is not ready");
    expect(body).toContain("Mark as applied anyway");
    expect(body).toContain(`name="force" value="1"`);
    expect(body).not.toContain("--force");
    expect(body).toContain("Re-render or fix it, or mark it as applied anyway");
    expect(appOf(c.fx.root, c.fx.atlas).meta.status).toBe("drafted");

    const forced = await post(c.spy, `/app/${c.fx.atlas}/status`, { status: "applied", force: "1", kind: "resume", v: "2" });
    expect(forced.status).toBe(303);
    expect(forced.headers.get("location")).toBe(`/app/${c.fx.atlas}?kind=resume&v=2`);
    const meta = appOf(c.fx.root, c.fx.atlas).meta;
    expect(meta.sent).toEqual({ resume: 2, cover_letter: 1 });
    expect(meta.status).toBe("applied");
  });

  test("invalid kind and v are dropped from the redirect", async () => {
    const res = await post(c.spy, `/app/${c.fx.atlas}/status`, { status: "offer", kind: "../x", v: "0" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/${c.fx.atlas}`);
  });
});

describe("status: re-saving the current status", () => {
  const c = setup();
  const addReadyResumeV3 = () => {
    const v3 = join(layout(c.fx.root).applications, c.fx.atlas, "resume", "v3");
    mkdirSync(v3);
    writeFileSync(join(v3, "meta.json"), `{"ready":true}`);
  };

  test("an unchanged applied status keeps the sent versions and applied_at", async () => {
    addReadyResumeV3();
    const before = appOf(c.fx.root, c.fx.atlas).meta;
    expect(before.sent).toEqual({ resume: 2, cover_letter: 1 });
    const res = await post(c.spy, `/app/${c.fx.atlas}/status`, { status: "applied", kind: "resume", v: "3" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/${c.fx.atlas}?kind=resume&v=3`);
    const after = appOf(c.fx.root, c.fx.atlas).meta;
    expect(after.sent).toEqual({ resume: 2, cover_letter: 1 });
    expect(after.applied_at).toBe(before.applied_at);
    expect(after.status).toBe("applied");
  });

  test("force=1 still re-pins (the explicit retry)", async () => {
    const res = await post(c.spy, `/app/${c.fx.atlas}/status`, { status: "applied", force: "1" });
    expect(res.status).toBe(303);
    expect(appOf(c.fx.root, c.fx.atlas).meta.sent).toEqual({ resume: 3, cover_letter: 1 });
  });
});

describe("a failed action's page", () => {
  const c = setup();

  test("links absolutely, so tabs and versions work from the POST URL", async () => {
    const actionUrl = `${c.spy.url}app/${c.fx.atlas}/note`;
    const res = await post(c.spy, `/app/${c.fx.atlas}/note`, { text: " ", kind: "resume", v: "2" });
    expect(res.status).toBe(400);
    const body = await res.text();
    const refs = [...body.matchAll(/(?:href|src|action)="([^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
    expect(refs.length).toBeGreaterThan(10);
    expect(refs.filter((h) => !h.startsWith("/") && !h.startsWith("#"))).toEqual([]);
    const inApp = refs.filter((h) => h.startsWith("/app/") && !/\/(status|note|render|reveal)$/.test(h));
    expect(inApp.some((h) => h.includes("kind=cover-letter"))).toBe(true);
    for (const h of inApp) {
      const r = await fetch(new URL(h, actionUrl));
      expect(`${h} ${r.status}`).toBe(`${h} 200`);
    }
  });
});

describe("note", () => {
  const c = setup();
  const notes = () => appOf(c.fx.root, c.fx.atlas).meta.notes;

  test("spaces collapse within lines, newlines are kept, blank lines are capped", async () => {
    const res = await post(c.spy, `/app/${c.fx.atlas}/note`, { text: "  called \t  back  \r\n\r\n\r\n\r\n  next:\u00a0 call   Friday \n" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/${c.fx.atlas}`);
    expect(notes().at(-1)).toEndWith(": called back\n\nnext: call Friday");
  });

  test("the notes list keeps the line breaks", async () => {
    const page = await (await fetch(`${c.spy.url}app/${c.fx.atlas}`)).text();
    expect(page).toContain("called back\n\nnext: call Friday</li>");
    expect(readFileSync(join(import.meta.dir, "../src/ui/assets/application.css"), "utf8")).toMatch(/\.notes li\s*\{[^}]*white-space:\s*pre-line/);
  });

  test("an empty or too long note is a 400 and adds nothing", async () => {
    const before = notes().length;
    const empty = await post(c.spy, `/app/${c.fx.atlas}/note`, { text: "  " });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("Write a note first");
    const long = await post(c.spy, `/app/${c.fx.atlas}/note`, { text: "a".repeat(2001) });
    expect(long.status).toBe(400);
    expect(await long.text()).toContain("Notes are limited to 2000 characters");
    expect(notes().length).toBe(before);
  });
});

describe("render (spy)", () => {
  const c = setup();

  test("calls render and redirects to the new version", async () => {
    const res = await post(c.spy, `/app/${c.fx.atlas}/render`, { template: "classic", kind: "resume", v: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/${c.fx.atlas}?kind=resume&v=7`);
    expect(c.renders).toEqual([{ root: c.fx.root, query: c.fx.atlas, template: "classic", kind: "resume", version: 1, open: false }]);
  });

  test("a missing v is a 400 and render is not called", async () => {
    c.renders.length = 0;
    const res = await post(c.spy, `/app/${c.fx.atlas}/render`, { template: "classic", kind: "resume" });
    expect(res.status).toBe(400);
    expect(c.renders).toEqual([]);
  });

  test("two renders never run at once", async () => {
    let active = 0;
    let most = 0;
    c.renderImpl = async () => {
      active++;
      most = Math.max(most, active);
      await Bun.sleep(30);
      active--;
      return { version: 7 };
    };
    try {
      const fields = { template: "classic", kind: "resume", v: "1" };
      const results = await Promise.all([post(c.spy, `/app/${c.fx.atlas}/render`, fields), post(c.spy, `/app/${c.fx.atlas}/render`, fields)]);
      expect(results.map((r) => r.status)).toEqual([303, 303]);
      expect(most).toBe(1);
    } finally {
      c.renderImpl = async () => ({ version: 7 });
    }
  });

  test("a failed render does not block the next one", async () => {
    c.renderImpl = async () => {
      throw new UserError("compile failed", "see the log");
    };
    const bad = await post(c.spy, `/app/${c.fx.atlas}/render`, { template: "classic", kind: "resume", v: "1" });
    expect(bad.status).toBe(400);
    const body = await bad.text();
    expect(body).toContain("compile failed");
    expect(body).toContain("see the log");
    c.renderImpl = async () => ({ version: 7 });
    const ok = await post(c.spy, `/app/${c.fx.atlas}/render`, { template: "classic", kind: "resume", v: "1" });
    expect(ok.status).toBe(303);
  });

  test("an unexpected handler error is the generic 500 page without a stack", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    c.renderImpl = async () => {
      throw new Error("boom");
    };
    try {
      const res = await post(c.spy, `/app/${c.fx.atlas}/render`, { template: "classic", kind: "resume", v: "1" });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      const body = await res.text();
      expect(body).toContain("Something went wrong");
      expect(body).not.toContain("ui-actions.test.ts");
      expect(body).not.toContain("    at ");
      expect(String(logged.mock.calls[0]?.[0])).toContain("ui-actions.test.ts");
    } finally {
      c.renderImpl = async () => ({ version: 7 });
      logged.mockRestore();
    }
  });
});

describe("render (real renderApplication, no LaTeX needed)", () => {
  const c = setup();

  test("an unknown template is a 400 and writes nothing", async () => {
    const res = await post(c.real, `/app/${c.fx.atlas}/render`, { template: "nope", kind: "resume", v: "1" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown template &quot;nope&quot;");
    expect(versionsOf(c.fx.root, c.fx.atlas, "resume")).toEqual(["v1", "v2"]);
  });

  test("a template without cover-letter support is a 400 and writes nothing", async () => {
    const dir = join(layout(c.fx.root).templates, "resume-only");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "template.toml"), `id = "resume-only"\nname = "Resume only"\nengine = "pdflatex"\nsupports = ["resume"]\n`);
    writeFileSync(join(dir, "resume.tex.njk"), "");
    const res = await post(c.real, `/app/${c.fx.atlas}/render`, { template: "resume-only", kind: "cover-letter", v: "1" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not support cover letters");
    expect(versionsOf(c.fx.root, c.fx.atlas, "cover-letter")).toEqual(["v1"]);
  });
});

describe("render (latexmk)", () => {
  const c = setup();

  test.skipIf(!Bun.which("latexmk"))(
    "re-renders a new version and the page shows it",
    async () => {
      const res = await post(c.real, `/app/${c.fx.atlas}/render`, { template: "classic", kind: "resume", v: "1" });
      expect(res.status).toBe(303);
      const location = res.headers.get("location")!;
      expect(location).toBe(`/app/${c.fx.atlas}?kind=resume&v=3`);
      const meta = JSON.parse(readFileSync(join(layout(c.fx.root).applications, c.fx.atlas, "resume", "v3", "meta.json"), "utf8"));
      expect(meta.rendered_from).toBe(1);
      expect(meta.template).toBe("classic");
      const body = await (await fetch(c.real.url + location.slice(1))).text();
      expect(body).toContain("v3");
    },
    120_000,
  );
});

describe("reveal", () => {
  const c = setup();

  test("reveals the version's PDF", async () => {
    const res = await post(c.spy, `/app/${c.fx.atlas}/reveal`, { kind: "resume", v: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/${c.fx.atlas}?kind=resume&v=1`);
    expect(c.reveals).toHaveLength(1);
    expect(c.reveals[0]).toEndWith("/resume/v1/Jordan_Example_Resume_AtlasFreight.pdf");
  });

  test("a missing version is a 404", async () => {
    const res = await post(c.spy, `/app/${c.fx.atlas}/reveal`, { kind: "resume", v: "9" });
    expect(res.status).toBe(404);
    expect(c.reveals).toHaveLength(1);
  });
});

describe("unknown application", () => {
  const c = setup();

  test("POST to a missing slug is a 404", async () => {
    const res = await post(c.spy, "/app/nope/note", { text: "hi" });
    expect(res.status).toBe(404);
  });
});

describe("launchDetached", () => {
  test("returns without waiting for the process (xdg-open can block until the file manager closes)", async () => {
    const started = performance.now();
    launchDetached(["sleep", "3"], "warning: unused");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("warns when the command can't start", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      launchDetached(["/nonexistent/resumely-file-manager"], "warning: couldn't open the file manager");
      expect(logged.mock.calls.map((c) => String(c[0]))).toEqual(["warning: couldn't open the file manager"]);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("revealArgv", () => {
  test("macOS selects the file in Finder; Linux opens its folder", () => {
    expect(revealArgv("/a/b/c.pdf", "darwin")).toEqual(["open", "-R", "/a/b/c.pdf"]);
    expect(revealArgv("/a/b/c.pdf", "linux")).toEqual(["xdg-open", "/a/b"]);
  });
});
