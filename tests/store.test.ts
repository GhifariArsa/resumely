import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { slugify, sendReadyName, createApplication, listApplications, findApplication, nextVersionDir, latestVersion, findDuplicate, normaliseJobUrl } from "../src/application/store";
import { slugify as slugify2 } from "../src/application/slug";
import { UserError } from "../src/errors";
import type { ParsedJob } from "../src/pipeline/schemas";
import type { JobSource } from "../src/job/intake";

const job = (company: string, role: string): ParsedJob => ({ company, role, requirements: [], nice_to_haves: [], keywords: [], language: "en" });
const src: JobSource = { kind: "url", text: "# raw", url: "https://x.test/j", html: "<p>x</p>" };
const tmp = () => mkdtempSync(join(tmpdir(), "resumely-store-"));

test("slugify", () => {
  expect(slugify("Société Générale")).toBe("societe-generale");
  expect(slugify2("AT&T")).toBe("at-t");
  expect(slugify("🚀")).toBe("unknown");
  expect(slugify("a".repeat(10) + " " + "b".repeat(40), 11)).toBe("aaaaaaaaaa");
});

test("sendReadyName", () => {
  expect(sendReadyName("{First}_{Last}_{Kind}_{Company}", { name: "José Núñez" }, "Resume", "Société Générale")).toBe("Jose_Nunez_Resume_SocieteGenerale.pdf");
  expect(sendReadyName("{First}_{Last}_{Kind}_{Company}", { name: "Cher" }, "Cover_Letter", "AT&T")).toBe("Cher_Cover_Letter_ATT.pdf");
});

test("create writes files and handles collisions", () => {
  const d = tmp();
  const now = new Date(2026, 10, 10, 12);
  const a = createApplication(d, job("Atlas", "Backend Engineer"), src, now);
  expect(a.slug).toBe("2026-11-10-atlas-backend-engineer");
  expect(readFileSync(join(a.dir, "job/raw.md"), "utf8")).toBe("# raw");
  expect(existsSync(join(a.dir, "job/source.html"))).toBe(true);
  expect(JSON.parse(readFileSync(join(a.dir, "job/parsed.json"), "utf8")).company).toBe("Atlas");
  const meta = parse(readFileSync(join(a.dir, "application.toml"), "utf8"));
  expect(meta.status).toBe("drafted");
  expect(meta.notes).toEqual([]);
  expect(meta.created).toBe(now.toISOString());
  const b = createApplication(d, job("Atlas", "Backend Engineer"), { kind: "file", text: "t" }, now);
  expect(b.slug.endsWith("-2")).toBe(true);
  expect(existsSync(join(b.dir, "job/source.html"))).toBe(false);
  expect(createApplication(d, job("Atlas", "Backend Engineer"), src, now).slug.endsWith("-3")).toBe(true);
});

test("list newest first, skips junk", () => {
  const d = tmp();
  createApplication(d, job("Old", "R"), src, new Date(2026, 0, 1));
  createApplication(d, job("New", "R"), src, new Date(2026, 5, 1));
  mkdirSync(join(d, "junk"));
  expect(listApplications(d).map((a) => a.meta.company)).toEqual(["New", "Old"]);
  expect(listApplications(join(d, "nope"))).toEqual([]);
});

test("find", () => {
  const d = tmp();
  const now = new Date(2026, 0, 1);
  const a = createApplication(d, job("Atlas", "Backend Engineer"), src, now);
  createApplication(d, job("Orbit", "Backend Engineer"), src, now);
  createApplication(d, job("Orbital", "Designer"), src, now);
  expect(findApplication(d, a.slug).slug).toBe(a.slug);
  expect(findApplication(d, "ATLAS").meta.company).toBe("Atlas");
  expect(findApplication(d, "atlas backend").meta.company).toBe("Atlas");
  expect(() => findApplication(d, "backend")).toThrow(/orbit/);
  expect(() => findApplication(d, "zzz")).toThrow(UserError);
  expect(() => findApplication(d, "zzz")).toThrow('No application matches "zzz"');
});

test("versions", () => {
  const d = tmp();
  const a = createApplication(d, job("A", "B"), src);
  expect(latestVersion(a, "resume")).toBeNull();
  expect(nextVersionDir(a, "resume").version).toBe(1);
  expect(nextVersionDir(a, "resume").version).toBe(2);
  for (let i = 0; i < 8; i++) nextVersionDir(a, "resume");
  const v = nextVersionDir(a, "resume");
  expect(v.version).toBe(11);
  expect(existsSync(v.dir)).toBe(true);
  expect(latestVersion(a, "resume")!.version).toBe(11);
  expect(latestVersion(a, "cover-letter")).toBeNull();
});

test("transliterates non-decomposable letters", () => {
  expect(slugify("Straße")).toBe("strasse");
  expect(slugify("Søren Æon")).toBe("soren-aeon");
  expect(slugify("Łukasz")).toBe("lukasz");
  expect(sendReadyName("{First}_{Last}_{Kind}_{Company}", { name: "Søren Łukasz" }, "Resume", "Straße AG")).toBe("Soren_Lukasz_Resume_StrasseAG.pdf");
});

test("normaliseJobUrl drops tracking params, fragments, trailing slash; lowercases the host", () => {
  expect(normaliseJobUrl("HTTPS://Jobs.Example.com/acme/123/?utm_source=li&gh_src=abc&ref=x&id=7#apply")).toBe("https://jobs.example.com/acme/123?id=7");
  expect(normaliseJobUrl("https://jobs.example.com/acme/123")).toBe("https://jobs.example.com/acme/123");
  expect(normaliseJobUrl("https://jobs.example.com/")).toBe("https://jobs.example.com/");
  expect(normaliseJobUrl("not a url/")).toBe("not a url");
});

test("findDuplicate matches URLs after normalisation", () => {
  const d = tmp();
  const a = createApplication(d, job("Atlas", "Backend Engineer"), { kind: "url", text: "t", url: "https://jobs.example.com/acme/123?utm_campaign=x" });
  expect(findDuplicate(d, { url: "https://JOBS.example.com/acme/123/#top", company: "", role: "" })?.slug).toBe(a.slug);
  expect(findDuplicate(d, { url: "https://jobs.example.com/acme/124", company: "", role: "" })).toBeNull();
});
