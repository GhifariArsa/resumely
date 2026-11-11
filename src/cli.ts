#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { UserError } from "./errors";
import { resolveDataRoot, requireDataRoot, layout } from "./paths";
import { loadProfile } from "./profile/load";
import { acceptProposal, liveDuplicate, rejectProposal } from "./profile/accept";
import { findProposal, listProposals, profileReadiness } from "./profile/inbox";
import { importProfile } from "./profile/import";
import { formatLint, lintProfile } from "./profile/lint";
import { buildTrace, formatTrace } from "./application/trace";
import { formatInboxList, reviewInbox } from "./profile/review";
import { parseAddInput, stageAdd, type AddFlags } from "./profile/add";
import type { Proposal } from "./profile/proposal";
import { formatEntry, formatProfileContext, formatProfileTree } from "./profile/context";
import { AGENT_ENV, interviewHint, launchInterview } from "./profile/interview";
import { initDataRoot } from "./commands/init";
import { openFile } from "./commands/open";
import { resolveJobInput } from "./job/intake";
import { addNote, findApplication, listApplications } from "./application/store";
import { exportApplication, setStatus } from "./application/tracking";
import { confirmParsed, isInteractive, promptDuplicate } from "./commands/prompt";
import { savedNotReadyReasons } from "./pipeline/version";
import { applyJob, type DocResult, formatApplicationList, renderApplication, resolveOpenTarget } from "./pipeline/apply";

const NEXT_STEPS = [
  "resumely profile import ~/Downloads/resume.pdf   # or a LinkedIn PDF, .docx, .md, or a URL",
  "resumely profile review                          # accept what's right",
  "resumely apply --clip                            # tailor to a job",
];
const GETTING_STARTED_HELP = `\nGetting started:\n  resumely init\n${NEXT_STEPS.map((l) => `  ${l}`).join("\n")}`;

const program = new Command();
program.name("resumely").description("Agent-driven resume tailoring").addHelpText("after", GETTING_STARTED_HELP);

program
  .command("init")
  .description("Create the resumely data root")
  .action(() => {
    const root = resolveDataRoot();
    initDataRoot(root);
    console.log(`Initialized resumely data root at ${root}`);
    console.log(`\nNext:\n${NEXT_STEPS.map((l) => `  ${l}`).join("\n")}`);
  });

const profile = program.command("profile").description("Inspect your profile");

function load() {
  const root = resolveDataRoot();
  requireDataRoot(root);
  return loadProfile(layout(root).profile);
}

profile
  .command("show [id]")
  .description("Show the profile tree, or a single entry")
  .action((id?: string) => {
    const p = load();
    if (!id) return console.log(formatProfileTree(p));
    const e = p.entries.find((x) => x.id === id);
    if (!e) throw new UserError(`No entry with id "${id}"`, `Known ids: ${p.entries.map((x) => x.id).join(", ") || "(none)"}`);
    console.log(formatEntry(e));
  });

profile
  .command("context")
  .description("Print exactly what the agent will see (private content withheld)")
  .action(() => console.log(formatProfileContext(load())));

type Decision = { op: "accept" | "reject"; ref: string };
const decisions: Decision[] = []; // --accept/--reject in command-line order
const collect = (v: string, prev: string[]) => [...prev, v];

profile
  .command("add [type]")
  .description("Stage a proposal in the review inbox (never writes the live profile)")
  .option("--title <t>").option("--org <o>").option("--location <l>")
  .option("--start <YYYY-MM>").option("--end <YYYY-MM|present>").option("--url <u>")
  .option("--skill <s>", "skill (repeatable)", collect, [] as string[])
  .option("--tag <t>", "tag (repeatable)", collect, [] as string[])
  .option("--bullet <text>", "bullet (repeatable)", collect, [] as string[])
  .option("--link <label=url>", "about link (repeatable)", collect, [] as string[])
  .option("--context <text>").option("--update <id>", "propose a change to an existing entry")
  .option("--category <c>", "skill group, for type skills").option("--headline <h>").option("--phone <p>")
  .option("--email <e>").option("--name <n>").option("--summary <s>").option("--rationale <text>")
  .option("--json <file|->", "read the proposal as JSON from a file, or - for stdin")
  .option("--source <label>", "where the proposal came from (manual, interview, import)", "manual")
  .addHelpText(
    "after",
    `
Types: experience, project, education, award, publication, volunteering, certification, other, skills, about.

Example:
  resumely profile add --json - <<'EOF'
  {"type":"experience","title":"…","org":"…","start":"2024-01","end":"present","bullets":["…"]}
  EOF`,
  )
  .action(async (type: string | undefined, o: AddFlags & { json?: string; source: string }) => {
    const { json, source, ...flags } = o;
    let raw: unknown;
    if (json !== undefined) {
      const text = json === "-" ? await Bun.stdin.text() : readFileSync(json, "utf8");
      try {
        raw = JSON.parse(text);
      } catch {
        throw new UserError(`invalid proposal: --json is not valid JSON`, "resumely profile add --help");
      }
    }
    if (!["manual", "interview", "import"].includes(source)) throw new UserError(`Unknown --source "${source}"`, "Use manual, interview or import");
    const input = parseAddInput(type, flags, raw);
    const r = stageAdd(layout(dataRoot()).profile, load(), input, { kind: source as Proposal["source"]["kind"], ref: source });
    if (!r.staged.length) return console.log(`nothing new: ${r.skipped.join("; ") || "already in the profile"}`);
    for (const p of r.staged) console.log(`proposed ${p.pid} (${p.kind} ${p.entry?.id ?? p.kind})`);
  });

