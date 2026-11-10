import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { slugify, sendReadyName, createApplication, listApplications, findApplication, nextVersionDir, latestVersion, findDuplicate, normaliseJobUrl, addNote } from "../src/application/store";
import { exportApplication, setStatus } from "../src/application/tracking";
import { formatApplicationList } from "../src/pipeline/apply";
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

function appWithVersions(o: { resume?: boolean; cover?: boolean } = { resume: true, cover: true }) {
  const dir = tmp();
  const app = createApplication(dir, job("Acme", "Dev"), src, new Date("2026-03-01T10:00:00Z"));
  const mk = (kind: "resume" | "cover-letter", ready: boolean, checks?: object) => {
    const v = nextVersionDir(app, kind);
    writeFileSync(join(v.dir, "meta.json"), JSON.stringify({ ready }));
    writeFileSync(join(v.dir, `${kind}.pdf`), "%PDF");
    if (checks) writeFileSync(join(v.dir, "checks.json"), JSON.stringify(checks));
  };
  if (o.resume !== false) mk("resume", true);
  if (o.cover) mk("cover-letter", true);
  return { dir, app, mk };
}

test("setStatus applied records sent from the latest versions", () => {
  const { app, mk } = appWithVersions();
  mk("resume", true);
  const out = setStatus(app, "applied", { now: new Date("2026-03-02T00:00:00Z") });
  expect(out.meta.status).toBe("applied");
  expect(out.meta.sent).toEqual({ resume: 2, cover_letter: 1 });
  expect(out.meta.applied_at).toBe("2026-03-02T00:00:00.000Z");
  const re = findApplication(join(app.dir, ".."), app.slug);
  expect(re.meta.sent).toEqual({ resume: 2, cover_letter: 1 });
  expect(re.meta.applied_at).toBe("2026-03-02T00:00:00.000Z");
});

test("setStatus applied refuses a not-ready version unless forced", () => {
  const { app, mk } = appWithVersions();
  mk("resume", false, { ats: { status: "failed", problems: ["no text"] }, overflow: false, pages: 1, target_pages: 1 });
  expect(() => setStatus(app, "applied")).toThrow(/resume v2 is not ready: ATS check failed: no text/);
  try { setStatus(app, "applied"); } catch (e) { expect((e as UserError).hint).toBe("Fix and re-run, or pass --force"); }
  expect(setStatus(app, "applied", { force: true }).meta.sent?.resume).toBe(2);
});

test("setStatus other statuses leave sent alone", () => {
  const { app } = appWithVersions();
  const out = setStatus(app, "interviewing");
  expect(out.meta.status).toBe("interviewing");
  expect(out.meta.sent).toBeUndefined();
});

test("addNote appends a dated note", () => {
  const { app } = appWithVersions();
  addNote(app, "recruiter called", new Date("2026-03-05T12:00:00Z"));
  expect(findApplication(join(app.dir, ".."), app.slug).meta.notes).toEqual(["2026-03-05: recruiter called"]);
});

test("exportApplication copies resume and cover PDFs and refuses overwrites", () => {
  const { app } = appWithVersions();
  const to = tmp();
  const paths = exportApplication(app, { to });
  expect(paths.map((p: string) => p.split("/").pop()).sort()).toEqual(["cover-letter.pdf", "resume.pdf"]);
  expect(readdirSync(to).length).toBe(2);
  expect(() => exportApplication(app, { to })).toThrow(/already exists.*resume\.pdf|resume\.pdf.*already exists/);
});

test("formatApplicationList shows !, vN and sent", () => {
  const { app, mk } = appWithVersions();
  mk("cover-letter", false);
  setStatus(app, "applied", { force: true });
  const out = formatApplicationList([findApplication(join(app.dir, ".."), app.slug)]);
  expect(out.split("\n")[0]).toBe("DATE        COMPANY  ROLE  STATUS   RESUME  COVER  SENT");
  expect(out).toMatch(/applied\s+v1\s+v2!\s+r1\/c2/);
});

test("formatApplicationList filters are applied by the caller helper", () => {
  const { app } = appWithVersions();
  const apps = [app];
  expect(formatApplicationList(apps, { status: "offer" })).toContain("No applications match");
  expect(formatApplicationList(apps, { company: "acm" })).toContain("Acme");
});

test("exportApplication copies whatever documents exist; errors only when neither does", () => {
  const coverOnly = appWithVersions({ resume: false, cover: true });
  const to = tmp();
  expect(exportApplication(coverOnly.app, { to }).map((p: string) => p.split("/").pop())).toEqual(["cover-letter.pdf"]);
  const resumeOnly = appWithVersions({ resume: true, cover: false });
  expect(exportApplication(resumeOnly.app, { to: tmp() }).map((p: string) => p.split("/").pop())).toEqual(["resume.pdf"]);
  const none = appWithVersions({ resume: false, cover: false });
  expect(() => exportApplication(none.app, { to: tmp() })).toThrow(/has no documents yet/);
});

test("resolveOpenTarget falls back to the cover letter when there is no resume", async () => {
  const { resolveOpenTarget } = await import("../src/pipeline/apply");
  const coverOnly = appWithVersions({ resume: false, cover: true });
  const t = resolveOpenTarget(coverOnly.app);
  expect(t.label).toBe("cover letter v1");
  expect(t.path.endsWith("cover-letter/v1/cover-letter.pdf")).toBe(true);
  const both = appWithVersions();
  expect(resolveOpenTarget(both.app).label).toBe("resume v1");
  expect(resolveOpenTarget(both.app, undefined, "cover-letter").label).toBe("cover letter v1");
  // an explicit version or --cover never falls back
  expect(() => resolveOpenTarget(coverOnly.app, 1)).toThrow(/no resume v1/);
  expect(() => resolveOpenTarget(appWithVersions({ resume: true, cover: false }).app, undefined, "cover-letter")).toThrow(/no cover letter versions/);
});

test("nextVersionDir is safe under concurrent applies (separate processes take distinct versions)", async () => {
  const d = tmp();
  const a = createApplication(d, job("A", "B"), src);
  const file = join(d, "race.ts");
  writeFileSync(
    file,
    `import { nextVersionDir, findApplication } from ${JSON.stringify(join(import.meta.dir, "../src/application/store"))};
const a = findApplication(process.argv[2], process.argv[3]);
const out = [];
for (let i = 0; i < 25; i++) out.push(nextVersionDir(a, "cover-letter").version);
console.log(out.join(","));`,
  );
  const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", file, d, a.slug], { stdout: "pipe" }));
  const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
  await Promise.all(procs.map((p) => p.exited));
  const all = outs.flatMap((o) => o.trim().split(",").map(Number));
  expect(all.length).toBe(100);
  expect(new Set(all).size).toBe(100);
  expect(latestVersion(a, "cover-letter")!.version).toBe(100);
}, 30000);
