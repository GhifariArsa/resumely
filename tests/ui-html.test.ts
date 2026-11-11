import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATUSES } from "../src/application/store";
import { escapeHtml, html, raw, safeHref, page, statusPill, readyMark, noticeBox, errorPage, tokenField, emptyState, STATUS_LABEL, type PageCtx } from "../src/ui/html";

const ctx: PageCtx = { token: "T0K", root: "/r<x>", platform: "darwin" };

describe("html primitives", () => {
  test("escapeHtml", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
  test("html tag escapes, nests, flattens", () => {
    expect(html`<p>${"<b>"}</p>`.toString()).toBe("<p>&lt;b&gt;</p>");
    expect(html`${html`<b>`}`.toString()).toBe("<b>");
    expect(html`${["<i>", html`<b>`]}`.toString()).toBe("&lt;i&gt;<b>");
    expect(html`${[["<i>"], [[html`<u>`]]]}`.toString()).toBe("&lt;i&gt;<u>");
    expect(html`${null}${undefined}${false}`.toString()).toBe("");
    expect(html`${0}`.toString()).toBe("0");
    expect(raw("<hr>").toString()).toBe("<hr>");
  });
  test("safeHref", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("ftp://x")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref("https://x.test/a?b=1")).toBe("https://x.test/a?b=1");
  });
});

describe("page shell", () => {
  const out = page({ title: "A<b>", active: "profile", ctx, styles: ["board.css"], body: html`<p>hi</p>` });
  test("head", () => {
    expect(out).toContain("<!doctype html>");
    expect(out).toContain('<html lang="en">');
    expect(out).toContain("<title>A&lt;b&gt; | resumely</title>");
    expect(out).toContain('content="T0K"');
    expect(out.indexOf('href="/assets/base.css"')).toBeGreaterThan(-1);
    expect(out.indexOf('href="/assets/base.css"')).toBeLessThan(out.indexOf('href="/assets/board.css"'));
    expect(out).toContain("/r&lt;x&gt;");
    expect(out).not.toContain("<script");
  });
  test("nav aria-current", () => {
    const prof = out.match(/<a[^>]*href="\/profile"[^>]*>/)![0];
    const apps = out.match(/<a[^>]*href="\/"[^>]*>Applications/)![0];
    expect(prof).toContain('aria-current="page"');
    expect(apps).not.toContain("aria-current");
  });
  test("scripts", () => {
    const s = page({ title: "t", active: null, ctx, styles: [], scripts: ["trace.js"], body: html`` });
    expect(s).toContain('<script type="module" src="/assets/trace.js"></script>');
  });
});

describe("fragments", () => {
  test("status and ready", () => {
    expect(statusPill("interviewing").toString()).toContain("status-interviewing");
    expect(statusPill("interviewing").toString()).toContain("Interviewing");
    expect(STATUS_LABEL.offer).toBe("Offer");
    expect(readyMark(false).toString()).toContain("Not ready");
    expect(readyMark(true).toString()).toContain("Ready");
    expect(readyMark(null).toString()).toBe("");
  });
  test("token, notice, empty, error", () => {
    expect(tokenField('a"b').toString()).toBe('<input type="hidden" name="_token" value="a&quot;b">');
    const n = noticeBox({ tone: "error", message: "<x>", hint: "h" }).toString();
    expect(n).toContain('role="alert"');
    expect(n).toContain("&lt;x&gt;");
    expect(n).toContain("h");
    expect(emptyState("T", "hint").toString()).toContain("hint");
    const e = errorPage(ctx, 404, "No such app");
    expect(e).toContain("Not found");
    expect(e).toContain("No such app");
    expect(e).toContain('href="/"');
    expect(errorPage(ctx, 400, "m")).toContain("Can&#39;t do that");
    expect(errorPage(ctx, 500, "m")).toContain("Something went wrong");
  });
});

test("base.css", () => {
  const css = readFileSync(join(import.meta.dir, "../src/ui/assets/base.css"), "utf8");
  expect(css).toContain("prefers-color-scheme: dark");
  expect(css).toContain("prefers-reduced-motion");
  expect(css).toContain(":focus-visible");
  expect(css).toContain("--mark");
  expect(css).not.toMatch(/https?:\/\//);
  expect(css).not.toContain("text-transform: uppercase");
});

test("STATUSES", () => {
  expect([...STATUSES]).toEqual(["drafted", "applied", "interviewing", "rejected", "offer"]);
});