profile
  .command("review")
  .description("Review staged proposals: accept, edit or reject them (the only way they reach your profile)")
  .option("--list", "list pending proposals")
  .option("--accept <pid>", "accept a proposal (repeatable)", (v: string) => void decisions.push({ op: "accept", ref: v }))
  .option("--reject <pid>", "reject a proposal (repeatable)", (v: string) => void decisions.push({ op: "reject", ref: v }))
  .option("--accept-all", "accept every pending proposal except possible duplicates")
  .option("--as <mode>", "how to accept a duplicate: update or new (with exactly one --accept)")
  .action(async (o: { list?: boolean; acceptAll?: boolean; as?: string }) => {
    const pdir = layout(dataRoot()).profile;
    if (o.list) return console.log(formatInboxList(listProposals(pdir)));
    if (process.env[AGENT_ENV]) throw new UserError("profile review can't accept or reject from an agent session: only you can decide", "Run it yourself after the interview: resumely profile review");
    if (o.as !== undefined) {
      if (o.as !== "update" && o.as !== "new") throw new UserError(`Invalid --as "${o.as}"`, "Use update or new");
      if (decisions.filter((d) => d.op === "accept").length !== 1 || decisions.length !== 1) throw new UserError("--as needs exactly one --accept", "e.g. resumely profile review --accept 3 --as update");
    }
    if (!decisions.length && !o.acceptAll) {
      if (!isInteractive()) throw new UserError("profile review needs an interactive terminal", "Use --list, --accept <pid>, --reject <pid> or --accept-all");
      await reviewInbox({ profileDir: pdir });
      return;
    }
    const attempt = (fn: () => string) => {
      try {
        console.log(fn());
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        console.error(`error: ${e.message}${e.hint ? ` (${e.hint})` : ""}`);
        process.exitCode = 1;
      }
    };
    for (const d of decisions) {
      attempt(() => {
        const p = findProposal(pdir, d.ref);
        if (d.op === "reject") return rejectProposal(pdir, p), `rejected ${p.pid}`;
        return `accepted ${p.pid} → profile/${acceptProposal(pdir, p, { as: o.as as "update" | "new" | undefined }).file}`;
      });
    }
    if (o.acceptAll) {
      for (const p of listProposals(pdir)) {
        if (p.kind === "duplicate" || liveDuplicate(pdir, p)) console.log(`needs a decision: ${p.pid} (resumely profile review --accept ${p.pid} --as update|new)`);
        else attempt(() => `accepted ${p.pid} → profile/${acceptProposal(pdir, p).file}`);
      }
    }
  });

profile
  .command("import <source>")
  .description("Extract proposals from a resume (PDF, DOCX, Markdown, text, HTML or URL) into the review inbox")
  .option("--harness <name>", "agent harness to use")
  .action(async (source: string, o: { harness?: string }) => {
    const root = dataRoot();
    const r = await importProfile({ root, source, harness: o.harness, onProgress: progress });
    if (r.staged.length) {
      console.log(`staged ${r.staged.length} proposals:`);
      for (const p of r.staged) {
        const what = p.entry ? (p.entry.org ? `${p.entry.title} @ ${p.entry.org}` : p.entry.title) : "";
        console.log(`  ${p.pid}  ${p.kind}  ${p.entry?.id ?? p.kind}${what ? `  ${what}` : ""}`);
        for (const f of p.flags) console.log(`  ! ${f}`);
      }
    } else {
      console.log(`nothing new found in ${source}`);
    }
    if (r.skipped.length) console.log(["skipped:", ...r.skipped.map((s) => `  ${s}`)].join("\n"));
    for (const w of r.warnings) console.log(`warning: ${w}`);
    if (r.staged.length) console.log("next: resumely profile review");
  });

