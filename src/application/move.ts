import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../errors";
import { layout } from "../paths";
import { isAlive, listRuns, relinkRuns } from "../pipeline/checkpoint";
import { agencyOf, slugify } from "./slug";
import { saveMeta, type Application } from "./store";

/** Change an application's company and/or role: rename its folder (keeping the date prefix), update its records, relink its runs. Refused while a live run uses it. */
export function moveApplication(root: string, app: Application, o: { company?: string; role?: string }): Application {
  const company = o.company?.trim();
  const role = o.role?.trim();
  if (!company && !role) throw new UserError("Nothing to change", "Pass --company and/or --role");
  const c = company || app.meta.company;
  const r = role || app.meta.role;
  const l = layout(root);
  const live = listRuns(l.runs).find((s) => s.app?.dir === app.dir && s.status === "running" && isAlive(s.pid));
  if (live) throw new UserError(`Application ${app.slug} is in use by run ${live.run_id} (pid ${live.pid})`, "Wait for the run to finish (or stop it), then retry");
  const base = `${app.slug.slice(0, 10)}-${slugify(agencyOf(c) ?? c)}-${slugify(r)}`;
  let slug = base;
  if (slug !== app.slug) for (let n = 2; existsSync(join(l.applications, slug)); n++) slug = `${base}-${n}`;
  const dir = join(l.applications, slug);
  if (dir !== app.dir) renameSync(app.dir, dir);
  const moved: Application = { dir, slug, meta: { ...app.meta, company: c, role: r } };
  saveMeta(moved);
  const parsed = join(dir, "job", "parsed.json");
  if (existsSync(parsed)) {
    const job = JSON.parse(readFileSync(parsed, "utf8")) as Record<string, unknown>;
    writeFileSync(parsed, JSON.stringify({ ...job, company: c, role: r }, null, 2) + "\n");
  }
  if (dir !== app.dir) relinkRuns(l.runs, app.dir, { dir, slug });
  return moved;
}
