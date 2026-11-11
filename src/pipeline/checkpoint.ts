import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { UserError } from "../errors";
import type { JobSource } from "../job/intake";
import type { DocResult } from "./apply";
import type { ResearchStatus } from "./research";
import { Review } from "./schemas";
import type { StepCache } from "./workspace";

export type RunOptions = {
  template: string;
  mode: "truthful" | "stretch";
  pages: number;
  cover: boolean;
  research: boolean;
  review: boolean;
  role?: string;
  input: { kind: JobSource["kind"]; url?: string; path?: string };
};

const DocResultSchema = z.object({ pdfPath: z.string(), version: z.number(), pages: z.number(), ready: z.boolean(), review: Review.nullable() });

const RunStateSchema = z.object({
  version: z.literal(1),
  run_id: z.string(),
  pid: z.number(),
  status: z.enum(["running", "failed", "done", "aborted"]),
  created: z.string(),
  updated: z.string(),
  harness: z.string(),
  options: z.object({
    template: z.string(),
    mode: z.enum(["truthful", "stretch"]),
    pages: z.number(),
    cover: z.boolean(),
    research: z.boolean(),
    review: z.boolean(),
    role: z.string().optional(),
    input: z.object({ kind: z.enum(["file", "clipboard", "url", "editor"]), url: z.string().optional(), path: z.string().optional() }),
  }),
  app: z.object({ dir: z.string(), slug: z.string() }).nullable(),
  steps: z.record(z.string(), z.object({ harness: z.string(), fallback: z.boolean(), out: z.string(), finished: z.string() })),
  research: z.object({ status: z.enum(["used", "none_found", "skipped", "failed"]), warning: z.string().optional() }).nullable(),
  documents: z.object({ resume: DocResultSchema.optional(), "cover-letter": DocResultSchema.optional() }),
  error: z.object({ message: z.string(), hint: z.string().optional(), kind: z.string().optional() }).nullable(),
});

export type RunState = z.infer<typeof RunStateSchema>;