profile
  .command("lint")
  .description("Check your profile for problems (dates, empty entries, weak bullets)")
  .option("--json", "print the issues as JSON")
  .action((o: { json?: boolean }) => {
    const issues = lintProfile(dataRoot());
    console.log(o.json ? JSON.stringify(issues, null, 2) : formatLint(issues));
    if (issues.some((i) => i.severity === "error")) process.exitCode = 1;
  });

program
  .command("trace <app>")
  .description("Show which profile entries each resume (or --cover letter) line came from")
  .option("--cover", "trace the cover letter")
  .option("--version <n>", "version (default latest)")
  .option("--json", "print the trace as JSON")
  .action((query: string, o: { cover?: boolean; version?: string; json?: boolean }) => {
    const app = findApplication(layout(dataRoot()).applications, query);
    const t = buildTrace(app.dir, o.cover ? "cover-letter" : "resume", parseVersion(o.version));
    process.stdout.write(o.json ? JSON.stringify(t, null, 2) + "\n" : formatTrace(t));
  });

program
  .command("interview")
  .description("Open your agent harness interactively to interview you; its proposals wait in the review inbox")
  .option("--harness <name>", "agent harness to use")
  .option("--focus <text>", "what to ask about, e.g. \"recent work at Acme\"")
  .action(async (o: { harness?: string; focus?: string }) => {
    if (!isInteractive()) throw new UserError("interview needs an interactive terminal");
    const r = await launchInterview({ root: dataRoot(), harness: o.harness, focus: o.focus });
    console.error(r.proposals.length ? `${r.proposals.length} proposals staged — review them with: resumely profile review` : "no proposals staged");
    process.exitCode = r.exitCode;
  });

const progress = (m: string) => console.error(m);

function printWarnings(warnings: string[]) {
  for (const w of warnings) console.error(`warning: ${w}`);
}

function parseVersion(v?: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UserError(`Invalid version "${v}"`, "Use a number, e.g. --version 2");
  return Number(v);
}

function dataRoot() {
  const root = resolveDataRoot();
  requireDataRoot(root);
  return root;
}

const STATUSES = ["drafted", "applied", "interviewing", "rejected", "offer"] as const;

function doneLine(label: string, kind: "resume" | "cover-letter", appDir: string, d: DocResult): string {
  const base = `done: ${label} v${d.version} → ${d.pdfPath}`;
  if (d.ready) return `${base} (ready)`;
  return `${base} (not ready: ${savedNotReadyReasons(join(appDir, kind, `v${d.version}`))})`;
}

program
  .command("apply [input]")
  .description("Tailor a resume to a job (URL, file, or --clip)")
  .option("--clip", "read the job text from the clipboard")
  .option("--harness <name>", "agent harness to use")
  .option("--template <id>", "resume template")
  .option("--stretch", "allow inferred claims (listed for you to review)")
  .option("--pages <n>", "resume page target")
  .option("--no-cover", "skip the cover letter")
  .option("--no-research", "skip company research")
  .option("--no-review", "skip the review loop")
  .option("--review", "pause after parsing the job to confirm")
  .option("--into <app>", "add versions to an existing application")
  .option("--new", "create a separate application even if one exists")
  .option("--no-open", "don't open the PDF when done")
  .action(async (input: string | undefined, o: { clip?: boolean; harness?: string; template?: string; stretch?: boolean; pages?: string; cover: boolean; research: boolean; review?: boolean; into?: string; new?: boolean; open: boolean }) => {
    const root = dataRoot();
    if (o.into && o.new) throw new UserError("--into and --new can't be combined");
    let pages: number | undefined;
    if (o.pages !== undefined) {
      if (!/^[1-9]\d*$/.test(o.pages)) throw new UserError(`Invalid --pages "${o.pages}"`, "Use a positive number, e.g. --pages 2");
      pages = Number(o.pages);
    }
    const interactive = isInteractive();
    if (o.review === true && !interactive) throw new UserError("--review needs an interactive terminal");
    const ready = profileReadiness(layout(root).profile);
    printWarnings(ready.warnings);
    if (ready.error) throw ready.error;
    const into = o.into ? findApplication(layout(root).applications, o.into) : undefined;
    const src = await resolveJobInput(input, { clip: o.clip });
    const r = await applyJob({
      root, input: src, harness: o.harness, template: o.template, open: o.open, onProgress: progress,
      mode: o.stretch ? "stretch" : "truthful", pages, cover: o.cover, research: o.research, review: o.review !== false,
      pause: o.review === true ? confirmParsed : undefined,
      into,
      onDuplicate: o.new ? async () => "new" : interactive ? promptDuplicate : undefined,
    });
    if (r.resume) console.error(doneLine("resume", "resume", r.app.dir, r.resume));
    if (r.cover) console.error(doneLine("cover letter", "cover-letter", r.app.dir, r.cover));
    for (const f of r.failures) console.error(`failed: ${f.kind}: ${f.message}${f.hint ? ` (${f.hint})` : ""}`);
    if (r.inferred.length) console.error(["inferred claims to review:", ...r.inferred.map((c) => `  - ${c.text} [${c.entry_ids.join(", ")}]`)].join("\n"));
    if (r.gaps.length) console.error(["gaps:", ...r.gaps.map((g) => `  - ${g.requirement}: ${g.note}`)].join("\n"));
    if (r.gaps.length) console.error(`hint: if any of these are true, add them: ${interviewHint(r.gaps.slice(0, 5).map((g) => g.requirement))}`);
    printWarnings(r.warnings);
    if (r.failures.length || r.resume?.ready === false || r.cover?.ready === false) process.exitCode = 1;
  });

