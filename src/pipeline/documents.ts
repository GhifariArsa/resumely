import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AtsExpect } from "../checks/ats";
import { hasToken } from "../checks/fabrication";
import { buildHardFacts } from "../checks/facts";
import type { AdapterConfig } from "../config";
import { UserError } from "../errors";
import type { AgentPayload } from "../profile/context";
import type { About, Profile } from "../profile/schema";
import { compileTex } from "../render/compile";
import { extractPdfTextDetailed } from "../render/pdftext";
import { renderCoverLetter, renderResume, type TemplateMeta } from "../render/render";
import { revisionInstructions, writeRevisionFiles, type Produced, type Revision } from "./refine";
import { resolveResume, type EntryLike } from "./resolve";
import { jsonSchemaFor, type CompanyResearch, type CoverLetterContent, type ParsedJob, type ResumeContent } from "./schemas";
import { normaliseSkill, validateCoverLetter, validateResume } from "./validate";
import { json } from "./version";
import { runAgentStep, type Fallback, type StepCache } from "./workspace";

type Mode = "truthful" | "stretch";
type JobRef = { company: string; role: string };

const prompt = (name: string) => Bun.file(join(import.meta.dir, "prompts", name)).text();

/** The heading the classic templates render above the skills groups. */
export const SKILLS_HEADING = "Technical Skills";
const SNIPPET = 60;

/** Profile text keyword coverage is checked against (entries' titles, orgs, bodies and skills, plus the skills file). */
export function profileTextOf(entries: { title?: string; org?: string; body?: string; skills?: string[] }[], skills: string[] = []): string {
  return [...entries.flatMap((e) => [e.title ?? "", e.org ?? "", e.body ?? "", ...(e.skills ?? [])]), ...skills].join("\n");
}

export function resumeAtsExpect(about: About, c: ResumeContent): AtsExpect {
  return {
    name: about.name,
    email: about.email,
    phone: about.phone,
    headings: [...c.sections.map((s) => s.title), ...(c.skills.length ? [SKILLS_HEADING] : [])],
    snippets: c.sections.flatMap((s) => s.items.flatMap((i) => i.bullets.map((b) => b.text.slice(0, SNIPPET)))),
  };
}

export function coverAtsExpect(about: About, c: CoverLetterContent): AtsExpect {
  return { name: about.name, email: about.email, headings: [], snippets: c.paragraphs.map((p) => p.text.slice(0, SNIPPET)) };
}

const resumeText = (c: ResumeContent) =>
  [c.summary?.text ?? "", ...c.sections.flatMap((s) => [s.title, ...s.items.flatMap((i) => i.bullets.map((b) => b.text))]), ...c.skills.flatMap((g) => [g.category, ...g.items])].join("\n");
const coverText = (c: CoverLetterContent) => [c.greeting, ...c.paragraphs.map((p) => p.text), c.closing].join("\n\n");

type Measure = { keywords: string[]; profileText: string; fabricationWarnings?: string[] };

/** Compile, extract the text once and measure it. */
async function measure(tex: string, engine: TemplateMeta["engine"], targetPages: number, atsExpect: AtsExpect, contentText: string, m: Measure): Promise<Produced> {
  const { pdf, pages, fill } = await compileTex(tex, engine);
  const ex = await extractPdfTextDetailed(pdf);
  const facts = await buildHardFacts(
    { pdf, pages, fill, targetPages, atsExpect, contentText, keywords: m.keywords, profileText: m.profileText, fabricationWarnings: m.fabricationWarnings },
    { text: ex.text, reason: ex.reason },
  );
  return { tex, pdf, pages, fill, facts, text: ex.text ?? contentText };
}

export function produceResume(o: Measure & { template: TemplateMeta; about: About; content: ResumeContent; entries: EntryLike[]; job: JobRef; targetPages: number }): Promise<Produced> {
  const tex = renderResume(o.template, { about: o.about, resume: resolveResume(o.content, o.entries), job: o.job });
  return measure(tex, o.template.engine, o.targetPages, resumeAtsExpect(o.about, o.content), resumeText(o.content), o);
}

/** A cover letter is always one page. It never underflows: its length is set by the 200–400 word bound, not page fill. */
export async function produceCover(o: Measure & { template: TemplateMeta; about: About; letter: CoverLetterContent; job: JobRef; date: string }): Promise<Produced> {
  const tex = renderCoverLetter(o.template, { about: o.about, letter: o.letter, job: o.job, date: o.date });
  const p = await measure(tex, o.template.engine, 1, coverAtsExpect(o.about, o.letter), coverText(o.letter), o);
  return { ...p, facts: { ...p.facts, underflow: false } };
}

/**
 * Stretch claims for the user to check: `inferred` bullets, and listed skills that no skills list contains
 * (allowed in stretch because an entry body names them), cited to those entries.
 */
export function inferredClaims(c: ResumeContent, profile: Profile): { text: string; entry_ids: string[] }[] {
  const bullets = c.sections.flatMap((s) => s.items.flatMap((i) => i.bullets.filter((b) => b.basis === "inferred").map((b) => ({ text: b.text, entry_ids: b.entry_ids }))));
  const listed = new Set([...Object.values(profile.skills).flat(), ...profile.entries.flatMap((e) => e.skills)].map(normaliseSkill));
  const skills = c.skills.flatMap((g) => g.items).filter((v) => !listed.has(normaliseSkill(v)));
  return [
    ...bullets,
    ...[...new Set(skills.map((v) => v.trim()))].map((v) => ({ text: `skill: ${v}`, entry_ids: profile.entries.filter((e) => hasToken(e.body, v, true)).map((e) => e.id) })),
  ];
}

