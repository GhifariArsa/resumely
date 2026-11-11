import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, createApplication, nextVersionDir, sendReadyName, type Application } from "../../src/application/store";
import { setStatus } from "../../src/application/tracking";
import type { HardFacts } from "../../src/checks/facts";
import { initDataRoot } from "../../src/commands/init";
import { layout } from "../../src/paths";
import { resolveResume } from "../../src/pipeline/resolve";
import { CoverLetterContent, ResumeContent, type ParsedJob, type Review } from "../../src/pipeline/schemas";
import { coverEntryIds, coverTrace, json, resumeEntryIds, resumeTrace, snapshotOf, versionMeta } from "../../src/pipeline/version";
import { buildAgentPayload } from "../../src/profile/context";
import { loadProfile } from "../../src/profile/load";

const fx = (p: string) => join(import.meta.dir, p);
const read = (p: string) => JSON.parse(readFileSync(fx(p), "utf8"));

const HOSTILE_BULLET = `Cut p99 <script>x</script> & "quotes"`;
const PDF = "%PDF-1.4\n%%EOF\n";

const facts = (o: Partial<HardFacts> = {}): HardFacts => ({
  pages: 1,
  target_pages: 1,
  fill: 0.9,
  overflow: false,
  underflow: false,
  word_count: 300,
  keywords: { present: ["Go"], missed_in_profile: [], absent: [] },
  ats: { status: "ok", problems: [] },
  fabrication_warnings: [],
  ...o,
});

const job = (company: string, role: string): ParsedJob => ({
  company, role, requirements: ["Go services"], nice_to_haves: [], keywords: ["Go", "Kafka", "Rust"], language: "en",
});

/** A temp data root with four applications. Mirrors what `apply` writes, minus LaTeX (no .tex files). */
export function makeUiRoot(): { root: string; atlas: string; hostile: string; empty: string; coverOnly: string } {
  const root = mkdtempSync(join(tmpdir(), "ui-root-"));
  initDataRoot(root);
  const l = layout(root);
  cpSync(fx("profile-jordan"), l.profile, { recursive: true });
  writeFileSync(join(l.profile, "extras/award-oss.md"), "---\nid: award-oss\ntype: award\ntitle: Open Source Award\n---\n\nRecognised for maintaining an open source library.\n");

  const profile = loadProfile(l.profile);
  const payload = buildAgentPayload(profile);
  const review: Review = read("review-pass.json");
  const resumeContent = ResumeContent.parse(read("resume-content.json"));
  const letter = CoverLetterContent.parse(read("cover-letter.json"));
  const company = read("company.json");

  const mk = (when: string, j: ParsedJob): Application =>
    createApplication(l.applications, j, { kind: "file", text: `# ${j.role}\n\nPosting for ${j.company}.\n` }, new Date(when));

  const resumeVersion = (app: Application, o: { content?: ResumeContent; facts?: HardFacts; review?: string | null; template?: string; extra?: Record<string, unknown> } = {}) => {
    const content = o.content ?? resumeContent;
    const f = o.facts ?? facts();
    const { dir } = nextVersionDir(app, "resume");
    const files: Record<string, string> = {
      "resume.json": json(content),
      "trace.json": json(resumeTrace(resolveResume(content, payload.entries))),
      "entries.snapshot.json": json(snapshotOf(resumeEntryIds(content), payload.entries)),
      "checks.json": json({ ...f, warnings: [] }),
      "meta.json": json(versionMeta({ mode: "truthful", facts: f, review: null, reviewedFinal: false, rounds: 0, research: "none_found", template: o.template ?? "classic", extra: o.extra })),
      [sendReadyName("{First}_{Last}_{Kind}_{Company}", profile.about, "Resume", app.meta.company)]: PDF,
    };
    if (o.review !== null) files["review.json"] = o.review ?? json(review);
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  };
  const coverVersion = (app: Application) => {
    const f = facts();
    const { dir } = nextVersionDir(app, "cover-letter");
    const files: Record<string, string> = {
      "cover-letter.json": json(letter),
      "trace.json": json(coverTrace(letter)),
      "entries.snapshot.json": json(snapshotOf(coverEntryIds(letter), payload.entries)),
      "company.snapshot.json": json(company.facts),
      "checks.json": json({ ...f, warnings: [] }),
      "meta.json": json(versionMeta({ mode: "truthful", facts: f, review: null, reviewedFinal: false, rounds: 0, research: "used", template: "classic" })),
      "review.json": json(review),
      [sendReadyName("{First}_{Last}_{Kind}_{Company}", profile.about, "Cover_Letter", app.meta.company)]: PDF,
    };
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  };

  const atlasApp = mk("2026-03-10T09:00:00Z", job("Atlas Freight", "Senior Backend Engineer"));
  resumeVersion(atlasApp);
  resumeVersion(atlasApp, {
    facts: facts({ ats: { status: "failed", problems: ["email not extractable"] }, keywords: { present: ["Go"], missed_in_profile: ["Kafka"], absent: ["Rust"] } }),
    review: null,
    extra: { rendered_from: 1 },
  });
  coverVersion(atlasApp);
  setStatus(atlasApp, "applied", { force: true, now: new Date("2026-03-11T09:00:00Z") });

  const hostileApp = mk("2026-03-05T09:00:00Z", job(`Acme <script>alert(1)</script> & "Co"`, "R&D <b>Lead</b>"));
  const hostileContent: ResumeContent = structuredClone(resumeContent);
  hostileContent.sections[0]!.items[0]!.bullets[0]!.text = HOSTILE_BULLET;
  resumeVersion(hostileApp, { content: hostileContent, review: `{"impression":` });
  setStatus(hostileApp, "interviewing");
  addNote(hostileApp, "<img src=x onerror=alert(1)>", new Date("2026-03-06T09:00:00Z"));

  const emptyApp = mk("2026-03-01T09:00:00Z", job("Orbit", "Designer"));
  const coverApp = mk("2026-02-20T09:00:00Z", job("Nimbus", "Data Engineer"));
  coverVersion(coverApp);

  return { root, atlas: atlasApp.slug, hostile: hostileApp.slug, empty: emptyApp.slug, coverOnly: coverApp.slug };
}
