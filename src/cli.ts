#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { UserError } from "./errors";
import { resolveDataRoot, requireDataRoot, layout } from "./paths";
import { loadProfile } from "./profile/load";
import { formatEntry, formatProfileContext, formatProfileTree } from "./profile/context";
import { initDataRoot } from "./commands/init";
import { formatDoctor, runDoctor } from "./commands/doctor";
import { openFile } from "./commands/open";
import { resolveJobInput } from "./job/intake";
import { addNote, findApplication, listApplications } from "./application/store";
import { exportApplication, setStatus } from "./application/tracking";
import { confirmParsed, isInteractive, promptDuplicate } from "./commands/prompt";
import { savedNotReadyReasons } from "./pipeline/version";
import { formatTemplateList, listTemplates, newTemplate } from "./render/templates";
import { applyJob, type ApplyResult, type DocResult, formatApplicationList, renderApplication, resolveOpenTarget, resumeRun } from "./pipeline/apply";

const program = new Command();
program.name("resumely").description("Agent-driven resume tailoring");

program
  .command("init")
  .description("Create the resumely data root")
  .action(() => {
    const root = resolveDataRoot();
    initDataRoot(root);
    console.log(`Initialized resumely data root at ${root}`);
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

/** Print an apply/resume result; exit 1 when a document failed or is not ready. */
function report(r: ApplyResult) {
  if (r.resume) console.error(doneLine("resume", "resume", r.app.dir, r.resume));
  if (r.cover) console.error(doneLine("cover letter", "cover-letter", r.app.dir, r.cover));
  for (const f of r.failures) console.error(`failed: ${f.kind}: ${f.message}${f.hint ? ` (${f.hint})` : ""}`);
  if (r.inferred.length) console.error(["inferred claims to review:", ...r.inferred.map((c) => `  - ${c.text} [${c.entry_ids.join(", ")}]`)].join("\n"));
  if (r.gaps.length) console.error(["gaps:", ...r.gaps.map((g) => `  - ${g.requirement}: ${g.note}`)].join("\n"));
  printWarnings(r.warnings);
  if (r.failures.length) console.error(`hint: resume with: resumely resume ${r.runId} [--harness <other>]`);
  if (r.failures.length || r.resume?.ready === false || r.cover?.ready === false) process.exitCode = 1;
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
    const into = o.into ? findApplication(layout(root).applications, o.into) : undefined;
    const src = await resolveJobInput(input, { clip: o.clip });
    const r = await applyJob({
      root, input: src, harness: o.harness, template: o.template, open: o.open, onProgress: progress,
      mode: o.stretch ? "stretch" : "truthful", pages, cover: o.cover, research: o.research, review: o.review !== false,
      pause: o.review === true ? confirmParsed : undefined,
      into,
      onDuplicate: o.new ? async () => "new" : interactive ? promptDuplicate : undefined,
    });
    report(r);
  });

program
  .command("resume [run-id]")
  .description("Continue a failed run from its last finished step (default: the most recent failed run)")
  .option("--harness <name>", "agent harness to use from here on")
  .option("--no-open", "don't open the PDF when done")
  .action(async (runId: string | undefined, o: { harness?: string; open: boolean }) => {
    const r = await resumeRun({
      root: dataRoot(), runId, harness: o.harness, open: o.open, onProgress: progress,
      onDuplicate: isInteractive() ? promptDuplicate : undefined,
    });
    report(r);
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

const templates = program.command("templates").description("List and create resume templates");

templates
  .command("list")
  .description("List built-in and user templates")
  .action(() => console.log(formatTemplateList(listTemplates(resolveDataRoot()))));

templates
  .command("new <id>")
  .description("Create a user template by copying a base template")
  .requiredOption("--from <base>", "id of the template to copy")
  .action((id: string, o: { from: string }) => {
    const t = newTemplate(dataRoot(), id, o.from);
    console.log(`created ${t.dir}`);
    console.log(`hint: edit ${t.dir}/resume.tex.njk, then: resumely render <app> --template ${id}`);
  });

program
  .command("doctor")
  .description("Check harnesses, LaTeX, templates and your data root")
  .action(async () => {
    const { text, failed } = formatDoctor(await runDoctor({ root: resolveDataRoot() }));
    console.log(text);
    if (failed > 0) process.exitCode = 1;
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
