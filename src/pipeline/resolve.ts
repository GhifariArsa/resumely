import { z } from "zod";
import { UserError } from "../errors";
import { ENTRY_TYPES, type EntryType } from "../profile/schema";
import type { Bullet, ResumeContent, ResumeSection } from "./schemas";

/** The entry shape shared by the agent payload and `entries.snapshot.json`. */
export type EntryLike = {
  id: string;
  type: EntryType;
  title: string;
  org?: string;
  location?: string;
  start?: string;
  end?: string;
  skills: string[];
};

/** Parses `entries.snapshot.json` (extra fields such as body/tags are ignored). */
export const EntrySnapshot = z.array(
  z.object({
    id: z.string().min(1),
    type: z.enum(ENTRY_TYPES),
    title: z.string().min(1),
    org: z.string().optional(),
    location: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    skills: z.array(z.string()).default([]),
  }),
);

export type ResolvedItem = {
  entry_id: string;
  heading: string;
  subheading?: string;
  location?: string;
  dates?: string;
  bullets: Bullet[];
};
export type ResolvedSection = { kind: ResumeSection["kind"]; title: string; items: ResolvedItem[] };
export type ResolvedResume = Omit<ResumeContent, "sections"> & { sections: ResolvedSection[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function month(ym: string): string {
  if (ym === "present") return "Present";
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** `YYYY-MM` / `present` → `Mar 2023 – Present`; a single date when only one side is known. */
export function formatDates(start?: string, end?: string): string | undefined {
  if (start && end) return `${month(start)} – ${month(end)}`;
  if (start) return month(start);
  if (end && end !== "present") return month(end);
  return undefined;
}

function subheadingOf(e: EntryLike): string | undefined {
  if (e.org) return e.org;
  if (e.type === "project" && e.skills.length) return e.skills.join(", ");
  return undefined;
}

/** Fill each item's heading/subheading/location/dates deterministically from the entry it cites. */
export function resolveResume(content: ResumeContent, entries: EntryLike[]): ResolvedResume {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    ...content,
    sections: content.sections.map((s) => ({
      kind: s.kind,
      title: s.title,
      items: s.items.map((it) => {
        const e = byId.get(it.entry_id);
        if (!e) throw new UserError(`Resume cites unknown entry "${it.entry_id}"`, "Every item's entry_id must exist in the profile");
        const out: ResolvedItem = { entry_id: it.entry_id, heading: e.title, bullets: it.bullets };
        const sub = subheadingOf(e);
        const dates = formatDates(e.start, e.end);
        if (sub) out.subheading = sub;
        if (e.location) out.location = e.location;
        if (dates) out.dates = dates;
        return out;
      }),
    })),
  };
}
