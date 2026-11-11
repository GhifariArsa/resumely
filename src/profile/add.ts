import { z } from "zod";
import { UserError } from "../errors";
import { schemaErrors } from "../pipeline/validate";
import { unsupportedChars } from "../render/latex-escape";
import { stageDrafts } from "./inbox";
import { dateIssues } from "./lint";
import { AboutChange, DraftEntry, type Draft, type Proposal } from "./proposal";
import { ENTRY_TYPES, type Profile } from "./schema";

export type AddFlags = {
  title?: string;
  org?: string;
  location?: string;
  start?: string;
  end?: string;
  url?: string;
  skill: string[];
  tag: string[];
  bullet: string[];
  context?: string;
  update?: string;
  category?: string;
  headline?: string;
  phone?: string;
  email?: string;
  name?: string;
  link: string[]; // "Label=https://…"
  summary?: string;
  rationale?: string;
};

const Extra = { rationale: z.string().optional() };
// An update may leave out the title: accepting it keeps the live one (only the keys a proposal sets change).
const EntryInput = DraftEntry.extend({ title: DraftEntry.shape.title.optional(), update: z.string().optional(), ...Extra })
  .strict()
  .superRefine((e, ctx) => {
    if (e.title === undefined && !e.update) ctx.addIssue({ code: "custom", path: ["title"], message: "required for a new entry (--title)" });
  });
const SkillsInput = z.object({ type: z.literal("skills"), skills: z.record(z.string(), z.array(z.string())), ...Extra }).strict();
const AboutInput = z.object({ type: z.literal("about"), about: AboutChange.strict(), ...Extra }).strict();

export type AddInput = z.infer<typeof EntryInput> | z.infer<typeof SkillsInput> | z.infer<typeof AboutInput>;

const HELP = "resumely profile add --help";
const invalid = (msgs: string[]) => new UserError(`invalid proposal: ${msgs.join("; ")}`, HELP);
const TYPES: string[] = [...ENTRY_TYPES, "skills", "about"];

function fromFlags(type: string, f: AddFlags): Record<string, unknown> {
  const rationale = f.rationale;
  if (type === "skills") {
    if (f.skill.length && !f.category) throw invalid(["category: --category is required with --skill for type skills"]);
    return { type, skills: f.category ? { [f.category]: f.skill } : {}, rationale };
  }
  if (type === "about") {
    const links = f.link.map((l) => {
      if (!/^[^=]+=https?:\/\//.test(l)) throw invalid([`link: "${l}" must look like Label=https://…`]);
      const i = l.indexOf("=");
      return { label: l.slice(0, i), url: l.slice(i + 1) };
    });
    return {
      type,
      about: { name: f.name, email: f.email, phone: f.phone, location: f.location, headline: f.headline, summary: f.summary, ...(links.length ? { links } : {}) },
      rationale,
    };
  }
  return {
    type, title: f.title, org: f.org, location: f.location, start: f.start, end: f.end, url: f.url,
    skills: f.skill, tags: f.tag, bullets: f.bullet, context: f.context, update: f.update, rationale,
  };
}

export function parseAddInput(type: string | undefined, flags: AddFlags, json: unknown | undefined): AddInput {
  let raw: Record<string, unknown>;
  if (json !== undefined) {
    const { rationale, ...rest } = flags;
    if (Object.values(rest).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined))) {
      throw new UserError("--json can't be combined with field flags", HELP);
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw invalid(["expected a JSON object"]);
    const obj = json as Record<string, unknown>;
    if (type !== undefined && obj.type !== undefined && obj.type !== type) {
      throw invalid([`type: "${type}" does not match the JSON type "${String(obj.type)}"`]);
    }
    raw = { ...obj, type: obj.type ?? type, ...(rationale !== undefined ? { rationale } : {}) };
  } else {
    if (!type) throw invalid(["type: required"]);
    if (!TYPES.includes(type)) throw invalid([`type: "${type}" is not one of ${TYPES.join(", ")}`]);
    raw = fromFlags(type, flags);
  }
  if (typeof raw.type !== "string" || !TYPES.includes(raw.type)) throw invalid([`type: must be one of ${TYPES.join(", ")}`]);
  const schema = raw.type === "skills" ? SkillsInput : raw.type === "about" ? AboutInput : EntryInput;
  const r = schema.safeParse(raw);
  if (!r.success) throw invalid(schemaErrors(r.error.issues));
  return r.data;
}

function charErrors(where: string, text: string, errors: string[]): void {
  for (const c of unsupportedChars(text)) {
    errors.push(`${where}: unsupported character "${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
  }
}

export function stageAdd(
  profileDir: string,
  profile: Profile,
  input: AddInput,
  source: Proposal["source"],
  now: Date = new Date(),
): { staged: Proposal[]; skipped: string[] } {
  const errors: string[] = [];
  if (input.type === "skills") {
    for (const [g, items] of Object.entries(input.skills)) items.forEach((s, j) => charErrors(`skills.${g}[${j}]`, s, errors));
    if (errors.length) throw invalid(errors);
    return stageDrafts(profileDir, profile, [], { skills: input.skills }, source, now);
  }
  if (input.type === "about") return stageDrafts(profileDir, profile, [], { about: input.about }, source, now);

  const { update, rationale, ...rest } = input;
  const live = update ? profile.entries.find((e) => e.id === update) : undefined;
  if (update && !live) throw new UserError(`No entry "${update}" to update`, "resumely profile show");
  // Without --title an update carries the live title, which accepting leaves unchanged.
  const entry = DraftEntry.parse({ ...rest, title: rest.title ?? live?.title });
  for (const d of dateIssues(entry, now)) if (d.severity === "error") errors.push(`${d.message}`);
  charErrors("title", entry.title, errors);
  if (entry.org) charErrors("org", entry.org, errors);
  if (entry.location) charErrors("location", entry.location, errors);
  entry.skills.forEach((s, j) => charErrors(`skills[${j}]`, s, errors));
  if (errors.length) throw invalid(errors);

  const draft: Draft = update
    ? { kind: "update", target_id: update, entry, rationale: rationale ?? "" }
    : { kind: "new", entry, rationale: rationale ?? "" };
  return stageDrafts(profileDir, profile, [draft], {}, source, now);
}
