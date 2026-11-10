import { createInterface } from "node:readline/promises";
import type { Application } from "../application/store";
import type { ParsedJob } from "../pipeline/schemas";

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY);

/** Ask one question on stderr; null on EOF. */
async function ask(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr } as unknown as Parameters<typeof createInterface>[0]);
  try {
    return await new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null));
      rl.question(question).then(resolve, () => resolve(null));
    });
  } finally {
    rl.close();
  }
}

/** v / n / a (case-insensitive); anything else re-asks; EOF aborts. */
export async function promptDuplicate(existing: Application): Promise<"existing" | "new" | "abort"> {
  for (;;) {
    const a = await ask(`Already applied (${existing.slug}). [v]ersion in existing / [n]ew application / [a]bort: `);
    if (a === null) return "abort";
    switch (a.trim().toLowerCase()) {
      case "v": return "existing";
      case "n": return "new";
      case "a": return "abort";
    }
  }
}

export function formatReviewSummary(job: ParsedJob, likelyGaps: string[]): string {
  const lines = [`${job.company} — ${job.role}${job.location ? ` (${job.location})` : ""}`, "requirements:", ...job.requirements.map((r) => `  - ${r}`)];
  lines.push("likely gaps:", ...(likelyGaps.length ? likelyGaps.map((g) => `  - ${g}`) : ["  (none)"]));
  return lines.join("\n");
}

/** Print the parsed job and likely gaps, then `Continue? [Y/n]`. */
export async function confirmParsed(job: ParsedJob, likelyGaps: string[]): Promise<boolean> {
  console.error(formatReviewSummary(job, likelyGaps));
  const a = await ask("Continue? [Y/n] ");
  if (a === null) return false;
  return !/^n/i.test(a.trim());
}
