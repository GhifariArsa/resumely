import { z } from "zod";

export const ENTRY_TYPES = ["experience", "project", "education", "award", "publication", "volunteering", "certification", "other"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be YYYY-MM");

export const EntryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must match /^[a-z0-9][a-z0-9-]*$/");

export const AboutFrontmatter = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
  phone: z.string().optional(),
  location: z.string().optional(),
  headline: z.string().optional(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
  private: z.record(z.string(), z.unknown()).optional(),
});

export const EntryFrontmatter = z.object({
  id: EntryIdSchema,
  type: z.enum(ENTRY_TYPES).optional(),
  title: z.string().min(1),
  org: z.string().optional(),
  location: z.string().optional(),
  start: MonthSchema.optional(),
  end: z.union([MonthSchema, z.literal("present")]).optional(),
  url: z.string().optional(),
  skills: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const SkillsSchema = z.record(z.string(), z.array(z.string()));

export type About = {
  name: string;
  email: string;
  phone?: string;
  location?: string;
  headline?: string;
  links: { label: string; url: string }[];
  body: string;
};

export type Entry = {
  id: string;
  type: EntryType;
  title: string;
  org?: string;
  location?: string;
  start?: string;
  end?: string;
  url?: string;
  skills: string[];
  tags: string[];
  body: string;
  privateLines: number;
  file: string;
};

export type Skills = Record<string, string[]>;
export type Profile = { about: About; entries: Entry[]; skills: Skills; aboutPrivateKeys: number };
