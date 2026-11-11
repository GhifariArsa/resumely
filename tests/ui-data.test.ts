import { test, expect, describe, beforeAll } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listApplications } from "../src/application/store";
import { formatProfileContext } from "../src/profile/context";
import { lintProfile } from "../src/profile/lint";
import { loadProfile } from "../src/profile/load";
import { layout } from "../src/paths";
import { applicationView, boardRows, entryUsage, fileHref, getApplication, profileView } from "../src/ui/data";
import { makeUiRoot } from "./fixtures/ui-root";

type Fx = ReturnType<typeof makeUiRoot>;
let fx: Fx;
let apps: string;
beforeAll(() => {
  fx = makeUiRoot();
  apps = layout(fx.root).applications;
});

describe("boardRows", () => {
  test("newest first, atlas versions and sent", () => {
    const rows = boardRows(fx.root);
    expect(rows.map((r) => r.slug)).toEqual([fx.atlas, fx.hostile, fx.empty, fx.coverOnly]);
    const a = rows[0]!;
    expect(a.resume?.version).toBe(2);
    expect(a.resume?.ready).toBe(false);
    expect(a.cover?.version).toBe(1);
    expect(a.cover?.ready).toBe(true);
    expect(a.sent).toEqual({ resume: 2, cover_letter: 1 });
    const e = rows.find((r) => r.slug === fx.empty)!;
    expect(e.resume).toBeNull();
    expect(e.cover).toBeNull();
  });
  test("filters", () => {
    expect(boardRows(fx.root, { status: "interviewing" }).map((r) => r.slug)).toEqual([fx.hostile]);
    expect(boardRows(fx.root, { company: "ATLAS" }).map((r) => r.slug)).toEqual([fx.atlas]);
  });
});

test("getApplication is exact only", () => {
  expect(getApplication(apps, "atlas")).toBeNull();
  expect(getApplication(apps, fx.atlas)?.slug).toBe(fx.atlas);
});

describe("applicationView", () => {
  test("atlas resume defaults to latest", () => {
    const v = applicationView(fx.root, fx.atlas)!;
    const d = v.doc!;
    expect(v.kinds).toEqual(["resume", "cover-letter"]);
    expect(d.kind).toBe("resume");
    expect(d.version).toBe(2);
    expect(d.versions.map((x) => x.version)).toEqual([1, 2]);
    expect(d.versions[1]!.sent).toBe(true);
    expect(d.versions[1]!.renderedFrom).toBe(1);
    expect(d.versions[0]!.template).toBe("classic");
    expect(d.pdf?.href).toBe(fileHref(fx.atlas, "resume", 2, "Jordan_Example_Resume_AtlasFreight.pdf"));
    expect(d.review).toBeNull();
    expect(d.problems).toEqual([]);
    expect(d.trace!.rows.length).toBeGreaterThan(0);
    const e = d.entries.find((x) => x.id === "exp-atlas-labs");
    expect(e?.body).toBeTruthy();
    expect(d.files.find((f) => f.name === "resume.json")?.href).toBe(fileHref(fx.atlas, "resume", 2, "resume.json"));
    expect(v.job.raw).toContain("Posting for");
    expect(v.job.parsed?.company).toBe("Atlas Freight");
  });
  test("kind, version and slug selection", () => {
    expect(applicationView(fx.root, fx.atlas, { kind: "cover-letter" })!.doc!.version).toBe(1);
    expect(applicationView(fx.root, fx.atlas, { version: 9 })).toBeNull();
    expect(applicationView(fx.root, "nope")).toBeNull();
    expect(applicationView(fx.root, fx.coverOnly)!.doc!.kind).toBe("cover-letter");
    expect(applicationView(fx.root, fx.coverOnly, { kind: "resume" })).toBeNull();
  });
  test("application with no versions", () => {
    const v = applicationView(fx.root, fx.empty)!;
    expect(v.doc).toBeNull();
    expect(v.kinds).toEqual([]);
  });
  test("truncated review.json is a problem, pdf still set", () => {
    const d = applicationView(fx.root, fx.hostile)!.doc!;
    expect(d.problems).toContain("review.json couldn't be read");
    expect(d.review).toBeNull();
    expect(d.pdf).not.toBeNull();
  });
  test("unreadable meta.json", () => {
    const f = makeUiRoot();
    const l = layout(f.root).applications;
    writeFileSync(join(l, f.atlas, "resume/v1/meta.json"), "{not json");
    const v = applicationView(f.root, f.atlas, { version: 1 })!;
    expect(v.doc!.versions[0]!.ready).toBeNull();
    expect(v.doc!.problems.join(" ")).toContain("meta.json");
    rmSync(f.root, { recursive: true, force: true });
  });
  test("templates support the doc kind", () => {
    for (const kind of ["resume", "cover-letter"] as const) {
      const t = applicationView(fx.root, fx.atlas, { kind })!.templates;
      expect(t.length).toBeGreaterThan(0);
      expect(t.every((x) => x.supports.includes(kind))).toBe(true);
      expect(t.map((x) => x.id)).toContain("classic");
    }
  });
});

test("entryUsage", () => {
  const u = entryUsage(apps);
  const uses = u.get("exp-atlas-labs")!;
  expect(uses).toContainEqual(expect.objectContaining({ slug: fx.atlas, kind: "resume", versions: [1, 2] }));
  expect(uses).toContainEqual(expect.objectContaining({ slug: fx.atlas, kind: "cover-letter", versions: [1] }));
  expect(u.get("award-oss")).toBeUndefined();
});

describe("profileView", () => {
  test("loads context and lint", () => {
    const p = profileView(fx.root);
    expect(p.context).toBe(formatProfileContext(loadProfile(layout(fx.root).profile)));
    expect(p.lint).toEqual(lintProfile(fx.root));
    expect(p.loadError).toBeNull();
    expect(p.usage.get("exp-atlas-labs")).toBeDefined();
  });
  test("invalid about.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-prof-"));
    cpSync(fx.root, dir, { recursive: true });
    writeFileSync(join(dir, "profile/about.md"), "---\nname: [unclosed\n---\nbody\n");
    const p = profileView(dir);
    expect(p.loadError).not.toBeNull();
    expect(p.profile).toBeNull();
    expect(p.context).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

test("fixture lists four applications", () => {
  expect(listApplications(apps)).toHaveLength(4);
});
