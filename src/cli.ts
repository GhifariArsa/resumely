#!/usr/bin/env bun
import { Command } from "commander";
import { UserError } from "./errors";
import { resolveDataRoot, requireDataRoot, layout } from "./paths";
import { loadProfile } from "./profile/load";
import { formatEntry, formatProfileContext, formatProfileTree } from "./profile/context";
import { initDataRoot } from "./commands/init";
import { openFile } from "./commands/open";
import { resolveJobInput } from "./job/intake";
import { findApplication, listApplications } from "./application/store";
import { applyJob, formatApplicationList, renderApplication, resolveOpenTarget } from "./pipeline/apply";

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

program
  .command("apply [input]")
  .description("Tailor a resume to a job (URL, file, or --clip)")
  .option("--clip", "read the job text from the clipboard")
  .option("--harness <name>", "agent harness to use")
  .option("--template <id>", "resume template")
  .option("--no-open", "don't open the PDF when done")
  .action(async (input: string | undefined, o: { clip?: boolean; harness?: string; template?: string; open: boolean }) => {
    const root = dataRoot();
    const src = await resolveJobInput(input, { clip: o.clip });
    const r = await applyJob({ root, input: src, harness: o.harness, template: o.template, open: o.open, onProgress: progress });
    printWarnings(r.warnings);
    if (r.gaps.length) console.error(["gaps:", ...r.gaps.map((g) => `  - ${g.requirement}: ${g.note}`)].join("\n"));
  });

program
  .command("ls")
  .description("List applications")
  .action(() => console.log(formatApplicationList(listApplications(layout(dataRoot()).applications))));

program
  .command("open <app>")
  .description("Open an application's resume PDF")
  .option("--version <n>", "resume version (default latest)")
  .action(async (query: string, o: { version?: string }) => {
    const app = findApplication(layout(dataRoot()).applications, query);
    await openFile(resolveOpenTarget(app, parseVersion(o.version)));
  });

program
  .command("render <app>")
  .description("Re-render a resume version with another template (no agent call)")
  .requiredOption("--template <id>", "template id")
  .option("--version <n>", "source version (default latest)")
  .option("--no-open", "don't open the PDF when done")
  .action(async (query: string, o: { template: string; version?: string; open: boolean }) => {
    const r = await renderApplication({ root: dataRoot(), query, template: o.template, version: parseVersion(o.version), open: o.open, onProgress: progress });
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
