import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadProfile } from "../src/profile/load";
import { buildAgentPayload } from "../src/profile/context";
import { ResumeContent } from "../src/pipeline/schemas";
import { formatDates, resolveResume, type EntryLike } from "../src/pipeline/resolve";
import { UserError } from "../src/errors";

const profile = loadProfile(join(import.meta.dir, "fixtures/profile-jordan"));
const entries = (buildAgentPayload(profile) as { entries: EntryLike[] }).entries;
const content = ResumeContent.parse(JSON.parse(readFileSync(join(import.meta.dir, "fixtures/resume-content.json"), "utf8")));

test("formatDates", () => {
  expect(formatDates("2023-03", "present")).toBe("Mar 2023 – Present");
  expect(formatDates("2019-06", "2022-12")).toBe("Jun 2019 – Dec 2022");
  expect(formatDates("2022-01", undefined)).toBe("Jan 2022");
  expect(formatDates(undefined, "2019-05")).toBe("May 2019");
  expect(formatDates(undefined, undefined)).toBeUndefined();
  expect(formatDates(undefined, "present")).toBeUndefined();
});

test("resolves headings, orgs, locations and dates from entries", () => {
  const r = resolveResume(content, entries);
  const atlas = r.sections[0]!.items[0]!;
  expect(atlas).toMatchObject({
    entry_id: "exp-atlas-labs",
    heading: "Senior Software Engineer",
    subheading: "Atlas Labs",
    location: "Montreal, QC",
    dates: "Mar 2023 – Present",
  });
  expect(atlas.bullets).toEqual(content.sections[0]!.items[0]!.bullets);
  expect(r.sections[0]!.items[1]!.dates).toBe("Jun 2019 – Dec 2022");
  expect(r.sections[2]!.items[0]).toMatchObject({ heading: "B.Sc. Computer Science", subheading: "Université de Montréal", dates: "Sep 2015 – May 2019" });
  expect(r.skills).toEqual(content.skills);
  expect(r.summary).toEqual(content.summary);
});

test("project without org uses its skills as subheading", () => {
  const r = resolveResume(content, entries);
  expect(r.sections[1]!.items[0]).toMatchObject({ heading: "Ledgerly", subheading: "TypeScript, PostgreSQL", dates: "Jan 2022 – Present" });
  expect(r.sections[1]!.items[1]!.subheading).toBe("Go");
});

test("non-project without org has no subheading; project without org or skills has none", () => {
  const es: EntryLike[] = [
    { id: "a", type: "award", title: "Hackathon winner", skills: ["Go"] },
    { id: "p", type: "project", title: "Thing", skills: [] },
  ];
  const c: ResumeContent = {
    sections: [
      { kind: "extras", title: "Awards", items: [{ entry_id: "a", bullets: [] }] },
      { kind: "projects", title: "Projects", items: [{ entry_id: "p", bullets: [] }] },
    ],
    skills: [],
    gaps: [],
  };
  const r = resolveResume(c, es);
  expect(r.sections[0]!.items[0]!.subheading).toBeUndefined();
  expect(r.sections[0]!.items[0]!.dates).toBeUndefined();
  expect(r.sections[1]!.items[0]!.subheading).toBeUndefined();
});

test("unknown entry throws UserError", () => {
  const c = structuredClone(content);
  c.sections[0]!.items[0]!.entry_id = "ghost";
  expect(() => resolveResume(c, entries)).toThrow(UserError);
});
