import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { UserError } from "../errors";
import { pdfIn, pickVersion, readJsonOr, savedNotReadyReasons } from "../pipeline/version";
import { latestVersion, saveMeta, type Application, type ApplicationMeta } from "./store";

const KINDS = [
  { kind: "resume", key: "resume", label: "resume" },
  { kind: "cover-letter", key: "cover_letter", label: "cover letter" },
] as const;

/** Set the status. `applied` records which versions were sent and refuses not-ready ones unless `force`. */
export function setStatus(app: Application, status: ApplicationMeta["status"], o: { force?: boolean; now?: Date } = {}): Application {
  if (status === "applied") {
    const sent: NonNullable<ApplicationMeta["sent"]> = {};
    for (const { kind, key, label } of KINDS) {
      const v = latestVersion(app, kind);
      if (!v) continue;
      if (readJsonOr<{ ready?: boolean }>(join(v.dir, "meta.json"), {}).ready === false && !o.force) {
        throw new UserError(`${label} v${v.version} is not ready: ${savedNotReadyReasons(v.dir)}`, "Fix and re-run, or pass --force");
      }
      sent[key] = v.version;
    }
    app.meta.sent = sent;
    app.meta.applied_at = (o.now ?? new Date()).toISOString();
  }
  app.meta.status = status;
  saveMeta(app);
  return app;
}

/** Copy the resume and cover-letter PDFs into `to` without overwriting; returns the new paths. */
export function exportApplication(app: Application, o: { to: string; version?: number }): string[] {
  const files = [pdfIn(pickVersion(app, "resume", o.version).dir)];
  if (latestVersion(app, "cover-letter")) files.push(pdfIn(pickVersion(app, "cover-letter").dir));
  const dests = files.map((f) => join(o.to, basename(f)));
  for (const d of dests) if (existsSync(d)) throw new UserError(`${d} already exists`, "Move it or pick another --to directory");
  mkdirSync(o.to, { recursive: true });
  files.forEach((f, i) => copyFileSync(f, dests[i]!));
  return dests;
}
