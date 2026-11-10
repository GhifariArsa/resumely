import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterConfig } from "../config";
import { UserError } from "../errors";
import { CompanyResearch, jsonSchemaFor } from "./schemas";
import type { ParsedJob } from "./schemas";
import { validateResearch } from "./validate";
import { createRunWorkspace, runAgentStep } from "./workspace";

const CONFIDENTIAL = /confidential|undisclosed|stealth|via .+ (recruit|agency)/i;

export const isConfidential = (job: ParsedJob): boolean => CONFIDENTIAL.test(job.company);

export function renderCompanyMd(r: CompanyResearch): string {
  const facts = r.facts.map((f) => `- ${f.text} [${f.id}](${f.source_url})`).join("\n");
  const sources = r.sources.map((s) => `- ${s}`).join("\n");
  return `# ${r.company}\n\n${r.summary}\n\n## Facts\n\n${facts}\n\n## Sources\n\n${sources}\n`;
}

function loadExisting(path: string): CompanyResearch | null {
  if (!existsSync(path)) return null;
  try {
    const r = validateResearch(JSON.parse(readFileSync(path, "utf8")));
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

export async function runResearch(o: {
  adapter: AdapterConfig | null;
  name: string;
  runsDir: string;
  runId: string;
  appDir: string;
  job: ParsedJob;
  jobText: string;
  timeoutMs: number;
  onProgress?: (m: string) => void;
}): Promise<{ research: CompanyResearch | null; warning?: string }> {
  const jsonPath = join(o.appDir, "job", "company.json");
  const existing = loadExisting(jsonPath);
  if (existing) return { research: existing };
  if (isConfidential(o.job)) return { research: null, warning: "research skipped: confidential/agency posting" };
  if (o.adapter === null) {
    return { research: null, warning: `research skipped: ${o.name} has no web tools (set adapters.${o.name}.research_command)` };
  }
  const workspace = createRunWorkspace(o.runsDir, "research", o.runId);
  o.onProgress?.("researching company…");
  try {
    const { value } = await runAgentStep({
      adapter: o.adapter,
      name: o.name,
      workspace,
      instructions: await Bun.file(join(import.meta.dir, "prompts", "research-company.md")).text(),
      files: {
        "job.md": o.jobText,
        "parsed-job.json": JSON.stringify(o.job, null, 2) + "\n",
        "company.schema.json": JSON.stringify(jsonSchemaFor("company"), null, 2) + "\n",
      },
      outFile: "company.json",
      validate: validateResearch,
      timeoutMs: o.timeoutMs,
      onProgress: o.onProgress,
    });
    writeFileSync(jsonPath, JSON.stringify(value, null, 2) + "\n");
    writeFileSync(join(o.appDir, "job", "company.md"), renderCompanyMd(value));
    return { research: value };
  } catch (e) {
    if (e instanceof UserError) return { research: null, warning: `research failed: ${e.message} (logs: ${workspace})` };
    throw e;
  }
}
