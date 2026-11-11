import { test, expect, describe, beforeAll } from "bun:test";
import type { PageCtx } from "../src/ui/html";
import { boardRows } from "../src/ui/data";
import { boardPage } from "../src/ui/views/board";
import { makeUiRoot } from "./fixtures/ui-root";

let fx: ReturnType<typeof makeUiRoot>;
let ctx: PageCtx;
beforeAll(() => {
  fx = makeUiRoot();
  ctx = { token: "t", root: fx.root, platform: "darwin" };
});

const all = () => boardRows(fx.root);
const rowOf = (out: string, slug: string) => out.slice(out.indexOf(`href="/app/${slug}"`)).split("</a>")[0]!;

describe("boardPage board view", () => {
  test("five columns in status order with counts", () => {
    const out = boardPage(all(), { view: "board", filter: {}, total: 4 }, ctx);
    expect(out.match(/class="column status-/g)?.length).toBe(5);
    const idx = ["drafted", "applied", "interviewing", "rejected", "offer"].map((s) => out.indexOf(`class="column status-${s}"`));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect(out).toMatch(/<h2>Applied <span class="count">1<\/span><\/h2>/);
    expect(out).toContain(`href="/app/${fx.atlas}"`);
  });

  test("row content", () => {
    const out = boardPage(all(), { view: "board", filter: {}, total: 4 }, ctx);
    const atlas = rowOf(out, fx.atlas);
    expect(atlas).toContain("Resume v2");
    expect(atlas).toContain("Not ready");
    expect(atlas).toContain("Cover letter v1");
    expect(atlas).toContain("Sent");
    expect(rowOf(out, fx.empty)).toContain("No documents");
  });

  test("hostile text is escaped", () => {
    const out = boardPage(all(), { view: "board", filter: {}, total: 4 }, ctx);
    expect(out).not.toContain("<script>alert");
    expect(out).toContain("Acme &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;");
    expect(out).toContain("R&amp;D &lt;b&gt;Lead&lt;/b&gt;");
  });

  test("status filter shows one column", () => {
    const out = boardPage(boardRows(fx.root, { status: "applied" }), { view: "board", filter: { status: "applied" }, total: 4 }, ctx);
    expect(out.match(/class="column/g)?.length).toBe(1);
  });
});

describe("boardPage list view", () => {
  test("table with headers and sent cell", () => {
    const out = boardPage(all(), { view: "list", filter: {}, total: 4 }, ctx);
    expect(out).toContain("<table");
    for (const h of ["Date", "Company", "Role", "Status", "Resume", "Cover letter", "Sent"]) expect(out).toContain(`<th scope="col">${h}</th>`);
    expect(out).toContain("Resume v2, cover letter v1");
    expect(out).toContain(`<a href="/app/${fx.atlas}">Atlas Freight</a>`);
    expect(out).toContain("2026-03-10");
  });
});

describe("boardPage empty states and toolbar", () => {
  test("filter matches nothing", () => {
    const out = boardPage([], { view: "board", filter: { status: "offer" }, total: 4 }, ctx);
    expect(out).toContain("No applications match these filters");
    expect(out).toContain("Clear filters");
  });
  test("no applications at all", () => {
    const out = boardPage([], { view: "board", filter: {}, total: 0 }, ctx);
    expect(out).toContain("No applications yet");
    expect(out).toContain("resumely apply --clip");
  });
  test("company filter round-trips escaped", () => {
    const out = boardPage([], { view: "board", filter: { company: '"><x' }, total: 4 }, ctx);
    expect(out).toContain('value="&quot;&gt;&lt;x"');
    expect(out).not.toContain('"><x');
  });
  test("toolbar: hidden view, switch preserves filters, clear link", () => {
    const out = boardPage(all(), { view: "list", filter: { status: "applied", company: "at" }, total: 4 }, ctx);
    expect(out).toContain('<input type="hidden" name="view" value="list">');
    expect(out).toContain('href="/?status=applied&amp;company=at"');
    expect(out).toContain('href="/?view=list&amp;status=applied&amp;company=at"');
    expect(out).toContain('<option value="applied" selected>');
    expect(out).toContain('href="/?view=list"');
  });
});
