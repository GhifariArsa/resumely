import { test, expect, describe, beforeAll } from "bun:test";
import type { PageCtx } from "../src/ui/html";
import { profileView, type ProfileView } from "../src/ui/data";
import { profilePage } from "../src/ui/views/profile";
import { makeUiRoot } from "./fixtures/ui-root";

let fx: ReturnType<typeof makeUiRoot>;
let ctx: PageCtx;
let view: ProfileView;
beforeAll(() => {
  fx = makeUiRoot();
  ctx = { token: "t", root: fx.root, platform: "darwin" };
  view = profileView(fx.root);
});

const entryOf = (out: string, id: string) => {
  const from = out.indexOf(`id="entry-${id}"`);
  const rest = out.slice(from);
  return rest.slice(0, rest.indexOf("</details>"));
};
const section = (out: string, id: string) => out.slice(out.indexOf(`<section id="${id}"`)).split("</section>")[0]!;

describe("profilePage", () => {
  test("header, groups and usage", () => {
    const out = profilePage(view, ctx);
    expect(out).toMatch(/<h1>[^<]*Jordan Example/);
    expect(out.indexOf(">Experience<")).toBeGreaterThan(0);
    expect(out.indexOf(">Experience<")).toBeLessThan(out.indexOf(">Projects<"));
    expect(out).toContain('id="entry-exp-atlas-labs"');
    const atlas = entryOf(out, "exp-atlas-labs");
    expect(atlas).toContain(`href="/app/${fx.atlas}?kind=resume&amp;v=2"`);
    expect(atlas).toContain("resume v1, v2");
    expect(atlas).toContain("cover letter v1");
    for (const href of ['href="#checks"', 'href="#entries"', 'href="#context"']) expect(out).toContain(href);
  });

  test("unused entry says so", () => {
    const out = profilePage(view, ctx);
    const award = out.slice(out.indexOf('id="entry-award-oss"'));
    const used = award.indexOf("Not used yet");
    expect(used).toBeGreaterThan(0);
    const next = award.indexOf('class="entry"');
    if (next !== -1) expect(used).toBeLessThan(next);
  });

  test("context dump is escaped and private text never appears", () => {
    const out = profilePage(view, ctx);
    expect(section(out, "context")).toContain("&quot;name&quot;: &quot;Jordan Example&quot;");
    expect(out).toContain("private lines withheld from the agent");
    for (const secret of ["laid off in Q3", "exceeds expectations", "145000"]) expect(out).not.toContain(secret);
  });

  test("lint issues: summary, orphan list, per entry", () => {
    const lint = [
      { entry_id: "exp-northwind", severity: "warning" as const, code: "outcome-less-bullet", message: "bullet has no outcome", file: "x.md" },
      { entry_id: null, severity: "error" as const, code: "parse", message: "bad <yaml>", file: "y.md" },
    ];
    const out = profilePage({ ...view, lint }, ctx);
    const checks = section(out, "checks");
    expect(checks).toContain("1 error, 1 warning");
    expect(checks).toContain("bad &lt;yaml&gt;");
    expect(checks).not.toContain("bullet has no outcome");
    expect(entryOf(out, "exp-northwind")).toContain("bullet has no outcome");
  });

  test("clean lint", () => {
    expect(section(profilePage({ ...view, lint: [] }, ctx), "checks")).toContain("No problems found");
  });

  test("lint failure is an error notice", () => {
    expect(section(profilePage({ ...view, lintError: "boom" }, ctx), "checks")).toContain("notice-error");
  });

  test("load error", () => {
    const out = profilePage({ profile: null, loadError: "about.md: invalid YAML", context: null, usage: new Map(), lint: [], lintError: null }, ctx);
    expect(out).toContain("about.md: invalid YAML");
    expect(out).toContain("Fix the file, then reload. Check with: resumely profile show");
    expect(out).not.toContain('class="entry"');
  });

  test("private line count and escaped body", () => {
    const profile = structuredClone(view.profile!);
    profile.entries[0] = { ...profile.entries[0]!, privateLines: 3, body: "<script>x</script>" };
    const id = profile.entries[0]!.id;
    const out = profilePage({ ...view, profile }, ctx);
    const e = entryOf(out, id);
    expect(e).toContain("[private: 3 lines withheld]");
    expect(e).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(out).not.toContain("<script>x");
  });

  test("one private line is singular, in the entry and the header", () => {
    const profile = structuredClone(view.profile!);
    profile.entries = profile.entries.map((e, i) => ({ ...e, privateLines: i === 0 ? 1 : 0 }));
    profile.aboutPrivateKeys = 1;
    const out = profilePage({ ...view, profile }, ctx);
    expect(entryOf(out, profile.entries[0]!.id)).toContain("[private: 1 line withheld]");
    expect(out).toContain("1 private line withheld from the agent");
    expect(out).toContain("1 private field in about.md");
    expect(out).not.toContain("1 lines");
    expect(out).not.toContain("1 private lines");
    expect(out).not.toContain("1 private fields");
  });

  test("usage links encode the slug", () => {
    const usage = new Map([...view.usage].map(([id, us]) => [id, us.map((u) => ({ ...u, slug: "a b#c?d" }))]));
    const out = profilePage({ ...view, usage }, ctx);
    expect(entryOf(out, "exp-atlas-labs")).toContain(`href="/app/a%20b%23c%3Fd?kind=resume&amp;v=2"`);
    expect(out).not.toContain("/app/a b");
  });
});