const STATE = "state.json";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Write `state.json` atomically (tmp file + rename). */
function writeState(dir: string, s: RunState): void {
  const tmp = join(dir, `${STATE}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, join(dir, STATE));
}

/** The run's state, or null when state.json is missing; throws when it is present but unreadable. */
function readState(dir: string): RunState | null {
  const path = join(dir, STATE);
  if (!existsSync(path)) return null;
  const r = RunStateSchema.safeParse((() => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  })());
  if (!r.success) throw new UserError(`Run ${basename(dir)} has an unreadable state.json`, path);
  return r.data;
}

/** The persisted record of one `apply` run: its inputs, finished agent steps and saved documents. */
export class RunCheckpoint implements StepCache {
  private constructor(
    readonly dir: string,
    public state: RunState,
  ) {}

  get jobText(): string {
    return readFileSync(join(this.dir, "inputs", "job.md"), "utf8");
  }

  get profileDir(): string {
    return join(this.dir, "inputs", "profile");
  }

  static create(runsDir: string, runId: string, o: { harness: string; options: RunOptions; jobText: string; profileDir: string }): RunCheckpoint {
    const dir = join(runsDir, runId);
    mkdirSync(join(dir, "inputs"), { recursive: true });
    writeFileSync(join(dir, "inputs", "job.md"), o.jobText);
    cpSync(o.profileDir, join(dir, "inputs", "profile"), { recursive: true, filter: (src) => basename(src) !== ".inbox" });
    const now = new Date().toISOString();
    const cp = new RunCheckpoint(dir, {
      version: 1, run_id: runId, pid: process.pid, status: "running", created: now, updated: now, harness: o.harness, options: o.options,
      app: null, steps: {}, research: null, documents: {}, error: null,
    });
    cp.save();
    return cp;
  }

  static load(runsDir: string, runId: string): RunCheckpoint {
    const dir = join(runsDir, runId);
    const state = readState(dir);
    if (!state) throw new UserError(`No run "${runId}"`, `Runs are in ${runsDir}`);
    return new RunCheckpoint(dir, state);
  }

  private save(): void {
    this.state.updated = new Date().toISOString();
    writeState(this.dir, this.state);
  }

  get(step: string): { harness: string } | null {
    const s = this.state.steps[step];
    return s ? { harness: s.harness } : null;
  }

  done(step: string, rec: { harness: string; outFile: string; fallback: boolean }): void {
    this.state.steps[step] = { harness: rec.harness, fallback: rec.fallback, out: join(step, "out", rec.outFile), finished: new Date().toISOString() };
    this.save();
  }

  /** Mark the run as running in this process (a new run, or a resumed one). */
  start(): void {
    Object.assign(this.state, { status: "running", pid: process.pid, error: null });
    this.save();
  }

  setHarness(name: string): void {
    this.state.harness = name;
    this.save();
  }

  setApp(app: { dir: string; slug: string }): void {
    this.state.app = { dir: app.dir, slug: app.slug };
    this.save();
  }

  setResearch(r: { status: ResearchStatus; warning?: string }): void {
    this.state.research = r.warning ? { status: r.status, warning: r.warning } : { status: r.status };
    this.save();
  }

  setDocument(kind: "resume" | "cover-letter", d: DocResult): void {
    this.state.documents[kind] = d;
    this.save();
  }

  finish(): void {
    Object.assign(this.state, { status: "done", error: null });
    this.save();
  }

  fail(e: unknown): void {
    const error: NonNullable<RunState["error"]> = { message: e instanceof Error ? e.message : String(e) };
    if (e instanceof UserError && e.hint) error.hint = e.hint;
    const kind = (e as { kind?: unknown }).kind;
    if (typeof kind === "string") error.kind = kind;
    Object.assign(this.state, { status: "failed", error });
    this.save();
  }

  abort(): void {
    this.state.status = "aborted";
    this.save();
  }
}

/** Every run with a valid state.json, most recently updated first. */
export function listRuns(runsDir: string): RunState[] {
  if (!existsSync(runsDir)) return [];
  const out: RunState[] = [];
  for (const e of readdirSync(runsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      const s = readState(join(runsDir, e.name));
      if (s) out.push(s);
    } catch {
      /* unreadable state: not listed */
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated) || b.run_id.localeCompare(a.run_id));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const stale = (s: RunState) => s.status === "running" && !isAlive(s.pid);

/** The run `resumely resume` continues: `runId`, or the newest failed (or abandoned running) run. */
export function pickResumable(runsDir: string, runId?: string): RunCheckpoint {
  if (runId === undefined) {
    const s = listRuns(runsDir).find((r) => r.status === "failed" || stale(r));
    if (!s) throw new UserError("No failed run to resume", "Start a new one with: resumely apply");
    return RunCheckpoint.load(runsDir, s.run_id);
  }
  if (!SAFE_ID.test(runId)) throw new UserError(`No run "${runId}"`, `Runs are in ${runsDir}`);
  const cp = RunCheckpoint.load(runsDir, runId);
  const s = cp.state;
  if (s.status === "done") throw new UserError(`Run ${runId} already finished`, s.app ? `Its documents are in ${s.app.dir}` : undefined);
  if (s.status === "running" && isAlive(s.pid)) throw new UserError(`Run ${runId} is still running (pid ${s.pid})`);
  return cp;
}

/** Point runs recorded against application `fromDir` at its new location. Returns how many runs changed. */
export function relinkRuns(runsDir: string, fromDir: string, to: { dir: string; slug: string }): number {
  let n = 0;
  for (const s of listRuns(runsDir)) {
    if (s.app?.dir !== fromDir) continue;
    writeState(join(runsDir, s.run_id), { ...s, app: { dir: to.dir, slug: to.slug } });
    n++;
  }
  return n;
}
