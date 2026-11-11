import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterConfig } from "../config";
import { UserError } from "../errors";
import { onInterrupt } from "../signals";
import { CompanyResearch, jsonSchemaFor } from "./schemas";
import type { ParsedJob } from "./schemas";
import { validateResearch } from "./validate";
import { createRunWorkspace, runAgentStep } from "./workspace";

const CONFIDENTIAL = /confidential|undisclosed|stealth|via .+ (recruit|agency)/i;

export const isConfidential = (job: ParsedJob): boolean => CONFIDENTIAL.test(job.company);

export function renderCompanyMd(r: CompanyResearch): string {
  const facts = r.facts.map((f) => `- ${f.text} [${f.id}](${f.source_url})`).join("\n") || "None found.";
  const sources = r.sources.map((s) => `- ${s}`).join("\n") || "None.";
  return `# ${r.company}\n\n${r.summary}\n\n## Facts\n\n${facts}\n\n## Sources\n\n${sources}\n`;
}

/** The saved research for an application (`<appDir>/job/company.json`), or null when missing or invalid. */
export function loadCompanyResearch(appDir: string): CompanyResearch | null {
  const path = join(appDir, "job", "company.json");
  if (!existsSync(path)) return null;
  try {
    const r = validateResearch(JSON.parse(readFileSync(path, "utf8")));
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

export type ResearchStatus = "used" | "none_found" | "skipped" | "failed";
export type ResearchOutcome = { research: CompanyResearch | null; status: ResearchStatus; warning?: string };

/** A research result with no facts is "none_found": nothing verifiable, which is a valid answer, not a failure. */
const outcome = (r: CompanyResearch): ResearchOutcome => (r.facts.length ? { research: r, status: "used" } : { research: null, status: "none_found" });

/** The only job data the web-capable research agent receives (never the posting text or the profile). */
export function researchTarget(job: ParsedJob, url?: string): { company: string; role: string; location?: string; url?: string } {
  return { company: job.company, role: job.role, ...(job.location ? { location: job.location } : {}), ...(url ? { url } : {}) };
}

/** Copy the agent's output, logs and errors from the temp workspace into the run. */
function copyBack(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  if (!existsSync(from)) return;
  for (const name of readdirSync(from)) {
    if (name === "out" || name === "errors.md" || /^(stdout|stderr)(\.\d+)?\.log$/.test(name)) cpSync(join(from, name), join(to, name), { recursive: true });
  }
}

/**
 * Research the company with a web-capable agent. The agent runs in a fresh OS temp dir (outside the data root)
 * that holds only `target.json` and the schema; its output and logs are copied into `<run>/research/`.
 */
export async function runResearch(o: {
  adapter: AdapterConfig | null;
  name: string;
  runsDir: string;
  runId: string;
  appDir: string;
  job: ParsedJob;
  /** The posting's source URL, if it came from one. */
  url?: string;
  timeoutMs: number;
  onProgress?: (m: string) => void;
}): Promise<ResearchOutcome> {
  const jsonPath = join(o.appDir, "job", "company.json");
  const existing = loadCompanyResearch(o.appDir);
  if (existing) return outcome(existing);
  if (isConfidential(o.job)) return { research: null, status: "skipped", warning: "research skipped: confidential/agency posting" };
  if (o.adapter === null) {
    return { research: null, status: "skipped", warning: `research skipped: ${o.name} has no web tools (set adapters.${o.name}.research_command)` };
  }
  const logs = createRunWorkspace(o.runsDir, "research", o.runId);
  const root = mkdtempSync(join(tmpdir(), "resumely-research-"));
  const unregister = onInterrupt(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "research");
  o.onProgress?.("researching company…");
  try {
    const { value } = await runAgentStep({
      adapter: o.adapter,
      name: o.name,
      workspace,
      instructions: await Bun.file(join(import.meta.dir, "prompts", "research-company.md")).text(),
      files: {
        "target.json": JSON.stringify(researchTarget(o.job, o.url), null, 2) + "\n",
        "company.schema.json": JSON.stringify(jsonSchemaFor("company"), null, 2) + "\n",
      },
      promptMode: "inline",
      outFile: "company.json",
      validate: validateResearch,
      timeoutMs: o.timeoutMs,
      onProgress: o.onProgress,
    });
    writeFileSync(jsonPath, JSON.stringify(value, null, 2) + "\n");
    writeFileSync(join(o.appDir, "job", "company.md"), renderCompanyMd(value));
    return outcome(value);
  } catch (e) {
    if (e instanceof UserError) return { research: null, status: "failed", warning: `research failed: ${e.message} (logs: ${logs})` };
    throw e;
  } finally {
    unregister();
    copyBack(workspace, logs);
    rmSync(root, { recursive: true, force: true });
  }
}