/** Truthful rules, plus the stretch rules when stretching. */
export async function modeRules(mode: Mode): Promise<string> {
  const truthful = (await prompt("rules-truthful.md")).trimEnd();
  return mode === "truthful" ? `${truthful}\n- \`basis\` is always \`"direct"\`.` : `${truthful}\n\n${(await prompt("rules-stretch.md")).trimEnd()}`;
}

export type DocContext = {
  adapter: AdapterConfig;
  name: string;
  timeoutMs: number;
  profile: Profile;
  payload: AgentPayload;
  job: ParsedJob;
  /** Company/role as the application records them (PDF metadata, letter heading). */
  appJob: JobRef;
  jobText: string;
  template: TemplateMeta;
  mode: Mode;
  profileText: string;
  onProgress?: (m: string) => void;
  /** Passed to the writer step (first write and revisions). */
  checkpoint?: StepCache;
  fallbacks?: Fallback[];
};

export type Doc<T> = {
  write: (ws: string, revision?: Revision<T>) => Promise<{ value: T; warnings: string[] }>;
  produce: (value: T) => Promise<Produced>;
};

/**
 * Wrap a writer + producer pair: the writer's raw fabrication warnings feed the hard facts of the value it
 * produced, and a compile failure names the workspace holding that value.
 */
function document<T extends object>(
  outFile: string,
  write: (ws: string, revision?: Revision<T>) => Promise<{ value: T; warnings: string[] }>,
  produce: (value: T, fabricationWarnings: string[]) => Promise<Produced>,
): Doc<T> {
  const origin = new WeakMap<T, { ws: string; warnings: string[] }>();
  return {
    async write(ws, revision) {
      const r = await write(ws, revision);
      origin.set(r.value, { ws, warnings: r.warnings });
      return { value: r.value, warnings: r.warnings.map((w) => `fabrication: ${w}`) };
    },
    async produce(value) {
      const from = origin.get(value);
      try {
        return await produce(value, from?.warnings ?? []);
      } catch (e) {
        if (from && e instanceof UserError) throw new UserError(e.message, `${e.hint ? `${e.hint} — ` : ""}content saved at ${join(from.ws, "out", outFile)}`);
        throw e;
      }
    },
  };
}

async function instructionsFor(base: string, ws: string, revision?: Revision<unknown>): Promise<string> {
  if (!revision) return base;
  writeRevisionFiles(ws, revision);
  return `${base}\n\n${await revisionInstructions()}`;
}

export async function resumeDocument(ctx: DocContext, o: { targetPages: number }): Promise<Doc<ResumeContent>> {
  const base = (await prompt("write-resume.md")).replaceAll("{{pages}}", String(o.targetPages)).replaceAll("{{mode_rules}}", await modeRules(ctx.mode));
  return document<ResumeContent>(
    "resume.json",
    async (ws, revision) => {
      if (!revision) ctx.onProgress?.(`writing resume (${ctx.name})…`);
      return runAgentStep({
        adapter: ctx.adapter,
        name: ctx.name,
        workspace: ws,
        instructions: await instructionsFor(base, ws, revision),
        files: { "profile.json": json(ctx.payload), "job.md": ctx.jobText, "parsed-job.json": json(ctx.job), "resume.schema.json": json(jsonSchemaFor("resume")) },
        outFile: "resume.json",
        validate: (raw) => validateResume(raw, ctx.profile, ctx.mode),
        timeoutMs: ctx.timeoutMs,
        onProgress: ctx.onProgress,
        checkpoint: ctx.checkpoint,
        fallbacks: ctx.fallbacks,
      });
    },
    (content, fabricationWarnings) => {
      ctx.onProgress?.("compiling resume…");
      return produceResume({ ...ctx, about: ctx.profile.about, content, entries: ctx.payload.entries, job: ctx.appJob, targetPages: o.targetPages, keywords: ctx.job.keywords, fabricationWarnings });
    },
  );
}

/** Cover writer inputs: profile, job, research, voice samples and banned phrases. Never the resume. */
export async function coverDocument(
  ctx: DocContext,
  o: { research: CompanyResearch | null; banned: string[]; voice: { name: string; text: string }[]; date: string },
): Promise<Doc<CoverLetterContent>> {
  const base = await prompt("write-cover-letter.md");
  const files: Record<string, string> = {
    "profile.json": json(ctx.payload),
    "job.md": ctx.jobText,
    "parsed-job.json": json(ctx.job),
    "banned.json": json(o.banned),
    "cover-letter.schema.json": json(jsonSchemaFor("cover-letter")),
  };
  if (o.research) files["company.json"] = json(o.research);
  for (const v of o.voice) files[`voice/${v.name}`] = v.text;
  return document<CoverLetterContent>(
    "cover-letter.json",
    async (ws, revision) => {
      if (!revision) ctx.onProgress?.(`writing cover letter (${ctx.name})…`);
      if (o.voice.length) mkdirSync(join(ws, "voice"), { recursive: true });
      return runAgentStep({
        adapter: ctx.adapter,
        name: ctx.name,
        workspace: ws,
        instructions: await instructionsFor(base, ws, revision),
        files,
        outFile: "cover-letter.json",
        validate: (raw) =>
          validateCoverLetter(raw, { profile: ctx.profile, research: o.research, banned: o.banned, mode: ctx.mode, jobText: ctx.jobText, job: ctx.job }),
        timeoutMs: ctx.timeoutMs,
        onProgress: ctx.onProgress,
        checkpoint: ctx.checkpoint,
        fallbacks: ctx.fallbacks,
      });
    },
    (letter, fabricationWarnings) => {
      ctx.onProgress?.("compiling cover letter…");
      return produceCover({ ...ctx, about: ctx.profile.about, letter, job: ctx.appJob, date: o.date, keywords: ctx.job.keywords, fabricationWarnings });
    },
  );
}
