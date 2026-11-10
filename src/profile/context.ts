import type { Entry, Profile } from "./schema";

/**
 * Remove `## Private…` sections (`## Private`, `## Private:`, `## Private notes`) up to the next `## `
 * heading or EOF. Counts non-blank lines withheld.
 */
export function stripPrivate(body: string): { body: string; privateLines: number } {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let inPrivate = false;
  let privateLines = 0;
  for (const line of lines) {
    if (/^##\s+Private\b.*$/i.test(line)) {
      inPrivate = true;
      continue;
    }
    if (inPrivate && /^##\s/.test(line)) inPrivate = false;
    if (inPrivate) {
      if (line.trim() !== "") privateLines++;
    } else {
      out.push(line);
    }
  }
  return { body: out.join("\n"), privateLines };
}

export type AgentPayload = {
  about: { name: string; headline?: string; location?: string; body: string };
  skills: Profile["skills"];
  entries: Omit<Entry, "file" | "privateLines">[];
};

export function buildAgentPayload(p: Profile): AgentPayload {
  return {
    about: { name: p.about.name, headline: p.about.headline, location: p.about.location, body: p.about.body },
    skills: p.skills,
    entries: p.entries.map(({ file: _f, privateLines: _p, ...rest }) => rest),
  };
}

/** Headings that mention "private" but survived stripping (e.g. `### Private`), so they reach the agent. */
export function privateHeadingWarnings(p: Profile): string[] {
  const sources = [{ id: "about.md", body: p.about.body }, ...p.entries];
  const out: string[] = [];
  for (const { id, body } of sources) {
    for (const line of body.split(/\r?\n/)) {
      if (/^#{1,6}\s/.test(line) && /private/i.test(line)) {
        out.push(`${id}: heading "${line.trim()}" is not withheld (only "## Private" sections are)`);
      }
    }
  }
  return out;
}

export function formatProfileContext(p: Profile): string {
  let out = JSON.stringify(buildAgentPayload(p), null, 2);
  const notes = p.entries.filter((e) => e.privateLines > 0).map((e) => `// ${e.id}: [private: ${e.privateLines} lines withheld]`);
  notes.push(...privateHeadingWarnings(p).map((w) => `// warning: ${w}`));
  if (notes.length) out += "\n" + notes.join("\n");
  return out;
}

function range(e: Entry): string {
  if (!e.start && !e.end) return "";
  return `${e.start ?? "?"} - ${e.end ?? "?"}`;
}

export function formatProfileTree(p: Profile): string {
  const lines = [`${p.about.name}${p.about.headline ? ` - ${p.about.headline}` : ""}`];
  const types = [...new Set(p.entries.map((e) => e.type))];
  for (const t of types) {
    lines.push("", `${t}:`);
    for (const e of p.entries.filter((x) => x.type === t)) {
      lines.push(`  ${e.id}  ${e.title}${e.org ? ` @ ${e.org}` : ""}${range(e) ? `  (${range(e)})` : ""}`);
    }
  }
  const cats = Object.keys(p.skills);
  if (cats.length) lines.push("", `skills: ${cats.join(", ")}`);
  if (p.entries.length === 0) lines.push("", "(no entries yet)");
  const warnings = privateHeadingWarnings(p);
  if (warnings.length) lines.push("", ...warnings.map((w) => `warning: ${w}`));
  return lines.join("\n");
}

export function formatEntry(e: Entry): string {
  const head = [
    `id: ${e.id}`,
    `type: ${e.type}`,
    `title: ${e.title}`,
    e.org && `org: ${e.org}`,
    e.location && `location: ${e.location}`,
    range(e) && `dates: ${range(e)}`,
    e.url && `url: ${e.url}`,
    e.skills.length && `skills: ${e.skills.join(", ")}`,
    e.tags.length && `tags: ${e.tags.join(", ")}`,
    e.privateLines > 0 && `[private: ${e.privateLines} lines withheld]`,
    `file: ${e.file}`,
  ].filter(Boolean);
  return head.join("\n") + "\n\n" + e.body.trim() + "\n";
}
