import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../src/paths";
import { applicationView, type AppView } from "../src/ui/data";
import { escapeHtml, type Notice, type PageCtx } from "../src/ui/html";
import { applicationPage } from "../src/ui/views/application";
import { makeUiRoot } from "./fixtures/ui-root";

let fx: ReturnType<typeof makeUiRoot>;
let ctx: PageCtx;
beforeAll(() => {
  fx = makeUiRoot();
  ctx = { token: "t", root: fx.root, platform: "darwin" };
});
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

const view = (slug: string, o: Parameters<typeof applicationView>[2] = {}): AppView => applicationView(fx.root, slug, o)!;
const render = (slug: string, o: Parameters<typeof applicationView>[2] = {}, notice?: Notice) => applicationPage(view(slug, o), ctx, notice);

describe("atlas default (resume v2)", () => {
  test("PDF, version strip, tabs", () => {
    const out = render(fx.atlas);
    expect(out).toContain(`<iframe class="pdf" src="/files/${fx.atlas}/resume/v2/Jordan_Example_Resume_AtlasFreight.pdf"`);
    expect(out).toContain('title="Resume v2 PDF"');
    expect(out).toContain("Open the PDF");
    expect(out).toContain('href="?kind=resume&amp;v=1"');
    expect(out).toContain('href="?kind=resume&amp;v=2"');
    const v2 = out.slice(out.indexOf('href="?kind=resume&amp;v=2"')).split("</a>")[0]!;
    expect(v2).toContain("Sent");
    expect(v2).toContain('aria-current="page"');
    expect(out).toContain("Not ready");
    expect(out).toMatch(/href="\?kind=resume" aria-current="page">Resume<\/a>/);
    expect(out).toMatch(/href="\?kind=cover-letter">Cover letter<\/a>/);
  });

  test("header: company, role, status, created, sent line", () => {
    const out = render(fx.atlas);
    expect(out).toContain("<h1>Atlas Freight</h1>");
    expect(out).toContain("Senior Backend Engineer");
    expect(out).toContain('class="status status-applied"');
    expect(out).toContain("2026-03-10");
    expect(out).toContain("Sent resume v2 and cover letter v1 on 2026-03-11");
  });

  test("cover-letter only has one tab", () => {
    const out = render(fx.coverOnly);
    expect(out).toContain("Cover letter</a>");
    expect(out).not.toContain('href="?kind=resume"');
    expect(out).toContain('title="Cover letter v1 PDF"');
  });
});

describe("trace", () => {
  test("rows, entry ids, sources", () => {
    const v = view(fx.atlas);
    const out = applicationPage(v, ctx);
    for (const r of v.doc!.trace!.rows) expect(out).toContain(escapeHtml(r.text));
    expect(out).toMatch(/<li class="trace-row" data-entries="[^"]*\bexp-atlas-labs\b[^"]*">/);
    expect(out).toContain('id="entry-exp-atlas-labs"');
    expect(out).toContain('<a class="entry-chip" href="#entry-exp-atlas-labs">exp-atlas-labs</a>');
    expect(out).toContain("Sources");
    expect(out).toMatch(/<details class="panel" open><summary>Trace/);
    expect(out).not.toContain("Inferred");
  });
  test("inferred basis is tagged", () => {
    const v = view(fx.atlas);
    v.doc!.trace!.rows[0]!.basis = "inferred";
    expect(applicationPage(v, ctx)).toContain("Inferred");
  });
  test("missing trace", () => {
    const v = view(fx.atlas);
    v.doc!.trace = null;
    expect(applicationPage(v, ctx)).toContain("No trace for this version");
  });
});

