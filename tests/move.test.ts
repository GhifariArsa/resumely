import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync } from "node:fs";
import { createApplication, listApplications } from "../src/application/store";
import { moveApplication } from "../src/application/move";
import { UserError } from "../src/errors";
import { layout } from "../src/paths";
import { RunCheckpoint, type RunOptions } from "../src/pipeline/checkpoint";

const fx = join(import.meta.dir, "fixtures");
const job = { company: "Atlas Freight", role: "Senior Backend Engineer", requirements: [], nice_to_haves: [], keywords: [], language: "en" };
const options: RunOptions = { template: "classic", mode: "truthful", pages: 1, cover: true, research: true, review: true, input: { kind: "file" } };
const now = new Date(2026, 10, 11);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-move-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const apps = () => layout(root).applications;
const make = (j = job) => createApplication(apps(), j, { kind: "file", text: "x" }, now);

test("a new company renames the folder and rewrites the toml and parsed.json", () => {
  const app = make();
  mkdirSync(join(app.dir, "resume/v1"), { recursive: true });
  writeFileSync(join(app.dir, "resume/v1/Jordan_Example_Resume_AtlasFreight.pdf"), "pdf");
  const moved = moveApplication(root, app, { company: "Atlas Freight Inc" });
  expect(moved.slug).toBe("2026-11-11-atlas-freight-inc-senior-backend-engineer");
  expect(moved.dir).toBe(join(apps(), moved.slug));
  expect(existsSync(app.dir)).toBe(false);
  expect(moved.meta).toMatchObject({ company: "Atlas Freight Inc", role: "Senior Backend Engineer" });
  const listed = listApplications(apps());
  expect(listed.map((a) => a.slug)).toEqual([moved.slug]);
  expect(listed[0]!.meta.company).toBe("Atlas Freight Inc");
  expect(JSON.parse(readFileSync(join(moved.dir, "job/parsed.json"), "utf8"))).toMatchObject({ company: "Atlas Freight Inc", role: "Senior Backend Engineer" });
  expect(existsSync(join(moved.dir, "resume/v1/Jordan_Example_Resume_AtlasFreight.pdf"))).toBe(true);
});

test("a new role changes the role part of the slug", () => {
  const moved = moveApplication(root, make(), { role: "Staff Engineer" });
  expect(moved.slug).toBe("2026-11-11-atlas-freight-staff-engineer");
  expect(moved.meta.role).toBe("Staff Engineer");
});

test("an agency company is slugged by the agency", () => {
  const moved = moveApplication(root, make(), { company: "Confidential (via Hays Recruitment)" });
  expect(moved.slug).toBe("2026-11-11-hays-recruitment-senior-backend-engineer");
});

test("runs recorded against the old folder are relinked", () => {
  const app = make();
  const profileDir = join(root, "profile");
  cpSync(join(fx, "profile-jordan"), profileDir, { recursive: true });
  const cp = RunCheckpoint.create(layout(root).runs, "r1", { harness: "fake", options, jobText: "# Job\n", profileDir });
  cp.setApp(app);
  const moved = moveApplication(root, app, { company: "Atlas Freight Inc" });
  const state = JSON.parse(readFileSync(join(layout(root).runs, "r1", "state.json"), "utf8"));
  expect(state.app).toEqual({ dir: moved.dir, slug: moved.slug });
});

test("moving onto an existing slug gets a -2 suffix", () => {
  make({ ...job, company: "Atlas Freight Inc" });
  const moved = moveApplication(root, make(), { company: "Atlas Freight Inc" });
  expect(moved.slug).toBe("2026-11-11-atlas-freight-inc-senior-backend-engineer-2");
});

test("a change that keeps the slug keeps the folder", () => {
  const app = make();
  const moved = moveApplication(root, app, { company: "ATLAS FREIGHT" });
  expect(moved.slug).toBe(app.slug);
  expect(moved.meta.company).toBe("ATLAS FREIGHT");
});

test("no options -> Nothing to change", () => {
  expect(() => moveApplication(root, make(), {})).toThrow(UserError);
  expect(() => moveApplication(root, make(), {})).toThrow("Nothing to change");
});
