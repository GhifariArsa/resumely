import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HardFacts } from "../checks/facts";
import type { AdapterConfig } from "../config";
import { UserError } from "../errors";
import { reviewSchemaFor, type Review } from "./schemas";
import { validateReview } from "./validate";
import { createRunWorkspace, runAgentStep } from "./workspace";

export type DocumentKind = "resume" | "cover-letter";

/** A rendered + compiled document and its measurements. `text` is the extracted PDF text, or a plain-text rendering of the content when extraction is unavailable. */
export type Produced = { tex: string; pdf: Uint8Array; pages: number; fill: number | null; facts: HardFacts; text: string };

export type Revision<T> = { previous: T; review: Review; facts: HardFacts };

export type RefineOptions<T> = {
  kind: DocumentKind;
  runsDir: string;
  runId: string;
  adapter: AdapterConfig;
  name: string;
  timeoutMs: number;
  maxRounds: number;
  /** Runs the writer agent in `ws` (wraps runAgentStep with the kind's prompt, files and validator). On revisions, use writeRevisionFiles + revisionInstructions. */
  write: (ws: string, revision?: Revision<T>) => Promise<{ value: T; warnings: string[] }>;
  produce: (value: T) => Promise<Produced>;
  reviewFiles: { "job.md": string };
  onProgress?: (msg: string) => void;
};

export type RefineResult<T> = {
  value: T;
  produced: Produced;
  /** The most recent successful review; null when none ran or the first one failed. */
  review: Review | null;
  /** True when `review` judged the returned `value` (false when the loop ended on a revision or a failed review). */
  reviewedFinal: boolean;
  rounds: number;
  warnings: string[];
};

const PROMPTS = join(import.meta.dir, "prompts");
const prompt = (file: string) => Bun.file(join(PROMPTS, file)).text();
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** "<message> (<hint>)", dropping the parts of the hint that only repeat the workspace path (added separately). */
function describe(e: UserError, ws?: string): string {
  let hint = e.hint ?? "";
  if (ws) hint = hint.replace(`(logs: ${ws})`, "").replace(`Inspect ${ws}`, "");
  hint = hint.trim();
  return hint ? `${e.message} (${hint})` : e.message;
}

/** Writer instructions appended on a revision. */
export function revisionInstructions(): Promise<string> {
  return prompt("revision.md");
}

/** The inputs a revising writer reads: its previous output, the review and the hard facts. */
export function writeRevisionFiles<T>(ws: string, revision: Revision<T>): void {
  writeFileSync(join(ws, "previous.json"), json(revision.previous));
  writeFileSync(join(ws, "review.json"), json(revision.review));
  writeFileSync(join(ws, "hard-facts.json"), json(revision.facts));
}

/**
 * write → produce, then up to `maxRounds` × (review → revise → produce). A round revises on `revise` or on
 * overflow. The reviewer never sees the profile. A failed review, a rejected/uncompilable revision or a revision
 * identical to the previous value ends the loop with a warning and keeps the last good version; failures of the
 * initial write or produce propagate.
 */
export async function refine<T>(o: RefineOptions<T>): Promise<RefineResult<T>> {
  const prefix = o.kind === "resume" ? "resume" : "cover";
  const label = o.kind === "resume" ? "resume" : "cover letter";
  const ws = (step: string) => createRunWorkspace(o.runsDir, `${prefix}-${step}`, o.runId);
  const warnings: string[] = [];

  const first = await o.write(ws("write"));
  warnings.push(...first.warnings);
  let value = first.value;
  let produced = await o.produce(value);
  let review: Review | null = null;
  let reviewedFinal = false;
  let rounds = 0;

  const reviewPrompt = o.maxRounds > 0 ? await prompt(o.kind === "resume" ? "review-resume.md" : "review-cover-letter.md") : "";
  const reviewSchema = json(reviewSchemaFor(o.kind));

  for (let r = 1; r <= o.maxRounds; r++) {
    rounds = r;
    const rws = ws(`review-${r}`);
    o.onProgress?.(`reviewing ${label} (round ${r})…`);
    writeFileSync(join(rws, "document.pdf"), produced.pdf);
    try {
      ({ value: review } = await runAgentStep({
        adapter: o.adapter,
        name: o.name,
        workspace: rws,
        instructions: reviewPrompt,
        files: {
          "document.txt": produced.text,
          "job.md": o.reviewFiles["job.md"],
          "hard-facts.json": json(produced.facts),
          "review.schema.json": reviewSchema,
        },
        outFile: "review.json",
        validate: (raw) => validateReview(raw, o.kind),
        timeoutMs: o.timeoutMs,
        onProgress: o.onProgress,
      }));
      reviewedFinal = true;
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      reviewedFinal = false;
      warnings.push(`review failed: ${describe(e, rws)} (logs: ${rws})`);
      break;
    }
    if (review.verdict === "pass" && !produced.facts.overflow) break;

    const vws = ws(`revise-${r}`);
    o.onProgress?.(`revising ${label} (round ${r})…`);
    let next: { value: T; warnings: string[] };
    try {
      next = await o.write(vws, { previous: value, review, facts: produced.facts });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      warnings.push(`revision rejected: ${describe(e, vws)} (logs: ${vws})`);
      break;
    }
    // Nothing changed: another review would judge the same document again.
    if (Bun.deepEquals(next.value, value)) {
      warnings.push("revision made no changes");
      break;
    }
    let nextProduced: Produced;
    try {
      nextProduced = await o.produce(next.value);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      warnings.push(`revision failed to compile: ${describe(e)}`);
      break;
    }
    value = next.value;
    produced = nextProduced;
    warnings.push(...next.warnings);
    reviewedFinal = false;
  }
  return { value, produced, review, reviewedFinal, rounds, warnings };
}