program
  .command("ls")
  .description("List applications")
  .option("--status <status>", `only this status (${STATUSES.join(", ")})`)
  .option("--company <query>", "only companies containing this text")
  .action((o: { status?: string; company?: string }) => {
    if (o.status && !(STATUSES as readonly string[]).includes(o.status)) throw new UserError(`Unknown status "${o.status}"`, `Use one of: ${STATUSES.join(", ")}`);
    console.log(formatApplicationList(listApplications(layout(dataRoot()).applications), o));
  });

program
  .command("open <app>")
  .description("Open an application's resume (or --cover letter) PDF")
  .option("--cover", "open the cover letter")
  .option("--version <n>", "version (default latest)")
  .action(async (query: string, o: { cover?: boolean; version?: string }) => {
    const app = findApplication(layout(dataRoot()).applications, query);
    const t = resolveOpenTarget(app, parseVersion(o.version), o.cover ? "cover-letter" : undefined);
    console.log(`Opening ${t.label}: ${t.path}`);
    await openFile(t.path);
  });

program
  .command("status <app> <status>")
  .description(`Set an application's status (${STATUSES.join(", ")})`)
  .option("--force", "mark applied even if a document is not ready")
  .action((query: string, status: string, o: { force?: boolean }) => {
    if (!(STATUSES as readonly string[]).includes(status)) throw new UserError(`Unknown status "${status}"`, `Use one of: ${STATUSES.join(", ")}`);
    const app = setStatus(findApplication(layout(dataRoot()).applications, query), status as (typeof STATUSES)[number], { force: o.force });
    console.log(`${app.slug}: ${app.meta.status}`);
  });

program
  .command("note <app> <text...>")
  .description("Add a dated note to an application")
  .action((query: string, text: string[]) => {
    const app = addNote(findApplication(layout(dataRoot()).applications, query), text.join(" "));
    console.log(`${app.slug}: ${app.meta.notes.at(-1)}`);
  });

program
  .command("export <app>")
  .description("Copy the send-ready PDFs to a folder (default ~/Desktop, else the current directory)")
  .option("--version <n>", "resume version (default latest)")
  .option("--to <dir>", "destination directory")
  .action((query: string, o: { version?: string; to?: string }) => {
    const app = findApplication(layout(dataRoot()).applications, query);
    const desktop = join(homedir(), "Desktop");
    const to = o.to ?? (existsSync(desktop) ? desktop : process.cwd());
    for (const p of exportApplication(app, { to, version: parseVersion(o.version) })) console.log(p);
  });

program
  .command("render <app>")
  .description("Re-render a resume (or --cover letter) version with another template (no agent call)")
  .requiredOption("--template <id>", "template id")
  .option("--cover", "re-render the cover letter")
  .option("--version <n>", "source version (default latest)")
  .option("--no-open", "don't open the PDF when done")
  .action(async (query: string, o: { template: string; cover?: boolean; version?: string; open: boolean }) => {
    const r = await renderApplication({ root: dataRoot(), query, template: o.template, kind: o.cover ? "cover-letter" : "resume", version: parseVersion(o.version), open: o.open, onProgress: progress });
    printWarnings(r.warnings);
    console.error(`done: ${r.pdfPath}`);
  });

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof UserError) {
    console.error(`error: ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
    process.exit(1);
  }
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  console.error("This is unexpected, please report it.");
  process.exit(2);
}
