#!/usr/bin/env bun
// Regenerates templates/<id>/preview.png from the fixture resume. Usage: bun run previews [id...]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentPayload } from "../src/profile/context";
import { loadProfile } from "../src/profile/load";
import { resolveResume } from "../src/pipeline/resolve";
import { ResumeContent } from "../src/pipeline/schemas";
import { compileTex } from "../src/render/compile";
import { builtinTemplatesDir, findTemplate, renderResume, scanTemplates } from "../src/render/render";

if (!Bun.which("pdftoppm")) {
  console.error("error: pdftoppm not found. Install poppler (brew install poppler / apt install poppler-utils).");
  process.exit(1);
}

const fx = join(import.meta.dir, "../tests/fixtures");
const profile = loadProfile(join(fx, "profile-jordan"));
const content = ResumeContent.parse(await Bun.file(join(fx, "resume-content.json")).json());
const resume = resolveResume(content, buildAgentPayload(profile).entries);
const job = { company: "Atlas Freight", role: "Senior Backend Engineer" };

const dirs = [builtinTemplatesDir()];
const ids = process.argv.slice(2);
const targets = ids.length ? ids.map((id) => findTemplate(id, dirs)) : scanTemplates(dirs);
const tmp = mkdtempSync(join(tmpdir(), "resumely-previews-"));
try {
  for (const t of targets) {
    const { pdf } = await compileTex(renderResume(t, { about: profile.about, resume, job }), t.engine);
    const file = join(tmp, `${t.id}.pdf`);
    writeFileSync(file, pdf);
    const p = Bun.spawnSync(["pdftoppm", "-png", "-r", "60", "-f", "1", "-l", "1", "-singlefile", file, join(t.dir, "preview")]);
    if (p.exitCode !== 0) throw new Error(`pdftoppm failed for ${t.id}: ${p.stderr.toString()}`);
    console.log(join(t.dir, "preview.png"));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
