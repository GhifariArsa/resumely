import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { openInEditor } from "../commands/editor";
import { lineReader, noReadAheadStdin, type PromptIO } from "../commands/prompt";
import { UserError } from "../errors";
import { acceptProposal, asDuplicateOf, bodyOf, entryMarkdown, liveDuplicate, previewProposal, privateSections, rejectProposal } from "./accept";
import { inboxDir, listProposals, saveProposal, takenIds } from "./inbox";
import { loadProfile, parseEntryText } from "./load";
import { AboutChange, ProposedEntry, type Proposal } from "./proposal";
import { EntryIdSchema, SkillsSchema } from "./schema";

const subject = (p: Proposal) => p.entry?.id ?? (p.kind === "skills" ? "skills" : "about");

function what(p: Proposal): string {
  if (p.entry) return p.entry.org ? `${p.entry.title} @ ${p.entry.org}` : p.entry.title;
  if (p.kind === "skills") return `skills: ${Object.values(p.skills ?? {}).flat().join(", ")}`;
  return `about: ${Object.keys(p.about ?? {}).join(", ")}`;
}

export function formatInboxList(ps: Proposal[]): string {
  if (!ps.length) return "Inbox is empty.";
  const rows = [
    ["PID", "KIND", "ENTRY", "TITLE", "SOURCE", "FLAGS"],
    ...ps.map((p) => [p.pid, p.kind, p.entry?.id ?? "-", what(p), `${p.source.kind}:${p.source.ref}`, p.flags.length ? String(p.flags.length) : "-"]),
  ];
  const w = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(w[c]!))).join("  ")).join("\n");
}

type Out = { write(s: string): unknown };

/** The proposal after the user edited its text, or a UserError describing what is wrong. */
function applyEdit(profileDir: string, p: Proposal, text: string): Proposal {
  if (p.kind === "skills" || p.kind === "about") {
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (e) {
      throw new UserError(`invalid YAML: ${(e as Error).message.split("\n")[0]}`);
    }
    const body = (doc as Record<string, unknown> | null)?.[p.kind];
    const r = (p.kind === "skills" ? SkillsSchema : AboutChange).safeParse(body);
    if (!r.success) throw new UserError(`invalid ${p.kind}: ${r.error.issues.map((i) => `${i.path.join(".") || p.kind}: ${i.message}`).join("; ")}`);
    return { ...p, [p.kind]: r.data };
  }
  const old = p.entry!;
  const parsed = parseEntryText(text, `${p.pid}.edit.md`);
  if (p.kind === "update" || p.kind === "duplicate") {
    if (parsed.id !== p.target_id) throw new UserError(`id must stay ${p.target_id}`);
  } else {
    if (!EntryIdSchema.safeParse(parsed.id).success) throw new UserError(`invalid id "${parsed.id}"`);
    if (parsed.id !== old.id && takenIds(profileDir, loadProfile(profileDir)).has(parsed.id)) throw new UserError(`id "${parsed.id}" is already taken`);
  }
  const { privateLines: _pl, file: _f, body, ...fm } = parsed;
  return { ...p, entry: ProposedEntry.parse({ ...fm, bullets: old.bullets, context: old.context, body }) };
}

/**
 * Edit `p` in the editor and save it. `## Private` sections typed into an entry are returned separately as
 * `privateText`, never saved to the inbox (agents can read it); they are written only if accepted in this session.
 */
async function editProposal(
  profileDir: string,
  p: Proposal,
  privateText: string,
  edit: (file: string) => Promise<void>,
): Promise<{ proposal: Proposal; privateText: string }> {
  const isEntry = !!p.entry;
  const file = join(inboxDir(profileDir), `${p.pid}.edit.${isEntry ? "md" : "yaml"}`);
  writeFileSync(file, isEntry ? entryMarkdown(p.entry!) + (privateText ? `\n${privateText}` : "") : stringify({ [p.kind]: p.kind === "skills" ? p.skills : p.about }));
  try {
    await edit(file);
    const text = await Bun.file(file).text();
    const next = applyEdit(profileDir, p, text);
    saveProposal(profileDir, next);
    return { proposal: next, privateText: isEntry ? privateSections(bodyOf(text)) : "" };
  } finally {
    if (existsSync(file)) unlinkSync(file);
  }
}

