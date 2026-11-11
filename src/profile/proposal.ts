import { z } from "zod";
import { ENTRY_TYPES, EntryIdSchema, MonthSchema } from "./schema";

export const DraftEntry = z.object({
  type: z.enum(ENTRY_TYPES),
  title: z.string().min(1),
  org: z.string().optional(),
  location: z.string().optional(),
  start: MonthSchema.optional(),
  end: z.union([MonthSchema, z.literal("present")]).optional(),
  url: z.string().optional(),
  skills: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  bullets: z.array(z.string()).default([]),
  context: z.string().default(""),
});
export type DraftEntry = z.infer<typeof DraftEntry>;

/** A draft with its assigned id. `body`, when set (after a review edit), replaces the rendered bullets/context. */
export const ProposedEntry = DraftEntry.extend({ id: EntryIdSchema, body: z.string().optional() });
export type ProposedEntry = z.infer<typeof ProposedEntry>;

export const AboutChange = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  headline: z.string().optional(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
  summary: z.string().optional(),
});
export type AboutChange = z.infer<typeof AboutChange>;

/** The agent's `out/proposals.json`. */
export const ImportResult = z.object({
  proposals: z.array(
    z.object({
      kind: z.enum(["new", "update", "duplicate"]),
      target_id: z.string().optional(),
      entry: DraftEntry,
      rationale: z.string().min(1),
    }),
  ),
  skills: z.record(z.string(), z.array(z.string())).default({}),
  about: AboutChange.nullable().default(null),
});
export type ImportResult = z.infer<typeof ImportResult>;

export const Proposal = z
  .object({
    pid: z.string().regex(/^\d+-[a-z0-9-]+$/),
    kind: z.enum(["new", "update", "duplicate", "skills", "about"]),
    created: z.string(),
    source: z.object({ kind: z.enum(["import", "interview", "manual"]), ref: z.string(), run: z.string().optional() }),
    rationale: z.string().default(""),
    flags: z.array(z.string()).default([]),
    target_id: z.string().optional(),
    entry: ProposedEntry.optional(),
    skills: z.record(z.string(), z.array(z.string())).optional(),
    about: AboutChange.optional(),
    decision: z
      .object({
        kind: z.enum(["accepted", "rejected"]),
        at: z.string(),
        as: z.enum(["update", "new"]).optional(),
        file: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((p, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (["new", "update", "duplicate"].includes(p.kind) && !p.entry) bad(`kind "${p.kind}" needs an entry`);
    if (p.kind === "update" || p.kind === "duplicate") {
      if (!p.target_id) bad(`kind "${p.kind}" needs target_id`);
      else if (p.entry && p.entry.id !== p.target_id) bad("entry.id must equal target_id");
    }
    if (p.kind === "skills" && !p.skills) bad('kind "skills" needs skills');
    if (p.kind === "about" && !p.about) bad('kind "about" needs about');
  });
export type Proposal = z.infer<typeof Proposal>;

export type Draft = {
  kind: "new" | "update" | "duplicate";
  target_id?: string;
  entry: DraftEntry;
  rationale: string;
  flags?: string[];
};
