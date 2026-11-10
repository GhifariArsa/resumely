import { test, expect } from "bun:test";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/profile/load";
import { stripPrivate, buildAgentPayload, formatProfileContext, formatProfileTree, formatEntry } from "../src/profile/context";
import { initDataRoot } from "../src/commands/init";
import { UserError } from "../src/errors";

const FIXTURE = join(import.meta.dir, "fixtures/profile-jordan");
const tmp = () => mkdtempSync(join(tmpdir(), "resumely-profile-"));
const copyFixture = () => {
  const d = join(tmp(), "profile");
  cpSync(FIXTURE, d, { recursive: true });
  return d;
};

test("loads fixture entries with authored IDs", () => {
  const p = loadProfile(FIXTURE);
  expect(p.entries.map((e) => e.id).sort()).toEqual(["edu-udem", "exp-atlas-labs", "exp-northwind", "proj-ledgerly", "proj-routekit"]);
  expect(p.about.name).toBe("Jordan Example");
  expect(p.about.links.length).toBe(2);
  expect(Object.keys(p.skills).length).toBe(3);
  expect(p.aboutPrivateKeys).toBe(1);
  expect("private" in p.about).toBe(false);
});

test("private section is stripped and counted", () => {
  const e = loadProfile(FIXTURE).entries.find((x) => x.id === "exp-atlas-labs")!;
  expect(e.privateLines).toBe(3);
  expect(e.body).not.toContain("laid off");
  expect(e.body).not.toContain("Private");
  expect(e.body).toContain("## Notes");
  expect(e.body).toContain("onboarding flow");
});

test("stripPrivate handles EOF section and none", () => {
  expect(stripPrivate("a\n\n## private\nx\ny\n")).toEqual({ body: "a\n", privateLines: 2 });
  expect(stripPrivate("a\nb")).toEqual({ body: "a\nb", privateLines: 0 });
});

test("agent payload leaks nothing private", () => {
  const p = loadProfile(FIXTURE);
  const s = JSON.stringify(buildAgentPayload(p));
  for (const bad of ["laid off", "exceeds expectations", "145000", "jordan@example.com", "salary", "555 0100", "Private"]) {
    expect(s).not.toContain(bad);
  }
  expect(s).toContain("R&D");
  expect(s).toContain("C#");
  expect(s).toContain("$5M");
});

test("formatProfileContext notes withheld lines", () => {
  const out = formatProfileContext(loadProfile(FIXTURE));
  expect(out).toContain("// exp-atlas-labs: [private: 3 lines withheld]");
  expect(out).not.toContain("laid off");
});

test("formatProfileTree and formatEntry", () => {
  const p = loadProfile(FIXTURE);
  const tree = formatProfileTree(p);
  expect(tree).toContain("exp-northwind");
  expect(tree).toContain("Jordan Example");
  const e = formatEntry(p.entries.find((x) => x.id === "exp-northwind")!);
  expect(e).toContain("Northwind Systems");
  expect(e).toContain("Go");
});

test("duplicate ID names both files", () => {
  const d = copyFixture();
  writeFileSync(join(d, "projects/dup.md"), "---\nid: exp-northwind\ntype: project\ntitle: Dup\n---\nx\n");
  try {
    loadProfile(d);
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    expect((e as Error).message).toContain("northwind.md");
    expect((e as Error).message).toContain("dup.md");
  }
});

test("invalid start date names the file", () => {
  const d = copyFixture();
  writeFileSync(join(d, "projects/bad.md"), '---\nid: proj-bad\ntype: project\ntitle: Bad\nstart: "2024"\n---\nx\n');
  try {
    loadProfile(d);
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    expect((e as Error).message).toContain("bad.md");
  }
});

test("missing frontmatter and missing email are UserErrors", () => {
  const d = copyFixture();
  writeFileSync(join(d, "extras/nofm.md"), "no frontmatter\n");
  expect(() => loadProfile(d)).toThrow(/nofm\.md/);
  const d2 = copyFixture();
  writeFileSync(join(d2, "about.md"), "---\nname: X\n---\nhi\n");
  expect(() => loadProfile(d2)).toThrow(/about\.md/);
});

test("loadProfile parses the starter profile from init", () => {
  const root = join(tmp(), "r");
  initDataRoot(root);
  const p = loadProfile(join(root, "profile"));
  expect(p.entries).toEqual([]);
  expect(p.about.links).toEqual([]);
  expect(p.about.name).toBe("Your Name");
  expect(p.skills).toEqual({ Languages: [], Tools: [] });
});

test("near-miss private headings are withheld", () => {
  expect(stripPrivate("a\n## Private:\nx\n## Notes\ny")).toEqual({ body: "a\n## Notes\ny", privateLines: 1 });
  expect(stripPrivate("a\n## Private notes\nsecret\nmore\n")).toEqual({ body: "a", privateLines: 2 });
  expect(stripPrivate("a\n## privateer\nkept")).toEqual({ body: "a\n## privateer\nkept", privateLines: 0 });
});

test("unstripped headings mentioning private are warned about", () => {
  const d = copyFixture();
  writeFileSync(join(d, "projects/sub.md"), "---\nid: proj-sub\ntype: project\ntitle: Sub\n---\n## Notes\n### Private\nnot withheld\n");
  const p = loadProfile(d);
  const ctx = formatProfileContext(p);
  expect(ctx).toContain('// warning: proj-sub: heading "### Private" is not withheld (only "## Private" sections are)');
  expect(ctx).toContain("not withheld");
  expect(formatProfileTree(p)).toContain('warning: proj-sub: heading "### Private" is not withheld (only "## Private" sections are)');
  expect(formatProfileContext(loadProfile(FIXTURE))).not.toContain("warning:");
});
