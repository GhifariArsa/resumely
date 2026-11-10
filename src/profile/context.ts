import type { Entry, Profile } from "./schema";

/** Remove `## Private` sections (to next `## ` heading or EOF). Counts non-blank lines withheld. */
export function stripPrivate(body: string): { body: string; privateLines: number } {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let inPrivate = false;
  let privateLines = 0;
  for (const line of lines) {
    if (/^##\s+Private\s*$/i.test(line)) {
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

export function buildAgentPayload(p: Profile): object {
  return {
    about: { name: p.about.name, headline: p.about.headline, location: p.about.location, body: p.about.body },
    skills: p.skills,
    entries: p.entries.map(({ file: _f, privateLines: _p, ...rest }) => rest),
  };
}

export function formatProfileContext(p: Profile): string {
  let out = JSON.stringify(buildAgentPayload(p), null, 2);
  const notes = p.entries.filter((e) => e.privateLines > 0).map((e) => `// ${e.id}: [private: ${e.privateLines} lines withheld]`);
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