export async function reviewInbox(o: {
  profileDir: string;
  io?: PromptIO;
  edit?: (file: string) => Promise<void>;
  out?: Out;
}): Promise<{ accepted: string[]; rejected: string[]; skipped: string[] }> {
  const { profileDir } = o;
  const out = o.out ?? process.stderr;
  const edit = o.edit ?? ((f: string) => openInEditor(f));
  // Reads stdin only while asking, so the editor (which inherits stdin) gets every keystroke.
  const reader = lineReader({ input: o.io?.input ?? noReadAheadStdin, output: o.io?.output ?? out });
  const res = { accepted: [] as string[], rejected: [] as string[], skipped: [] as string[] };
  const queue = listProposals(profileDir);
  const n = queue.length;
  let visited = 0;

  let priv = ""; // `## Private` text from editing the current proposal; kept in memory only
  const show = (p: Proposal) => {
    out.write(`${p.rationale ? p.rationale + "\n" : ""}${p.flags.map((f) => `! ${f}\n`).join("")}${previewProposal(profileDir, p, priv).replace(/\n?$/, "\n")}`);
  };
  const dropPrivate = () => {
    if (priv) out.write("note: private notes from your edit were not saved (they are written only when you accept)\n");
    priv = "";
  };

  try {
    outer: for (const [i, first] of queue.entries()) {
      let p = first;
      priv = "";
      out.write(`\n[${i + 1}/${n}] ${p.pid}  ${p.kind}  ${subject(p)}   (${p.source.kind}: ${p.source.ref})\n`);
      show(p);
      let noted = "";
      for (;;) {
        // A `new` proposal may duplicate an entry accepted earlier (in this review or since it was staged).
        const dupOf = p.kind === "duplicate" ? p.target_id : liveDuplicate(profileDir, p)?.id;
        const dup = dupOf !== undefined;
        if (p.kind === "new" && dup && noted !== dupOf) {
          // Show what [u]pdate would change before asking.
          out.write(`possible duplicate of ${(noted = dupOf!)}; [u]pdate would apply:\n${previewProposal(profileDir, asDuplicateOf(p, dupOf!), priv).replace(/\n?$/, "\n")}`);
        }
        const prompt = dup ? `[u]pdate ${dupOf} / [n]ew entry / [e]dit / [r]eject / [s]kip / [q]uit: ` : "[a]ccept [e]dit [r]eject [s]kip [q]uit: ";
        const raw = await reader.ask(prompt);
        if (raw === null) {
          dropPrivate();
          break outer;
        }
        const a = raw.trim().toLowerCase();
        if (a === "q") {
          dropPrivate();
          break outer;
        }
        if (a === "s") {
          dropPrivate();
          res.skipped.push(p.pid);
          break;
        }
        if (a === "r") {
          rejectProposal(profileDir, p);
          out.write(`rejected ${p.pid}\n`);
          res.rejected.push(p.pid);
          break;
        }
        if (a === "e") {
          try {
            ({ proposal: p, privateText: priv } = await editProposal(profileDir, p, priv, edit));
            show(p);
          } catch (e) {
            if (!(e instanceof UserError)) throw e;
            out.write(`error: ${e.message}\n${e.hint ? `hint: ${e.hint}\n` : ""}`);
          }
          continue;
        }
        const acceptAs = dup ? (a === "u" ? "update" : a === "n" ? "new" : undefined) : a === "a" ? ("a" as const) : undefined;
        if (!acceptAs) continue;
        try {
          const r = acceptProposal(profileDir, p, { ...(acceptAs === "a" ? {} : { as: acceptAs }), privateText: priv });
          out.write(`accepted ${p.pid} → profile/${r.file}\n`);
          res.accepted.push(p.pid);
          break;
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
          out.write(`error: ${e.message}\n${e.hint ? `hint: ${e.hint}\n` : ""}`);
        }
      }
      visited = i + 1;
    }
  } finally {
    reader.close();
  }
  const pending = n - visited;
  out.write(`\n${res.accepted.length} accepted, ${res.rejected.length} rejected, ${res.skipped.length} skipped, ${pending} still pending\n`);
  return res;
}

