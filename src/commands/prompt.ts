import type { Application } from "../application/store";
import type { ParsedJob } from "../pipeline/schemas";

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY);

type Chunks = { [Symbol.asyncIterator](): { next(): Promise<IteratorResult<string | Uint8Array>>; return?(value?: unknown): unknown } };
export type PromptIO = { input?: Chunks; output?: { write(s: string): unknown } };

/** Asks questions on `output` and reads answers line by line from `input`; `ask` gives null at EOF. */
async function* stdinChunks(): AsyncGenerator<string | Uint8Array> {
  const reader = Bun.stdin.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value as Uint8Array;
    }
  } finally {
    reader.releaseLock();
  }
}

export function lineReader({ input = stdinChunks(), output = process.stderr }: PromptIO) {
  const chunks = input[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buf = "";
  let eof = false;
  const ask = async (question: string): Promise<string | null> => {
    output.write(question);
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        return line;
      }
      if (eof) {
        const rest = buf;
        buf = "";
        return rest || null;
      }
      const c = await chunks.next();
      if (c.done) eof = true;
      else buf += typeof c.value === "string" ? c.value : decoder.decode(c.value, { stream: true });
    }
  };
  return { ask, close: () => void chunks.return?.() };
}

/** v / n / a (case-insensitive); anything else re-asks; EOF aborts. */
export async function promptDuplicate(existing: Application, io: PromptIO = {}): Promise<"existing" | "new" | "abort"> {
  const r = lineReader(io);
  try {
    for (;;) {
      const a = await r.ask(`Already applied (${existing.slug}). [v]ersion in existing / [n]ew application / [a]bort: `);
      switch (a?.trim().toLowerCase()) {
        case "v": return "existing";
        case "n": return "new";
        case "a":
        case undefined: return "abort";
      }
    }
  } finally {
    r.close();
  }
}

export function formatReviewSummary(job: ParsedJob, likelyGaps: string[]): string {
  const lines = [`${job.company} — ${job.role}${job.location ? ` (${job.location})` : ""}`, "requirements:", ...job.requirements.map((r) => `  - ${r}`)];
  lines.push("likely gaps:", ...(likelyGaps.length ? likelyGaps.map((g) => `  - ${g}`) : ["  (none)"]));
  return lines.join("\n");
}

/** Print the parsed job and likely gaps, then `Continue? [Y/n]` (EOF stops). */
export async function confirmParsed(job: ParsedJob, likelyGaps: string[], io: PromptIO = {}): Promise<boolean> {
  (io.output ?? process.stderr).write(formatReviewSummary(job, likelyGaps) + "\n");
  const r = lineReader(io);
  try {
    const a = await r.ask("Continue? [Y/n] ");
    return a !== null && !/^n/i.test(a.trim());
  } finally {
    r.close();
  }
}
