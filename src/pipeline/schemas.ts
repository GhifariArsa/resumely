import { z } from "zod";

export const ParsedJob = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  location: z.string().optional(),
  seniority: z.string().optional(),
  requirements: z.array(z.string()),
  nice_to_haves: z.array(z.string()),
  keywords: z.array(z.string()),
  language: z.string().min(1),
});
export type ParsedJob = z.infer<typeof ParsedJob>;

export const Bullet = z.object({
  text: z.string().min(1),
  entry_ids: z.array(z.string()).min(1),
  basis: z.enum(["direct", "inferred"]),
});
export type Bullet = z.infer<typeof Bullet>;

export const ResumeItem = z.object({
  entry_id: z.string().min(1),
  heading: z.string().min(1),
  subheading: z.string().optional(),
  location: z.string().optional(),
  dates: z.string().optional(),
  bullets: z.array(Bullet),
});
export type ResumeItem = z.infer<typeof ResumeItem>;

export const ResumeSection = z.object({
  kind: z.enum(["experience", "projects", "education", "extras"]),
  title: z.string().min(1),
  items: z.array(ResumeItem),
});
export type ResumeSection = z.infer<typeof ResumeSection>;

export const ResumeContent = z.object({
  summary: z.object({ text: z.string().min(1), entry_ids: z.array(z.string()) }).optional(),
  sections: z.array(ResumeSection).min(1),
  skills: z.array(z.object({ category: z.string().min(1), items: z.array(z.string()) })),
  gaps: z.array(z.object({ requirement: z.string(), note: z.string() })),
});
export type ResumeContent = z.infer<typeof ResumeContent>;

export function jsonSchemaFor(kind: "parsed-job" | "resume"): object {
  return z.toJSONSchema(kind === "parsed-job" ? ParsedJob : ResumeContent) as object;
}
