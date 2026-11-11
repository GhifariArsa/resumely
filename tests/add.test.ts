import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { layout } from "../src/paths";
import { UserError } from "../src/errors";
import { loadProfile } from "../src/profile/load";
import { parseAddInput, stageAdd, type AddFlags } from "../src/profile/add";

const fx = join(import.meta.dir, "fixtures");
let root: string;
let pdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-add-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  pdir = layout(root).profile;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const flags = (o: Partial<AddFlags> = {}): AddFlags => ({ skill: [], tag: [], bullet: [], link: [], ...o });
const err = (fn: () => unknown): UserError => {
  try {
    fn();
  } catch (e) {
    return e as UserError;
  }
  throw new Error("expected a UserError");
};
const manual = { kind: "manual", ref: "manual" } as const;

describe("parseAddInput", () => {
  test("maps flags onto an entry", () => {
    const i = parseAddInput("experience", flags({ title: "Staff Engineer", org: "Acme", start: "2024-01", end: "present", bullet: ["Cut costs 30%"] }), undefined);
    expect(i).toMatchObject({ type: "experience", title: "Staff Engineer", org: "Acme", bullets: ["Cut costs 30%"] });
  });
  test("a bad month names the field", () => {
    const e = err(() => parseAddInput("experience", flags({ title: "X", start: "2024-13" }), undefined));
    expect(e).toBeInstanceOf(UserError);
    expect(e.message).toStartWith("invalid proposal: start");
    expect(e.hint).toBe("resumely profile add --help");
  });
  test("skills need a category", () => {
    expect(err(() => parseAddInput("skills", flags({ skill: ["Rust"] }), undefined))).toBeInstanceOf(UserError);
    expect(parseAddInput("skills", flags({ skill: ["Rust"], category: "Languages" }), undefined)).toMatchObject({ type: "skills", skills: { Languages: ["Rust"] } });
  });
  test("links must be label=url", () => {
    expect(err(() => parseAddInput("about", flags({ link: ["nope"] }), undefined))).toBeInstanceOf(UserError);
    expect(parseAddInput("about", flags({ link: ["Site=https://x.dev"], headline: "H" }), undefined)).toMatchObject({ about: { headline: "H", links: [{ label: "Site", url: "https://x.dev" }] } });
  });
  test("--json can't be combined with field flags", () => {
    const e = err(() => parseAddInput(undefined, flags({ title: "X" }), { type: "experience", title: "Y" }));
    expect(e.message).toBe("--json can't be combined with field flags");
  });
  test("json type wins; a mismatching positional type is rejected", () => {
    expect(parseAddInput(undefined, flags(), { type: "project", title: "P" })).toMatchObject({ type: "project", title: "P" });
    expect(err(() => parseAddInput("award", flags(), { type: "project", title: "P" }))).toBeInstanceOf(UserError);
  });
});

describe("stageAdd", () => {
  test("update of an unknown entry", () => {
    const profile = loadProfile(pdir);
    const input = parseAddInput("experience", flags({ title: "X", update: "exp-ghost" }), undefined);
    const e = err(() => stageAdd(pdir, profile, input, manual));
    expect(e.message).toContain('No entry "exp-ghost" to update');
    expect(e.hint).toBe("resumely profile show");
  });
  test("an update may omit the title; the staged entry carries the live one", () => {
    const profile = loadProfile(pdir);
    const input = parseAddInput("experience", flags({ update: "exp-atlas-labs", bullet: ["Interview bullet"] }), undefined);
    const r = stageAdd(pdir, profile, input, manual);
    expect(r.staged[0]!.entry).toMatchObject({ id: "exp-atlas-labs", title: "Senior Software Engineer", bullets: ["Interview bullet"] });
  });
  test("a new entry still needs a title", () => {
    expect(err(() => parseAddInput("experience", flags({ org: "Acme" }), undefined)).message).toContain("title: required for a new entry");
  });
  test("a new entry is staged with the manual source", () => {
    const profile = loadProfile(pdir);
    const input = parseAddInput("experience", flags({ title: "Staff Engineer", org: "Acme", start: "2024-01", end: "present" }), undefined);
    const r = stageAdd(pdir, profile, input, manual);
    expect(r.staged.map((p) => p.pid)).toEqual(["1-exp-acme"]);
    expect(r.staged[0]!.source.kind).toBe("manual");
  });
  test("end before start", () => {
    const input = parseAddInput("experience", flags({ title: "X", org: "Z", start: "2024-05", end: "2024-01" }), undefined);
    expect(err(() => stageAdd(pdir, loadProfile(pdir), input, manual)).message).toContain("before");
  });
  test("unsupported characters are rejected", () => {
    const input = parseAddInput("experience", flags({ title: "Eng \u{1F680}", org: "Z" }), undefined);
    expect(err(() => stageAdd(pdir, loadProfile(pdir), input, manual))).toBeInstanceOf(UserError);
  });
});

describe("JSON error paths and unknown keys", () => {
  const msg = (json: unknown) => err(() => parseAddInput(undefined, flags(), json)).message;
  test("skills variant reports its path", () => {
    expect(msg({ type: "skills", skills: { A: "x" } })).toContain("skills.A");
  });
  test("about variant reports its path", () => {
    expect(msg({ type: "about", about: { links: "x" } })).toContain("about.links");
  });
  test("unknown keys error with the key name", () => {
    expect(msg({ type: "experience", title: "T", bullet: ["x"] })).toContain("bullet");
    expect(msg({ type: "skills", skills: {}, skill: ["x"] })).toContain("skill");
    expect(msg({ type: "about", about: { headlin: "x" } })).toContain("headlin");
  });
});