describe("gaps and keywords", () => {
  test("three lists, Kafka in the middle one", () => {
    const out = render(fx.atlas);
    const covered = out.indexOf("Covered");
    const mid = out.indexOf("In your profile but not used");
    const last = out.indexOf("Not in your profile");
    expect(covered).toBeGreaterThan(-1);
    expect(mid).toBeGreaterThan(covered);
    expect(last).toBeGreaterThan(mid);
    const kafka = out.indexOf("Kafka", mid);
    expect(kafka).toBeGreaterThan(mid);
    expect(kafka).toBeLessThan(last);
    expect(out).toContain("Requirements your profile doesn't support");
  });
  test("an empty list shows None", () => {
    const out = render(fx.atlas, { version: 1 });
    const mid = out.indexOf("In your profile but not used");
    expect(out.slice(mid, out.indexOf("Not in your profile"))).toContain("None");
  });
});

describe("review and checks", () => {
  test("v2: no review, carried over", () => {
    const out = render(fx.atlas);
    expect(out).toContain("No review for this version");
    expect(out).toContain("Carried over from v1");
  });
  test("v1: impression, verdict, meters", () => {
    const v = view(fx.atlas, { version: 1 });
    const out = applicationPage(v, ctx);
    expect(out).toContain(escapeHtml(v.doc!.review!.impression));
    expect(out).toContain("Pass");
    expect(out).toContain('<meter min="1" max="5" value="5"');
    expect(out).toContain("5/5");
    expect(out).toContain("No Rust or Kafka");
    expect(out).toContain("The last revision was not re-reviewed");
    expect(out).not.toContain("Carried over from");
  });
  test("v2 checks", () => {
    const out = render(fx.atlas);
    expect(out).toContain("Failed");
    expect(out).toContain("email not extractable");
    expect(out).toContain("Pages: 1 of 1");
    expect(out).toContain("Fill: 90%");
    expect(out).toContain("Words: 300");
  });
  test("missing checks", () => {
    const v = view(fx.atlas);
    v.doc!.checks = null;
    expect(applicationPage(v, ctx)).toContain("No checks recorded");
  });
  test("a hand-edited checks.json without ats/keywords/fill/fabrication fields does not throw", () => {
    const f = makeUiRoot();
    try {
      const dir = join(layout(f.root).applications, f.atlas, "resume/v2");
      writeFileSync(join(dir, "checks.json"), JSON.stringify({ pages: "two", warnings: [3, "keep this warning"], fabrication_warnings: "nope" }));
      const v = applicationView(f.root, f.atlas)!;
      const out = applicationPage(v, { ...ctx, root: f.root });
      expect(out).toContain("<iframe");
      expect(out).toContain("Fill: unknown");
      expect(out).toContain("keep this warning");
      expect(out).toContain("No keyword check recorded");
      writeFileSync(join(dir, "checks.json"), JSON.stringify({ ats: "ok", keywords: { present: "Go" } }));
      expect(applicationPage(applicationView(f.root, f.atlas)!, ctx)).toContain("<iframe");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("forms", () => {
  test("template form", () => {
    const out = render(fx.atlas);
    const form = out.slice(out.indexOf(`action="/app/${fx.atlas}/render"`)).split("</form>")[0]!;
    expect(form).toContain('name="_token" value="t"');
    expect(form).toContain('<option value="classic" selected');
    expect(form).toContain('name="kind" value="resume"');
    expect(form).toContain('name="v" value="2"');
    expect(form).toContain("Re-render");
    expect(out).toContain('data-busy-label="Rendering…"');
    expect(out).toContain("Creates a new version from this one's content. No agent call.");
  });
  test("status and note forms", () => {
    const out = render(fx.atlas);
    const status = out.slice(out.indexOf(`action="/app/${fx.atlas}/status"`)).split("</form>")[0]!;
    expect(status.match(/<option /g)?.length).toBe(5);
    expect(status).toContain('<option value="applied" selected>');
    expect(status).toContain('name="_token" value="t"');
    expect(status).toContain("Save status");
    expect(out).toContain("Marking as applied records the latest versions as sent.");
    const note = out.slice(out.indexOf(`action="/app/${fx.atlas}/note"`)).split("</form>")[0]!;
    expect(note).toContain('maxlength="2000"');
    expect(note).toContain('name="_token" value="t"');
    expect(note).toContain("Add note");
    expect(out).toContain("No notes yet");
  });
});

describe("files", () => {
  test("dir path with copy, reveal per platform", () => {
    const v = view(fx.atlas);
    const out = applicationPage(v, ctx);
    expect(out).toContain(`data-copy="${escapeHtml(v.doc!.dir)}"`);
    expect(out).toContain(`data-copy="${escapeHtml(v.doc!.pdf!.path)}"`);
    expect(out).toContain(`action="/app/${fx.atlas}/reveal"`);
    expect(out).toContain("Show in Finder");
    expect(out).toContain(`href="/files/${fx.atlas}/resume/v2/resume.json"`);
    const linux = applicationPage(v, { ...ctx, platform: "linux" });
    expect(linux).toContain("Open folder");
    expect(linux).not.toContain("Show in Finder");
  });
});

describe("job posting", () => {
  test("parsed fields and raw text", () => {
    const out = render(fx.atlas);
    expect(out).toContain("Go services");
    expect(out).toContain('<pre class="doc-text">');
    expect(out).toContain("Posting for Atlas Freight.");
  });
});

describe("notices", () => {
  test("retry applied", () => {
    const out = render(fx.atlas, {}, { tone: "error", message: "resume v2 is not ready: ATS check failed", hint: "Fix and re-run, or pass --force", retryApplied: true });
    expect(out).toContain('role="alert"');
    expect(out).toContain("resume v2 is not ready: ATS check failed");
    const form = out.slice(out.indexOf('name="force" value="1"') - 400).split("</form>")[0]!;
    expect(out).toContain('name="force" value="1"');
    expect(form).toContain(`action="/app/${fx.atlas}/status"`);
    expect(form).toContain('name="status" value="applied"');
    expect(form).toContain("Mark as applied anyway");
  });
  test("view problems are info notices", () => {
    const v = view(fx.atlas);
    v.problems.push("templates couldn't be listed: boom");
    expect(applicationPage(v, ctx)).toContain("templates couldn&#39;t be listed: boom");
  });
});

describe("hostile and empty", () => {
  test("Review Focus 1: unreadable review.json is a notice, PDF still shown", () => {
    const out = render(fx.hostile);
    expect(out).toContain("review.json couldn&#39;t be read");
    expect(out).toContain("<iframe");
  });
  test("escaping", () => {
    const out = render(fx.hostile);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<b>Lead");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toContain("Cut p99 &lt;script&gt;x&lt;/script&gt; &amp; &quot;quotes&quot;");
  });
  test("posting link only for http(s)", () => {
    const v = view(fx.atlas);
    v.app.meta.source = { kind: "url", url: "javascript:alert(1)" };
    const bad = applicationPage(v, ctx);
    expect(bad).not.toContain('href="javascript:');
    v.app.meta.source = { kind: "url", url: "https://jobs.example.com/a?b=1&c=2" };
    expect(applicationPage(v, ctx)).toContain('href="https://jobs.example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Posting</a>');
  });
  test("Review Focus 2: empty application", () => {
    const out = render(fx.empty);
    expect(out).toContain("No documents yet");
    expect(out).toContain(`resumely apply --into ${fx.empty}`);
    expect(out).toContain(`action="/app/${fx.empty}/status"`);
    expect(out).toContain(`action="/app/${fx.empty}/note"`);
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("Trace");
  });
  test("no inline script, style or handlers", () => {
    const pages = [
      render(fx.atlas),
      render(fx.atlas, { version: 1 }),
      render(fx.atlas, { kind: "cover-letter" }),
      render(fx.hostile),
      render(fx.empty),
      render(fx.coverOnly),
      render(fx.atlas, {}, { tone: "error", message: "x", retryApplied: true }),
    ];
    for (const out of pages) {
      expect(out).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(out).not.toContain(' style="');
      // Handlers can only live inside tags; escaped text (the hostile note) has no `<`.
      expect(out).not.toMatch(/<[^>]*\son[a-z]+=/);
      expect(out).toContain('<script type="module" src="/assets/application.js"></script>');
      expect(out).toContain('href="/assets/application.css"');
    }
  });
});
