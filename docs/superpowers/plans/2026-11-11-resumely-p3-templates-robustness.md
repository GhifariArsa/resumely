# resumely P3 — Templates & Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three more templates (`modern`, `traditional`, `minimal`), each with a resume and a matching cover letter. `resumely templates list|new`, `resumely doctor`, checkpointed runs with `resumely resume`, opt-in harness fallback and the `invalid_output` error class. Also the leftovers from §7/§12: `$EDITOR` intake, `--role`, `mv` and agency folders. A locked-down research agent, two fixes to the fabrication scanner, and an opt-in `bun run eval`.

**Architecture:** This builds on the P1/P2 core: the agent writes JSON only, and `runAgentStep` drives every agent call through the file workspace contract.
- **Templates.** Each template is a directory with `template.toml`. A single parameterised test (`tests/templates.test.ts`) renders and compiles every built-in template, so each template task only adds a directory.
- **Checkpoints.** Each agent step's validated output is already on disk in `.runs/<run>/<step>/out/`. P3 records each completed step in `.runs/<run>/state.json` and makes `runAgentStep` reuse a recorded step instead of calling the harness. Resuming replays the pipeline from the start: agent steps already done are cache hits, and render/compile run again deterministically.
- **Fallback.** Harness fallback lives inside `runAgentStep`.
- **Doctor.** `doctor` is a pure function over an injected process probe.

**Tech Stack:** As in P2. At runtime: LuaLaTeX and XeLaTeX (both in TeX Live), `kpsewhich` for doctor, and `pdftoppm`/`pdfinfo` (poppler) for previews and metadata tests. `pdfinfo` is optional in tests.

**Spec:** `design.md`. Read §4, §5, §7, §9, §10, §11 and §12 before starting any task. The P1 plan (`docs/superpowers/plans/2026-11-10-resumely-p1-vertical-slice.md`) and the P2 plan (`docs/superpowers/plans/2026-11-10-resumely-p2-generation-core.md`) explain the existing modules.

**Out of scope (other plans):**
- P4: profile import, inbox, interview, `profile lint`, `trace`.
- P5: `resumely ui`. P5 consumes `TemplateInfo` / `listTemplates(root)` from Task 1. Their shape is fixed below.

## Global Constraints

- The agent writes structured JSON only, never LaTeX. Templates render content deterministically.
- Harness commands are argv arrays and never pass through a shell. This includes `$EDITOR`, which is split into argv and never run through `sh -c`.
- The data root is `RESUMELY_HOME` if set, else `~/resumely/`. User templates live in `<root>/templates/`. Runs live in `<root>/.runs/<run-id>/`.
- All tests are LLM-free and use `tests/fixtures/fake-harness.ts`. `bun test` and `bunx tsc --noEmit` stay green after every task. LaTeX-dependent tests use `test.skipIf(!Bun.which("latexmk"))`. pdftotext/pdfinfo-dependent assertions are gated the same way.
- Templates are single-column. They use the Nunjucks delimiters `((* … *))` for logic and `((( … )))` for output. All output is LaTeX-escaped; `raw.*` is used only for URLs, through the `latexUrl` filter.
- Every template sets machine-readable text:
  - pdfLaTeX: `\input{glyphtounicode}` + `\pdfgentounicode=1`
  - LuaLaTeX: `\pdfvariable gentounicode=1` + fontspec OpenType fonts
  - XeLaTeX: fontspec OpenType fonts
- Every template sets `\hypersetup` metadata:
  - `pdfauthor={<name>}`
  - `pdftitle={<name> — Resume}` or `pdftitle={<name> — Cover Letter}`
  - `pdfsubject={<role> at <company>}` when job data is present
- Every template prints `\par\message{RESUMELY-FILL \the\pagetotal\space\the\textheight}` immediately before `\end{document}`.
- Engines: `classic` and `minimal` are pdfLaTeX, `traditional` is XeLaTeX, `modern` is LuaLaTeX.
- `fontawesome6` is **not installed** and must not be required. `fontawesome5` is allowed.
- Fonts are loaded from TeX Live **by file name** (fontspec `Extension=.otf`), never by system font name, so templates work on Linux.
- Every template's `LICENSE` preserves the original design's licence notice and credits it:
  - Awesome-CV: LPPL 1.3c
  - McDowell CV: MIT
  - moderncv: LPPL 1.3c
- §12: every pipeline step writes its outputs and `state.json` to `.runs/<run-id>/` before advancing. `resumely resume [run-id] [--harness X]` continues from the last completed step; by default it picks the most recent failed run.
- §12: the adapter error classes are `auth | rate_limit | timeout | invalid_output | unknown`, plus P1's `not_installed`, each with a specific hint.
- §12: `fallback_harnesses = [...]` is opt-in and off by default. The per-call timeout stays at a default of 10 min.
- §12 **Profile edited mid-run:** "the run reads a snapshot at start". **Agency/confidential client:** "company = "Confidential (via <agency>)", folder from agency + role, research skipped". **Multi-role posting:** "parse the most prominent role, record the rest; `--role` overrides."
- §2 privacy: the research step sends only company and role to search, and never the profile. In P3 the claude research agent gets only `WebSearch`, `WebFetch` and `Write`.
- The fabrication scanner's R9 rule stands: names of 3 characters or fewer stay case-sensitive, and no new exemption list entry is 3 characters or fewer.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An interrupted run** (Ctrl-C, crash or kill) leaves `state.json` at `running` and possibly a half-written `out/*.json`. `resumely resume` with no id must pick that run up (its pid is dead) and re-run only the step whose output is invalid, never a completed one. Test in Task 8.
2. **The profile is edited, or the application is renamed with `mv`, between a failure and `resume`.**
   - Resume uses the run's profile snapshot, so citations to a removed entry still validate.
   - `mv` relinks the run.
   - A deleted application folder gives a one-line error.

   Tests in Task 8 and Task 9.
3. **A sparse profile or sparse content in every template.** This means no phone, no location, no links, no summary and no skills, an item with no bullets, and non-ASCII plus LaTeX-hostile text. Every template must still compile to 1 page and pass the ATS check. Test in Task 1 (the parameterised test covers Tasks 2–4).
4. **A broken user template in `<root>/templates/`** (bad TOML, unknown engine).
   - `templates list` still lists the others.
   - `doctor` flags it.
   - `apply --template classic` still works: P2's `findTemplate` threw on *any* invalid template.

   Tests in Task 1 and Task 7.
5. **An unusual `$EDITOR`.** It may have arguments (`code --wait`), exit non-zero, be saved empty, or be missing. The right argv must be built, nothing is created, and the user gets a clean message. Test in Task 9.

---

## File Structure

```
src/render/render.ts             # scanTemplates (was listTemplates), TemplateMeta.fonts, tolerant findTemplate
src/render/templates.ts          # NEW: TemplateInfo, listTemplates(root), templateDirs, newTemplate, formatTemplateList
src/render/compile.ts            # engine-dependent default timeout (Task 2)
scripts/previews.ts              # NEW: bun run previews [id...] → templates/<id>/preview.png
scripts/eval.ts  scripts/eval-lib.ts   # NEW: bun run eval
templates/{modern,traditional,minimal}/{template.toml,preamble.tex.njk,header.tex.njk,resume.tex.njk,cover-letter.tex.njk,LICENSE,preview.png}
templates/classic/preview.png
src/checks/fabrication.ts        # opener lists, -ly rule
src/harness/adapter.ts           # invalid_output, auth_check presets, locked research preset, resolveFallbacks
src/config.ts                    # fallback_harnesses, adapters[].auth_check
src/signals.ts                   # NEW: onInterrupt cleanup registry (SIGINT/SIGTERM)
src/proc.ts                      # kill child process group on interrupt
src/pipeline/workspace.ts        # fallbacks, inline prompt mode, StepCache, returns harness
src/pipeline/research.ts         # inline prompt, temp-dir cleanup on signal, loadCompanyResearch
src/pipeline/checkpoint.ts       # NEW: RunState, RunCheckpoint, pickResumable, relinkRuns
src/pipeline/refine.ts           # checkpoint/fallbacks passthrough; availability errors propagate
src/pipeline/documents.ts        # DocContext.checkpoint/fallbacks
src/pipeline/apply.ts            # applyJob → runPipeline; resumeRun; --role
src/pipeline/schemas.ts          # ParsedJob.other_roles
src/pipeline/prompts/{research-company,parse-job}.md
src/commands/doctor.ts           # NEW
src/job/intake.ts                # readFromEditor, kind "editor"
src/application/slug.ts          # agencyOf
src/application/store.ts         # agency-aware slug
src/application/move.ts          # NEW: moveApplication
src/cli.ts                       # templates, doctor, resume, mv, apply --role / $EDITOR
tests/fixtures/fake-harness.ts   # --as, --prompt, $sleep, FAKE_HARNESS_FAIL_AS, pid/tag/prompt in LS
tests/fixtures/{fake-editor.ts,research-driver.ts}
tests/fixtures/jobs/{frontend,data,pm,mismatched}.md  tests/fixtures/jobs/mismatched.expect.json
```

## Task order and parallelism

| Wave | Tasks | Notes |
|---|---|---|
| 1 | **1**, **5**, **6** | Disjoint files; parallel-safe. |
| 2 | **2**, **3**, **4** (after 1); **7** (after 1 + 6); **8** (after 6) | 2/3/4 touch only `templates/<id>/` (Task 2 also `compile.ts`): parallel-safe with each other and with 7/8. 7 and 8 both add a command block to `src/cli.ts`: keep both blocks when merging. |
| 3 | **9** (after 8), **10** (after 7 + 8) | Disjoint files except `src/cli.ts` (9 only) — parallel-safe. |
| 4 | **11** | Verification + docs; last. |

---

### Task 1: Template registry, `templates list|new`, previews, parameterised template test

**Files:**
- Create:
  - `src/render/templates.ts`
  - `scripts/previews.ts`
  - `tests/templates.test.ts`
  - `templates/classic/preview.png`
- Modify:
  - `src/render/render.ts`
  - `src/cli.ts` (add a `templates` command block)
  - `package.json` (`"previews": "bun scripts/previews.ts"`)
  - `tsconfig.json` (`include` adds `"scripts"`)
  - `tests/render.test.ts` (rename the import)

**Interfaces:**
- Produces, in `render.ts`:
  - `scanTemplates(dirs: string[], problems?: string[]): TemplateMeta[]` replaces P2's `listTemplates(dirs)`. Later dirs override earlier ones with the same id, and the result is sorted by id. When `problems` is passed, an invalid `template.toml` is skipped and `"<template dir>: <message>"` is pushed; without it, it throws as before.
  - `TemplateMeta` adds `fonts: string[]` (from toml `fonts`, default `[]`).
  - In `packages`, a bare name means `<name>.sty`. An entry containing `.` is a file name used as-is, e.g. `"moderncv.cls"`.
  - `findTemplate(id, dirs)` now scans with a `problems` array. It throws only when `id` isn't found; the hint lists the available ids, plus `"; invalid templates: <problems joined by "; ">"` when there are any.
- Produces, in `templates.ts` (contract for P5 — do not change these shapes):
  - `export interface TemplateInfo { id: string; name: string; description: string; engine: string; supports: ("resume" | "cover-letter")[]; source: "builtin" | "user"; dir: string; preview: string | null }`
  - `export function templateDirs(root: string): string[]` returns `[builtinTemplatesDir(), layout(root).templates]`.
  - `export function listTemplates(root: string): TemplateInfo[]`
    - The effective templates, with a user template overriding a built-in that has the same id (its `source` is `"user"`).
    - Invalid templates are skipped. It never throws and doesn't require the data root to exist.
    - `preview` is the absolute path of `<dir>/preview.png` if that file exists, else `null`.
  - `export function templateProblems(root: string): string[]`
  - `export function newTemplate(root: string, id: string, from: string): TemplateInfo`
    - Requires the data root.
    - `id` must match `/^[a-z0-9][a-z0-9-]*$/`, else `UserError("Invalid template id \"<id>\"", "Use lowercase letters, digits and dashes")`.
    - An id that already exists, built-in or user, gives `UserError("Template \"<id>\" already exists", "Pick another id")`.
    - An unknown `from` gives the `findTemplate` error.
    - It copies the base directory except `preview.png` (which would be stale) into `<root>/templates/<id>/`. It rewrites `template.toml` (smol-toml parse + stringify) with `id = <id>` and `name = "<base name> (custom)"`, and keeps `LICENSE`.
  - `export function formatTemplateList(ts: TemplateInfo[]): string`
    - A padded table with columns `ID  NAME  ENGINE  SUPPORTS  SOURCE`; `SUPPORTS` is joined with `,`.
    - Then a blank line, then for each template `<id>: <description>` and, if there is a preview, `  preview: <path>`.
- CLI:
  - `resumely templates list` prints `formatTemplateList(listTemplates(root))` and works without an initialised root.
  - `resumely templates new <id> --from <base>` (`--from` required) prints `created <dir>` and then `hint: edit <dir>/resume.tex.njk, then: resumely render <app> --template <id>`.
- `scripts/previews.ts`: `bun run previews [id...]`, defaulting to all built-ins. It:
  1. renders the fixture resume, using the Jordan profile, `tests/fixtures/resume-content.json` and `job = { company: "Atlas Freight", role: "Senior Backend Engineer" }`
  2. compiles it with `compileTex`
  3. writes the PDF to a temp dir
  4. runs `pdftoppm -png -r 60 -f 1 -l 1 -singlefile <pdf> <template dir>/preview`
  5. prints each written path

  It exits 1 with an install hint if `pdftoppm` is missing.

- [ ] **Step 1: Write failing tests** in `tests/templates.test.ts`. Registry tests need no LaTeX.
  - `listTemplates(<fresh tmp dir>)` contains `classic` with `source: "builtin"`, `engine: "pdflatex"`, `supports` equal to `["resume","cover-letter"]`, and a `preview` ending in `templates/classic/preview.png`.
  - Every built-in has `LICENSE`, `preview.png` and non-empty `packages`, and supports both kinds.
  - A user template whose toml says `id = "classic"` is listed once with `source: "user"`.
  - A user dir `broken/` with `template.toml` = `id = 3` is excluded. `templateProblems` returns 1 entry containing `broken`. `findTemplate("classic", templateDirs(root))` still returns classic. `findTemplate("nope", …)` throws a hint containing `invalid templates:`. (Review Focus 4)
  - `newTemplate(root, "mine", "classic")`:
    - lists `mine` as `user`, its toml `id` is `mine`, `LICENSE` exists and there's no `preview.png`
    - `newTemplate(root, "mine", "classic")` again → "already exists"
    - `newTemplate(root, "classic", "classic")` → "already exists"
    - `newTemplate(root, "Bad Id", "classic")` → "Invalid template id"
    - `newTemplate(root, "x", "nope")` → "Unknown template"
  - The CLI (`bun src/cli.ts`, `RESUMELY_HOME` = initialised tmp root):
    - `templates list` exits 0, and stdout contains `classic` and `preview:`
    - `templates new mine --from classic` exits 0 and creates `<root>/templates/mine/template.toml`
  - **Parameterised per built-in template** (`for (const t of listTemplates(tmp).filter(t => t.source === "builtin"))`), latexmk-gated, timeout 300 000 ms each. Use `produceResume` / `produceCover` from `src/pipeline/documents.ts` with:
    - the Jordan profile and `resume-content.json` / `cover-letter.json`
    - `job` Atlas Freight / Senior Backend Engineer
    - `targetPages: 1`, `keywords: []`
    - `date: "November 11, 2026"`
    - `profileText: ""`

    Assertions:
    - resume: `pages === 1`, `fill !== null && fill > 0.4`. With pdftotext, `facts.ats` is `{ status: "ok", problems: [] }`.
    - cover: `pages === 1`, ATS is ok, and the tex contains `Re: ` and `Atlas Freight`.
    - The tex contains the engine marker: pdflatex → `\pdfgentounicode=1`; lualatex → `\pdfvariable gentounicode`; xelatex → `fontspec`.
    - pdfinfo-gated: `pdfinfo` output has `Title: Jordan Example — Resume` (cover: `— Cover Letter`), `Author: Jordan Example` and `Subject: Senior Backend Engineer at Atlas Freight`.
    - **Sparse/hostile variant** (Review Focus 3). The about block is `{ name: "Zoë José Núñez", email: "z@example.com", links: [], body: "" }`, with no phone or location. The content is the fixture minus `summary`, with `skills: []` and the first item's bullets `[]`. One remaining bullet reads `"Łódź R&D snake_case ~ ^ \\ {} 100% $5M C# → ≈ ✓ € “q” —"`.
      - It compiles to ≥ 1 page.
      - With pdftotext, the text contains `Zoë José Núñez` and `Łódź R&D`, and `atsCheck(text, resumeAtsExpect(about, content))` is ok.
- [ ] **Step 2: Run** `bun test tests/templates.test.ts tests/render.test.ts`. Expected: FAIL (`templates.ts` is missing).
- [ ] **Step 3: Implement** the `render.ts` changes, `templates.ts` and the CLI block. Update `tests/render.test.ts` to import `scanTemplates` instead of `listTemplates` from render.
- [ ] **Step 4: Implement `scripts/previews.ts`**, then run `bun run previews classic` and check that `templates/classic/preview.png` exists and is a PNG.
- [ ] **Step 5: Run** `bun test` and `bunx tsc --noEmit`. Expected: PASS. The parameterised test currently covers only `classic`.
- [ ] **Step 6: Commit** `feat: template registry, templates list/new, previews, per-template compile test`

---

### Task 2: `modern` template (Awesome-CV style, LuaLaTeX)

Parallel-safe with Tasks 3, 4, 7 and 8.

**Files:**
- Create: `templates/modern/{template.toml,preamble.tex.njk,header.tex.njk,resume.tex.njk,cover-letter.tex.njk,LICENSE,preview.png}`
- Modify: `src/render/compile.ts`
- Test: `tests/templates.test.ts` (no edits: it picks the template up automatically), `tests/compile.test.ts`

**Interfaces:**
- Consumes the render data from `renderResume` / `renderCoverLetter` (see `templates/classic/*.njk` for usage).
  - Resume data:
    - `about {name,email,phone?,location?,headline?,links[{label,url}]}`
    - `resume {summary?{text}, sections[{kind,title,items[{heading,subheading?,location?,dates?,bullets[{text}]}]}], skills[{category,items[]}]}`
    - `job? {company,role}`
    - `raw` (unescaped copy, for URLs only)
  - Cover data: `about`, `letter {greeting, paragraphs[{text}], closing}`, `job`, `date`.
  - Section titles print as given. The skills heading must be exactly `Technical Skills` (`SKILLS_HEADING` in `documents.ts`; the ATS check expects it).
  - Never use letter-spacing (fontspec `LetterSpace`, `\textls`) on the name or headings: pdftotext then splits the letters and the ATS heading check fails.
- Produces:
  - `template.toml`:
    - `id = "modern"`, `name = "Modern"`
    - `description` (mentions Awesome-CV)
    - `engine = "lualatex"`
    - `supports = ["resume","cover-letter"]`
    - `packages` = every `\usepackage` in the preamble
    - `fonts` = the `.otf` files loaded
  - `compileTex` default timeout by engine: `{ pdflatex: 120_000, xelatex: 120_000, lualatex: 300_000 }`. A cold luaotfload font cache can take minutes on the first LuaLaTeX run. An explicit `opts.timeoutMs` still wins.
- Design (re-implemented from posquit0/Awesome-CV, not copied):
  - Source Sans Pro by file name (`SourceSansPro-Regular.otf`, `-Bold`, `-It`, `-BoldIt`, `-Light`; check each with `kpsewhich`).
  - Accent `#DC3522`.
  - Header:
    - the first name light and the remaining name bold, large and centred
    - `headline` (if present) in small accent caps
    - one contact line with fontawesome5 icons (`\faPhone*`, `\faEnvelope`, `\faMapMarker*`, and `\faGithub` / `\faLinkedin` chosen by link label, else `\faLink`), separated by ` | `
  - Section headings in accent colour followed by a rule to the line end.
  - Entries: bold heading left, location right (accent, italic); subheading in small caps left, dates right; bullets in small dark grey.
  - Cover letter: same header; recipient block `Hiring Team` / company; date right-aligned; `Re: <role>` bold in accent; then greeting, paragraphs, closing and name.
  - Load `amssymb`: escaped content emits `\checkmark{}`.
- `LICENSE`:
  - a statement that this is a re-implementation of the Awesome-CV design by Byungjin Park (posquit0), https://github.com/posquit0/Awesome-CV
  - the upstream copyright line, copied from the upstream repo
  - the LPPL 1.3c notice with the licence URL https://www.latex-project.org/lppl/lppl-1-3c/

- [ ] **Step 1: Write the failing test** in `tests/compile.test.ts`: `compileTex` with no `timeoutMs` passes 300 000 to `spawnWithTimeout` for `lualatex`. Inject this by asserting on an exported `DEFAULT_TIMEOUT_MS` record: `{ pdflatex: 120000, xelatex: 120000, lualatex: 300000 }`.
- [ ] **Step 2: Run** `luaotfload-tool -u` once (warms the font cache), then `bun test tests/compile.test.ts tests/templates.test.ts`. Expected: FAIL (no `DEFAULT_TIMEOUT_MS`; `modern` doesn't exist yet so the parameterised test has nothing new).
- [ ] **Step 3: Implement** the timeout map and the template directory.
- [ ] **Step 4: Run** `bun test tests/templates.test.ts tests/compile.test.ts`. Expected: PASS for `modern` (both kinds, the sparse variant, ATS and metadata). If ATS fails on the contact line, separate icons from text with a space or drop the failing icon. The test decides.
- [ ] **Step 5: Run** `bun run previews modern`, open `templates/modern/preview.png` and check that it reads as Awesome-CV-like and fits 1 page. Then run `bun test` and `bunx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat: modern template (Awesome-CV style, LuaLaTeX)`

---

### Task 3: `traditional` template (McDowell CV style, XeLaTeX)

Parallel-safe with Tasks 2, 4, 7 and 8.

**Files:**
- Create: `templates/traditional/{template.toml,preamble.tex.njk,header.tex.njk,resume.tex.njk,cover-letter.tex.njk,LICENSE,preview.png}`
- Test: `tests/templates.test.ts` (automatic)

**Interfaces:**
- Consumes the same render data and rules as Task 2: `Technical Skills` heading, no letter-spacing, `amssymb`.
- Produces `template.toml` with `id = "traditional"`, `name = "Traditional"`, `engine = "xelatex"`, both kinds supported, and `packages` and `fonts` filled in.
- Design (re-implemented from dnl-blkv/mcdowell-cv):
  - Serif TeX Gyre Termes by file name (`texgyretermes-regular.otf`, `-bold`, `-italic`, `-bolditalic`).
  - The name centred, large and in small caps; one centred contact line separated by `$\diamond$`.
  - Section headings bold small caps with a full-width rule below.
  - Entries: bold heading left, location right; italic subheading left, dates right; compact bullets.
  - Conservative black only.
  - The cover letter matches: same header, date, `Hiring Team` / company, `Re: <role>`, greeting, paragraphs, closing and name.
- `LICENSE`: the MIT text with the McDowell CV copyright line copied from the upstream `LICENSE`, plus "Template design adapted from dnl-blkv/mcdowell-cv (https://github.com/dnl-blkv/mcdowell-cv)."

- [ ] **Step 1: Run** `bun test tests/templates.test.ts` before adding the directory, and note that `traditional` is absent.
- [ ] **Step 2: Implement** the template directory.
- [ ] **Step 3: Run** `bun test tests/templates.test.ts`. Expected: PASS for `traditional` (both kinds, sparse variant, ATS, metadata, 1 page).
- [ ] **Step 4: Run** `bun run previews traditional`, look at the PNG, then run `bun test`.
- [ ] **Step 5: Commit** `feat: traditional template (McDowell CV style, XeLaTeX)`

---

### Task 4: `minimal` template (moderncv `banking`, pdfLaTeX)

Parallel-safe with Tasks 2, 3, 7 and 8.

**Files:**
- Create: `templates/minimal/{template.toml,preamble.tex.njk,header.tex.njk,resume.tex.njk,cover-letter.tex.njk,LICENSE,preview.png}`
- Test: `tests/templates.test.ts` (automatic)

**Interfaces:**
- Consumes the same render data and rules as Task 2.
- Produces `template.toml` with `id = "minimal"`, `name = "Minimal"`, `engine = "pdflatex"`, both kinds supported, and `packages` including `"moderncv.cls"` and the icon package moderncv loads. Check with `kpsewhich`; moderncv's `awesome` icons use `fontawesome5`.
- Design:
  - Use the installed class: `\documentclass[11pt,letterpaper,sans]{moderncv}`, `\moderncvstyle{banking}`, `\moderncvcolor{black}`.
  - Geometry with `scale=0.8`.
  - `\input{glyphtounicode}\pdfgentounicode=1`.
  - `\name{<first word of name>}{<rest of name>}`. Split the already-escaped string on the first space in Nunjucks, e.g. `about.name.split(" ")`.
  - `\phone[mobile]`, `\email`, `\address` and links via `\homepage` / `\social`. Optional fields are omitted when absent.
  - Experience and education via `\cventry{dates}{heading}{subheading}{location}{}{itemize of bullets}`, projects the same way, skills via `\cvitem{category}{items}` under `\section{Technical Skills}`, and the summary as `\cvitem{}{…}`.
  - moderncv sets its own PDF metadata, so wrap `\hypersetup{…}` in `\AtBeginDocument{…}` to win. The pdfinfo test decides.
  - Cover letter: `\recipient{Hiring Team}{<company>}`, `\date{<date>}`, `\opening{<greeting>}`, `\closing{<closing>}`, `\makelettertitle`, then `\textbf{Re: <role>}`, paragraphs and `\makeletterclosing`. The fill marker goes after `\makeletterclosing`.
  - If moderncv's icons break the ATS email/phone extraction, switch to `\moderncvicons{letters}`. The test decides.
- `LICENSE`:
  - the moderncv credit: Xavier Danaux and the current maintainers, as named in the header of `$(kpsewhich moderncv.cls)`, copied verbatim
  - the LPPL 1.3c notice and URL
  - a line stating the class is used from the user's TeX distribution, not vendored

- [ ] **Step 1: Run** `bun test tests/templates.test.ts` and note that `minimal` is absent.
- [ ] **Step 2: Implement** the template directory.
- [ ] **Step 3: Run** `bun test tests/templates.test.ts`. Expected: PASS for `minimal`.
- [ ] **Step 4: Run** `bun run previews minimal`, look at the PNG, then run `bun test`.
- [ ] **Step 5: Commit** `feat: minimal template (moderncv banking, pdfLaTeX)`

---

### Task 5: Fabrication scanner — prose openers and the `-ly` rule

Parallel-safe with everything.

**Files:**
- Modify: `src/checks/fabrication.ts`
- Test: `tests/fabrication.test.ts`

**Interfaces:**
- Produces:
  - `export const ADVERB_OPENERS: readonly string[]`. These apply to all text, resumes included:
    > Recently, Previously, Currently, Additionally, Finally, Initially, Originally, Ultimately, Notably, Similarly, Specifically, Primarily, Mostly, Largely, Typically, Usually, Generally, Eventually, Consequently, Accordingly, Importantly, Increasingly, Personally, Separately, Subsequently, Simultaneously, Fortunately, Unfortunately, Interestingly, Ideally, Clearly, Naturally, Lately, Formerly, Early, Daily, Weekly, Monthly, Quarterly, Only, Regularly, Briefly, Quickly, Directly, Independently, Jointly, Successfully, Effectively, Efficiently, Consistently, Proactively, Collaboratively, Partly, Fully, Newly, Nearly, Roughly, Approximately
  - In `exemptAtSentenceStart`, the clause `(PLAIN_TITLECASE.test(t) && whole.endsWith("ly"))` is replaced by membership of `whole` in `ADVERB_OPENERS` (case-insensitive). The lowercase-elsewhere exemption in `scanClaims` is unchanged. Nothing else ending in `-ly` is exempt.
  - `RESUME_VERBS` adds `"Work"`, so `Works` / `Worked` / `Working` are exempt through the existing inflection rules.
  - `PROSE_OPENERS` (opt-in: cover letters and summaries) adds:
    > Alongside, Across, Among, Amid, Around, Through, Throughout, Within, Without, Toward, Towards, Together, Although, Though, Unlike, Despite, Following, Given, Having, Here, Where, Even, Such, Several, Much, Above, Below, Along, Against, Until, Unless, Whatever, Whenever, Perhaps, Indeed, Thus, Hence, Therefore, Otherwise, Again, First, Second, Third, Next, Last, Never, Always, Often, Sometimes, Back, Outside, Inside, Besides, Between, Behind, Upon, Into, Near, Past, Like

    Every addition is at least 4 characters long (R9).

- [ ] **Step 1: Write failing tests.**
  - `scanClaims("Alongside the billing rebuild, I mentored two engineers.", ["billing rebuild", "mentored"], { openers: PROSE_OPENERS })` → `[]`
  - `scanClaims("Works like Ledgerly taught me to ship small.", ["Ledgerly"], { openers: PROSE_OPENERS })` → `[]`
  - `scanClaims("Works closely with the data team.", [])` → `[]` (resume mode, through the `Work` verb)
  - `scanClaims("Calendly integrations shipped.", [])` → `["Calendly"]`
  - `scanClaims("Calendly integrations shipped.", ["Built Calendly sync"])` → `[]`
  - `scanClaims("Bitly links tracked.", [])` → `["Bitly"]`
  - `scanClaims("Recently moved to Postgres.", ["Postgres"])` → `[]`
  - `scanClaims("Previously built REST services in Go.", ["Go"])` → `[]`
  - `scanClaims("Weekly reports automated.", [])` → `[]`
  - `scanClaims("Friendly reviews helped.", [], { context: "kept it friendly" })` → `[]` (the lowercase-elsewhere rule still applies)
  - R9 guard: every `PROSE_OPENERS` / `ADVERB_OPENERS` / `RESUME_VERBS` entry of 3 characters or fewer is in the set of P2 short entries. List that set literally in the test, copied from the current file before editing. The existing `Go` tests still pass.
- [ ] **Step 2: Run** `bun test tests/fabrication.test.ts`. Expected: FAIL (Alongside, Works, Calendly, Bitly).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test`. Expected: PASS. `validate.test.ts`, `cover-letter.test.ts` and `apply.test.ts` fixtures still validate.
- [ ] **Step 5: Commit** `fix(checks): prose openers Alongside/Works; only listed -ly adverbs are exempt`

---

### Task 6: Harness robustness — `invalid_output`, auth checks, fallback, locked-down research, signal cleanup

Parallel-safe with Tasks 1 and 5.

**Files:**
- Create:
  - `src/signals.ts`
  - `tests/fixtures/research-driver.ts`
  - `tests/signals.test.ts`
- Modify:
  - `src/harness/adapter.ts`
  - `src/config.ts`
  - `src/pipeline/workspace.ts`
  - `src/pipeline/research.ts`
  - `src/pipeline/prompts/research-company.md`
  - `src/proc.ts`
  - `src/commands/init.ts` (config comments)
  - `tests/fixtures/fake-harness.ts`
- Test: `tests/adapter.test.ts`, `tests/config.test.ts`, `tests/research.test.ts`, `tests/signals.test.ts`

**Interfaces:**
- Produces, in `adapter.ts`:
  - `HarnessErrorKind = "not_installed" | "auth" | "rate_limit" | "timeout" | "invalid_output" | "unknown"`.
  - The `invalid_output` hint: `"The agent's output failed validation; see errors.md in the workspace, or retry with --harness <other>"`.
  - `AdapterConfig.auth_check?: string[]`. Presets:
    - claude: `["claude","auth","status"]`
    - codex: `["codex","login","status"]`
    - pi: `["pi","auth","check","--provider","google"]`
  - `PRESETS.claude.research_command` = `["claude","-p","{prompt}","--tools","WebSearch,WebFetch,Write","--allowedTools","WebSearch WebFetch Write","--permission-mode","acceptEdits","--strict-mcp-config"]`. The codex preset is unchanged (codex cannot restrict tools; cwd isolation remains).
  - `resolveFallbacks(cfg: Config, primary: string): Fallback[]` resolves each `cfg.fallback_harnesses` name with `resolveAdapter`, then drops `primary` and duplicates. An unknown name throws `UserError("Unknown harness \"<n>\" in fallback_harnesses", …)`.
- Produces, in `config.ts`: `fallback_harnesses: z.array(z.string()).default([])`, and `auth_check` in `AdapterConfig`. `init.ts`'s config template documents both, commented out.
- Produces, in `workspace.ts`:
  - `export type Fallback = { name: string; adapter: AdapterConfig }`.
  - `runAgentStep` opts add `fallbacks?: Fallback[]` and `promptMode?: "file" | "inline"` (default `"file"`). It returns `{ value: T; warnings: string[]; harness: string }`, where `harness` is the name that produced the value.
  - When retries are exhausted it throws `new HarnessError("Agent output invalid after <n> attempts", "Inspect <workspace>", "invalid_output")`. The message and hint are unchanged from P2, so existing assertions hold.
  - **Fallback.**
    - A `HarnessError` whose kind is in `FALLBACK_KINDS = ["not_installed","auth","rate_limit","timeout"]` moves to the next fallback.
    - It calls `onProgress("<name> failed (<kind>); trying <next>…")`, resets the retry counter and continues.
    - Logs from a fallback go to `stdout.<name>[.<attempt>].log` so the primary's logs survive.
    - `invalid_output` and `unknown` never fall back.
    - When every candidate fails, it throws the last error.
  - **Inline prompt mode.** The harness prompt is:
    1. the instructions
    2. for each file, `\n\n## <name>\n\n` followed by a fenced block of its content
    3. `\n\nWrite out/<outFile> with your file-writing tool. You do not need to read any files.`

    Files are still written to the workspace for the logs. A retry appends `\n\nYour previous attempt was rejected:\n` plus the error list.
- Produces, in `signals.ts`: `export function onInterrupt(fn: () => void): () => void`.
  - It installs `SIGINT` / `SIGTERM` handlers once, lazily.
  - On a signal it runs the registered fns in LIFO order, each inside try/catch, then calls `process.exit(130)` for SIGINT or `143` for SIGTERM.
  - The returned function unregisters `fn`.
- `proc.ts`: `spawnWithTimeout` registers `onInterrupt(() => process.kill(-pid, "SIGKILL"))` while the child runs, and unregisters it in `finally`.
- `research.ts`:
  - Registers `onInterrupt(() => rmSync(root, { recursive: true, force: true }))` right after `mkdtempSync`, and unregisters it in `finally`.
  - Calls `runAgentStep` with `promptMode: "inline"`.
  - Exports `loadCompanyResearch(appDir: string): CompanyResearch | null` (the current `loadExisting` on `<appDir>/job/company.json`).
- `research-company.md` is rewritten for inline mode. It says the target and the schema follow below, and it never asks to read a file.
- `fake-harness.ts`:
  - Optional args after the workspace: `--as <tag>` and `--prompt <text>`.
  - A new attempt key `"$sleep": <ms>`, which sleeps before writing.
  - `FAKE_HARNESS_FAIL_AS=<tag>` fails with "usage limit reached" when this instance's tag matches. When combined with `FAKE_HARNESS_FAIL_STEP`, both must match.
  - `FAKE_HARNESS_LS` entries add `tag`, `prompt` (when given) and `pid` (`process.pid`).
  - Update the header comment.

- [ ] **Step 1: Write failing tests.**
  - adapter (preset):
    - In `resolveAdapter("claude", cfg, { research: true }).command`, the element after `--tools` is `"WebSearch,WebFetch,Write"`, it contains `"--strict-mcp-config"`, and no element contains `Read`, `Glob`, `Edit` or `Bash`.
    - `PRESETS.codex.auth_check` deep-equals `["codex","login","status"]`.
  - adapter (fallbacks): `resolveFallbacks({ …cfg, fallback_harnesses: ["claude","codex","claude"] }, "claude").map(f => f.name)` → `["codex"]`; `["nope"]` throws a `UserError` mentioning `fallback_harnesses`.
  - adapter (`runAgentStep` with the fake harness):
    - Invalid output 3 times → `HarnessError` with `kind === "invalid_output"` and message `Agent output invalid after 3 attempts`.
    - Fallback: the primary is `name: "a"` (fake `--as a`) and `fallbacks: [{ name: "b", adapter: <fake --as b> }]`, with `FAKE_HARNESS_FAIL_AS=a` → `result.harness === "b"`, the value is valid, and `stdout.log` and `stdout.b.log` both exist.
    - The same without fallbacks → `HarnessError` of kind `rate_limit`.
    - Primary invalid output with a fallback → `invalid_output`, and the LS log has no entry with tag `b`.
  - config: `fallback_harnesses` defaults to `[]`; `fallback_harnesses = "codex"` → `UserError`.
  - research: with `research_command = ["bun", fake, "{workspace}", "--prompt", "{prompt}"]`, the LS `prompt` contains `"company": "Atlas Freight"` and `"facts"` (from the schema), and does not contain `Read instructions.md`.
  - signals (subprocess):
    1. `tests/fixtures/research-driver.ts` runs `runResearch` with the fake adapter, a script with `{ "research": [{ "$sleep": 30000 }] }`, and `FAKE_HARNESS_LS` set.
    2. The test polls the LS file for up to 10 s, then sends `SIGINT` to the driver.
    3. Expect exit code 130.
    4. Expect `existsSync(dirname(entry.workspace)) === false`, i.e. the temp root is gone.
    5. Within 2 s, `process.kill(entry.pid, 0)` throws: the harness child is dead.
- [ ] **Step 2: Run** `bun test tests/adapter.test.ts tests/config.test.ts tests/research.test.ts tests/signals.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in this order: fake harness, `signals.ts` / `proc.ts`, `adapter.ts` / `config.ts`, `workspace.ts`, `research.ts` and its prompt.
- [ ] **Step 4: Run** `bun test` and `bunx tsc --noEmit`. Expected: PASS. Existing refine/apply tests are unaffected: the messages are unchanged and `HarnessError` extends `UserError`.
- [ ] **Step 5: Commit** `feat(harness): invalid_output class, auth checks, opt-in fallback, web-only research agent, interrupt cleanup`

---

### Task 7: `resumely doctor`

Run after Tasks 1 and 6. Parallel-safe with Tasks 2–4 and 8; `src/cli.ts` gets a separate command block.

**Files:**
- Create: `src/commands/doctor.ts`, `tests/doctor.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes:
  - `PRESETS`, `resolveAdapter`, `AdapterConfig.check` / `auth_check` / `research_command` (Task 6)
  - `scanTemplates(dirs, problems)`, `templateDirs(root)`, `TemplateMeta.packages` / `fonts` / `engine` (Task 1)
  - `loadConfig`, `loadProfile`, `layout`
- Produces:
  - `export type Probe = (argv: string[]) => Promise<{ code: number | null; stdout: string; missing: boolean }>`. The default uses `spawnWithTimeout` with a 15 s timeout; `missing` is true on ENOENT.
  - `export type DoctorCheck = { group: "Harnesses" | "LaTeX" | "Templates" | "Tools" | "Data root"; label: string; ok: boolean; required: boolean; detail?: string; hint?: string }`
  - `export async function checkHarness(name: string, a: AdapterConfig, probe: Probe, required: boolean): Promise<{ installed: boolean; authenticated: boolean | null; checks: DoctorCheck[] }>`. Task 10 reuses it.
  - `export async function runDoctor(o: { root: string; probe?: Probe; which?: (bin: string) => string | null }): Promise<DoctorCheck[]>`. It never throws on environment problems.
  - `export function formatDoctor(checks: DoctorCheck[]): { text: string; failed: number }`
    - Checks are grouped under their group name.
    - A passing line is `  ✓ <label>[ — <detail>]`; a failing line is `  ✗ <label>[ — <detail>]`, with ` (optional)` appended when `!required`.
    - A hint goes on the next line as `      hint: <hint>`.
    - The final line is `All required checks passed.` or `<n> required check(s) failed.`
    - `failed` counts failing required checks.
  - CLI `resumely doctor` prints the text to stdout and sets `process.exitCode = 1` when `failed > 0`. It does not call `requireDataRoot`.
- Rules (labels are exact):
  - **Data root** (`root`):
    - `data root` (required): `config.toml` exists, else hint `Run: resumely init`, and the remaining Data root checks are skipped.
    - `config.toml parses` (required; detail = the `UserError` message + hint).
    - `profile loads` (required; detail `<n> entries`, or the error message).
    - `about.md present` (required).
    - `profile filled in` (required; fails when the name is `Your Name` or there are 0 entries; hint `Edit profile/about.md and add entries`).
    - With no data root or an invalid config, use the default config for the other groups.
  - **Harnesses** cover every preset plus every `config.adapters` name, with the default harness first.
    - `<name>: installed`:
      - runs `check ?? [command[0], "--version"]`
      - detail: the first stdout line, plus `, web research` when `research_command` is set
      - hint when missing: `Install <command[0]>`
    - `<name>: authenticated`:
      - only shown when installed and `auth_check` is set
      - hint:
        - claude: `Run: claude auth login`
        - codex: `Run: codex login`
        - pi: `Configure a provider (pi auth check --provider <name>) and set adapters.pi.auth_check to match`
        - other: `Log in to <name>`
    - Required only for `config.harness`.
  - **LaTeX:**
    - `latexmk` (required; hint `Install TeX Live (macOS: brew install --cask mactex-no-gui)`).
    - One line per engine used by any template: label `<engine>`, detail `used by <ids>`; required if the default template uses it.
  - **Templates:**
    - One `kpsewhich` call per template, with the package files (a bare name gets `.sty`) and font files as arguments. Found = the basenames of the stdout lines.
    - `<id>` with detail `<p> packages, <f> fonts` on success. On failure, detail `missing <files>` and hint `tlmgr install <names without extensions>`.
    - Required only for `config.template`.
    - An unknown default template is `✗ <id>: not found` (required).
    - Each `templateProblems` entry is an optional `✗` line.
  - **Tools:** `pdftotext` (optional; hint `Install poppler (macOS: brew install poppler) for the ATS check`).

- [ ] **Step 1: Write failing tests.** Use a fake `Probe` driven by a lookup table keyed on `argv.join(" ")` (unknown argv → `missing: true`) and a fake `which`.
  - Everything OK, on an initialised root with the Jordan profile → `failed === 0`, the text contains `✓ claude: installed` and `All required checks passed.`, and there is no `✗`.
  - `claude auth status` exits 1 → `failed === 1`, and the text contains `✗ claude: authenticated` and `hint: Run: claude auth login`.
  - `codex` missing (not the default) → `✗ codex: installed (optional)`, and `failed === 0`.
  - kpsewhich doesn't return `fontawesome5.sty`. With default `classic` and a template using it → an optional `✗`. With that template as the default → a required failure, and the hint starts `tlmgr install fontawesome5`.
  - No data root (a fresh empty dir) → `✗ data root` with `hint: Run: resumely init`. The Harnesses and LaTeX groups are still printed, `failed >= 1`, and nothing throws.
  - A profile entry with bad frontmatter → `✗ profile loads` with a detail naming the file.
  - `<root>/templates/broken/template.toml` = `id = 3` → an optional `✗` line containing `broken` (Review Focus 4).
  - CLI: `RESUMELY_HOME=<empty tmp dir> bun src/cli.ts doctor` exits 1, and stdout contains `Data root` and `resumely init`.
- [ ] **Step 2: Run** `bun test tests/doctor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: resumely doctor`

---

### Task 8: Checkpointed runs and `resumely resume`

Run after Task 6. Parallel-safe with Tasks 2–4 and 7; `src/cli.ts` gets a separate command block.

**Files:**
- Create: `src/pipeline/checkpoint.ts`, `tests/checkpoint.test.ts`, `tests/resume.test.ts`
- Modify:
  - `src/pipeline/workspace.ts`
  - `src/pipeline/refine.ts`
  - `src/pipeline/documents.ts`
  - `src/pipeline/apply.ts`
  - `src/cli.ts`
  - `tests/refine.test.ts` (one expectation changes, see Step 1)
  - `tests/apply.test.ts` (`runId`)

**Interfaces:**
- Consumes:
  - `runAgentStep` fallbacks, `HarnessError` kinds, `resolveFallbacks`, `loadCompanyResearch` and `onInterrupt` (Task 6)
  - `ResearchStatus`
  - `DocResult` / `ApplyResult` (P2)
- Produces, in `workspace.ts`:
  - `export interface StepCache { get(step: string): { harness: string } | null; done(step: string, rec: { harness: string; outFile: string; fallback: boolean }): void }`. `fallback` is `harness !== opts.name`, i.e. a configured fallback produced the output.
  - `runAgentStep` opts add `checkpoint?: StepCache`. The step is `basename(workspace)`. A **hit** needs all of:
    - `get(step)` is non-null
    - `<ws>/out/<outFile>` exists
    - the file parses
    - `validate` passes

    On a hit it returns `{ value, warnings (fresh from validate), harness: rec.harness }` without spawning, and calls `onProgress("<step>: reused from checkpoint")`. Otherwise it runs normally, and calls `done(step, …)` after validation succeeds and before returning.
- Produces, in `refine.ts`:
  - `RefineOptions` adds `checkpoint?: StepCache` and `fallbacks?: Fallback[]`, both passed to the review `runAgentStep`.
  - In the review and revise `catch` blocks, rethrow first when `e instanceof HarnessError && e.kind !== "invalid_output"`. Availability failures now fail the document so it can be resumed; `invalid_output` keeps P2's warning-and-stop behaviour.
- `documents.ts`: `DocContext` adds `checkpoint?: StepCache` and `fallbacks?: Fallback[]`, passed to the writer `runAgentStep`.
- Produces, in `checkpoint.ts`. The run dir layout:
  ```
  .runs/<run-id>/state.json          # RunState, written atomically (state.json.tmp → rename)
  .runs/<run-id>/inputs/job.md       # job text at run start
  .runs/<run-id>/inputs/profile/     # copy of profile/ at run start (excluding .inbox/)
  .runs/<run-id>/<step>/             # existing agent workspaces (parse, resume-write, cover-review-1, …)
  ```
  ```ts
  type RunOptions = { template: string; mode: "truthful" | "stretch"; pages: number; cover: boolean; research: boolean;
                      review: boolean; role?: string; input: { kind: JobSource["kind"]; url?: string; path?: string } };
  type RunState = {
    version: 1; run_id: string; pid: number; status: "running" | "failed" | "done" | "aborted";
    created: string; updated: string; harness: string; options: RunOptions;
    app: { dir: string; slug: string } | null;
    steps: Record<string, { harness: string; fallback: boolean; out: string /* relative to run dir */; finished: string }>;
    research: { status: ResearchStatus; warning?: string } | null;
    documents: { resume?: DocResult; "cover-letter"?: DocResult };
    error: { message: string; hint?: string; kind?: string } | null;
  };
  ```
  `class RunCheckpoint implements StepCache` (`RunState` is parsed with a Zod schema on load):
  - `static create(runsDir, runId, o: { harness: string; options: RunOptions; jobText: string; profileDir: string }): RunCheckpoint`
  - `static load(runsDir, runId): RunCheckpoint`
  - `readonly dir`, `state`, `jobText`, `profileDir`
  - `get`, `done`
  - `setHarness(name)`, `setApp(app)`, `setResearch(r)`, `setDocument(kind, d)`
  - `finish()`, which sets `done`
  - `fail(e: unknown)`, which sets `failed` and `error`
  - `abort()`

  Every mutator saves.

  Module functions:
  - `listRuns(runsDir): RunState[]` — newest `updated` first; dirs without a valid `state.json` are skipped.
  - `isAlive(pid: number): boolean` — `process.kill(pid, 0)`; EPERM counts as alive.
  - `pickResumable(runsDir, runId?): RunCheckpoint`:
    - Explicit id:
      - missing → `UserError("No run \"<id>\"", "Runs are in <runsDir>")`
      - unparsable → `UserError("Run <id> has an unreadable state.json", "<path>")`
      - `done` → `UserError("Run <id> already finished", "Its documents are in <app.dir>")`
      - `running` with a live pid → `UserError("Run <id> is still running (pid <pid>)")`
      - otherwise (failed, aborted, stale running) → that run
    - No id: the newest `failed` or stale-`running` run, else `UserError("No failed run to resume", "Start a new one with: resumely apply")`.
  - `relinkRuns(runsDir, fromDir: string, to: { dir: string; slug: string }): number` updates `state.app` wherever `app.dir === fromDir`.
- Produces, in `apply.ts`:
  - `ApplyResult` adds `runId: string`.
  - `applyJob(opts)`:
    1. Runs the current preflight: data root, config, non-empty profile, latexmk, adapter, template.
    2. Calls `RunCheckpoint.create`.
    3. Calls `runPipeline` with the profile loaded from `cp.profileDir`, and with voice samples from there too.
  - `resumeRun(o: { root: string; runId?: string; harness?: string; open?: boolean; onProgress?: (m: string) => void; onDuplicate?: ApplyOptions["onDuplicate"] }): Promise<ApplyResult>`:
    - The run is `pickResumable`; the harness is `o.harness ?? state.harness`, recorded with `setHarness`.
    - Options and job text come from the state and `inputs/`. The profile comes from the snapshot. `pause` is never called.
    - **With `state.app`:** the application is `findApplication(appsDir, state.app.slug)` (exact slug), and intake is skipped (no `saveExtraRaw`). If the folder is gone → `UserError("Application folder for run <id> is gone: <dir>", "Move it back, or use resumely mv to rename applications")`.
    - **Without `state.app`:** normal intake (the parse step may be a cache hit).
    - Documents already in `state.documents` are not regenerated; they are returned as they are in the result.
  - `runPipeline` (internal):
    - At start: status `running`, pid = `process.pid`, and register `onInterrupt(() => cp.fail(new UserError("interrupted")))`.
    - After intake: `setApp`.
    - Research: reuse `state.research` if present; otherwise run it and then `setResearch`. When the status is `used`, the research comes from `loadCompanyResearch(app.dir)`.
    - The parse, writer and reviewer `runAgentStep` calls get `checkpoint: cp` and `fallbacks: resolveFallbacks(config, harness)`. Research gets neither.
    - Each saved document: `setDocument`.
    - At the end: no failures → `finish()`, else `fail(first failure)`.
    - A thrown `UserError`:
      - `"Aborted"` → `abort()`
      - otherwise → `fail(e)`, then rethrow with the hint suffix ` — resume with: resumely resume <runId>`, keeping the `HarnessError` class and kind.
    - The result's warnings add `"<step> ran on fallback harness <h>"` for each step record with `fallback: true`. An explicit `resume --harness` switch is not a fallback.
- CLI:
  - Extract apply's output block into `report(r: ApplyResult)`, used by both `apply` and `resume`. When `r.failures.length`, it also prints `hint: resume with: resumely resume <runId> [--harness <other>]`.
  - `resumely resume [run-id] [--harness <name>] [--no-open]`. It passes `onDuplicate` the way `apply` does without `--into`/`--new`: `promptDuplicate` on a TTY, else none. This only matters when the run failed before its application was created.

- [ ] **Step 1: Write failing tests.**
  - `tests/checkpoint.test.ts` (unit, no LaTeX):
    - `create` writes `state.json` with `status: "running"` and `pid === process.pid`; `inputs/job.md` equals the text; `inputs/profile/about.md` exists; a `profile/.inbox/x.md` is not copied.
    - A `done` → `load` round trip keeps the step. No `state.json.tmp` remains.
    - `runAgentStep` with a cache hit and a valid out file → 0 harness calls (`.calls` file absent). With the out file overwritten by `{not json` → 1 call, and `done` is recorded again.
    - `pickResumable`:
      - prefers the newest `failed`
      - skips `done` / `aborted`
      - picks a `running` run with pid `999999`
      - `running` with `process.pid` → "still running"
      - an explicit `done` → "already finished"
      - none → "No failed run to resume"
    - `relinkRuns` rewrites `app.dir` and `slug` and returns `1`.
  - `tests/resume.test.ts`: the fake harness, `apply.test.ts`-style setup, latexmk-gated.
    - After a happy `applyJob`, the state is `done`, `steps` has the keys `parse`, `research`… (whichever agent steps ran: `parse`, `resume-write`, `resume-review-1`, `cover-write`, `cover-review-1`), and `documents.resume.version === 1`.
    - `FAKE_HARNESS_FAIL_STEP=cover-write`:
      1. apply → failure, state `failed`.
      2. Unset it, then `resumeRun({ root, open: false })`.
      3. The calls after the resume are exactly `["cover-write", "cover-review-1"]`.
      4. `result.resume.version === 1` (from the state), `result.cover.version === 1`, `resume/` contains only `v1`, and the state is `done`.
    - `FAKE_HARNESS_FAIL_STEP=resume-review-2`, with a script that revises in round 1: apply → a resume failure with kind `rate_limit`, and the cover is saved. Resuming runs only `["resume-review-2"]` (plus `resume-revise-2` if scripted) and saves `resume/v1`.
    - `FAKE_HARNESS_FAIL_STEP=parse`: `applyJob` rejects with a `HarnessError` of kind `rate_limit` whose hint contains `resumely resume <runId>`, and no application dir exists. `resumeRun` creates the app and finishes.
    - Harness switch:
      - Config adds `[adapters.fake2]` = the fake harness with `--as b`, and the failure is at `cover-write`.
      - `resumeRun({ harness: "fake2" })` → the LS tags for `cover-write` are `b`.
      - `state.harness === "fake2"`.
      - The result's warnings contain no fallback line: an explicit switch is not a fallback.
    - Fallback: `fallback_harnesses = ["fake2"]`, the primary has `--as a`, and `FAKE_HARNESS_FAIL_AS=a` → both documents are saved, and the warnings contain `ran on fallback harness fake2`.
    - **Review Focus 2:** fail at `cover-write`, delete `profile/projects/ledgerly.md` from the live profile, then `resumeRun` succeeds. The cover cites `proj-ledgerly`, which validates against the snapshot.
    - **Review Focus 1:**
      1. Fail at `cover-review-1`.
      2. Overwrite `<run>/cover-write/out/cover-letter.json` with `{not`.
      3. Set the state's `status` to `running` and `pid` to `999999`.
      4. `resumeRun({ root })` with no id picks it, and the calls are `["cover-write", "cover-review-1"]`.
    - Corrupt `state.json` → `resumeRun({ runId })` rejects with "unreadable state.json".
    - A deleted app folder → "is gone".
  - `tests/refine.test.ts`: the test "a failing second review keeps the revised version…" now expects `go()` to reject with a `HarnessError` of kind `rate_limit`. The invalid-review tests keep their warnings.
  - `tests/apply.test.ts`: `r.runId` matches `/^\d{8}-\d{6}-[a-z0-9]{4}$/`.
  - CLI (`tests/cli.test.ts`):
    - `resume` with no runs exits 1 with `No failed run to resume`.
    - `apply` with `FAKE_HARNESS_FAIL_STEP=cover-write` in the env exits 1, and stderr contains `hint: resume with: resumely resume `.
- [ ] **Step 2: Run** `bun test tests/checkpoint.test.ts tests/resume.test.ts tests/refine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `checkpoint.ts` and the `StepCache` hook in `runAgentStep`, then run `bun test tests/checkpoint.test.ts`. Expected: PASS.
- [ ] **Step 4: Implement** the refine/documents passthrough, the `apply.ts` split and `resumeRun`, and the CLI.
- [ ] **Step 5: Run** `bun test` and `bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: checkpointed runs, resumely resume, opt-in harness fallback in the pipeline`

---

### Task 9: Intake leftovers — `$EDITOR`, `--role`, agency folders, `mv`

Run after Task 8. Parallel-safe with Task 10.

**Files:**
- Create: `src/application/move.ts`, `tests/fixtures/fake-editor.ts`, `tests/move.test.ts`
- Modify:
  - `src/job/intake.ts`
  - `src/pipeline/schemas.ts`
  - `src/pipeline/prompts/parse-job.md`
  - `src/application/slug.ts`
  - `src/application/store.ts`
  - `src/pipeline/apply.ts`
  - `src/cli.ts`
- Test: `tests/intake.test.ts`, `tests/store.test.ts`, `tests/apply.test.ts`, `tests/cli.test.ts`, `tests/move.test.ts`

**Interfaces:**
- Consumes: `relinkRuns` and `RunOptions.role` (Task 8).
- Produces, in `intake.ts`:
  - `JobSource.kind` adds `"editor"`.
  - `readFromEditor(o?: { env?: Record<string, string | undefined>; spawn?: (argv: string[]) => Promise<number | null> }): Promise<JobSource>`:
    - The editor is `VISUAL || EDITOR || "vi"`.
    - argv is `[editor]` if `existsSync(editor)`, else `editor.trim().split(/\s+/)`; the temp file path is appended.
    - The temp file is `<mkdtemp resumely-job->/job.md`. Its first line is `<!-- resumely: paste the job posting below, then save and close the editor. Leave it empty to cancel. -->`, followed by a blank line.
    - Afterwards, lines starting with `<!-- resumely:` are dropped and the text is trimmed.
    - Errors:
      - a non-zero exit → `UserError("Editor exited with status <n>", "Nothing was saved")`
      - ENOENT → `UserError("Editor not found: <argv[0]>", "Set $EDITOR, or use --clip or a file")`
      - empty text → `UserError("No job text entered", "Nothing was saved")`
    - The temp dir is removed in `finally`.
    - The default `spawn` is `Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env }).exited`.
  - `resolveJobInput(arg, opts: { clip?: boolean; interactive?: boolean; editor?: Parameters<typeof readFromEditor>[0] })`. With no `arg` and no `clip`:
    - `interactive` → `readFromEditor(opts.editor)`
    - else `UserError("No job given", "resumely apply <url|file>, --clip, or run it in a terminal to paste into $EDITOR")`
- Produces, in `schemas.ts`: `ParsedJob` adds `other_roles: z.array(z.string()).optional()`. `parse-job.md` gets the line: "`other_roles`: the other distinct roles the posting advertises when it lists more than one; omit otherwise."
- Produces, in `slug.ts`:
  - `agencyOf(company: string): string | null`, matching `/^Confidential \(via (.+)\)$/i`.
  - `createApplication` slugs `agencyOf(company) ?? company`.
  - `sendReadyName` uses `agencyOf(company) ?? company` for `{Company}`.
- Produces, in `apply.ts`: `ApplyOptions.role?: string`, stored in `RunOptions.role`.
  - After the parse and before the company+role duplicate check: `job = { ...job, role }`, so `createApplication`, the slug and `parsed.json` use it.
  - If `role` matches neither the parsed role nor any `other_roles` (case-insensitive, trimmed), add the warning `--role "<r>" is not one of the roles parsed from the posting (<a>, <b>)`.
  - Without `--role` and with non-empty `other_roles`, add the warning `posting lists other roles: <a>, <b> (pick one with --role)`.
- Produces, in `move.ts`: `moveApplication(root: string, app: Application, o: { company?: string; role?: string }): Application`.
  - With neither field → `UserError("Nothing to change", "Pass --company and/or --role")`.
  - The new slug is `<app.slug.slice(0, 10)>-<slugify(agencyOf(c) ?? c)>-<slugify(r)>`. On a collision it gets a `-2`, `-3`, … suffix; it is unchanged if identical.
  - `renameSync` the folder, then rewrite `application.toml` (company/role) and `job/parsed.json` (company/role, if present).
  - `relinkRuns(layout(root).runs, oldDir, { dir, slug })`.
  - Existing version PDFs keep their names.
- CLI:
  - `apply` adds `--role <title>` and passes `interactive: isInteractive()` to `resolveJobInput`.
  - `mv <app> [--company <name>] [--role <title>]` prints `<old slug> → <new slug>`.
- `tests/fixtures/fake-editor.ts`: appends the contents of `FAKE_EDITOR_TEXT_FILE` (if set) to the file named by its last argv, then exits with `Number(FAKE_EDITOR_EXIT ?? 0)`.

- [ ] **Step 1: Write failing tests.**
  - intake:
    - `readFromEditor({ env: { EDITOR: "bun <fx>/fake-editor.ts", FAKE_EDITOR_TEXT_FILE: <backend.md> } })` → `kind === "editor"`, the text equals the trimmed contents of `backend.md`, and there's no `<!-- resumely:`.
    - `VISUAL` wins over `EDITOR`.
    - `FAKE_EDITOR_EXIT=3` → "status 3".
    - No text file → "No job text entered".
    - `EDITOR: "definitely-not-an-editor"` → "Editor not found".
    - An injected `spawn` captures argv: `EDITOR: "code --wait"` → argv `["code", "--wait", <path>]`, and the temp file's dir no longer exists after the call (Review Focus 5).
    - `resolveJobInput(undefined, { interactive: false })` → "No job given".
  - slug/store:
    - `agencyOf("Confidential (via Hays Recruitment)") === "Hays Recruitment"` and `agencyOf("Atlas Freight") === null`.
    - `createApplication` with that company, role `Senior Backend Engineer` and `now = new Date(2026, 10, 11)` → slug `2026-11-11-hays-recruitment-senior-backend-engineer`.
    - `sendReadyName("{First}_{Last}_{Kind}_{Company}", {name:"Jordan Example"}, "Resume", "Confidential (via Hays Recruitment)") === "Jordan_Example_Resume_HaysRecruitment.pdf"`.
  - apply (fake harness; the parse script adds `other_roles: ["Staff Backend Engineer"]`):
    - `role: "Staff Backend Engineer"` → `app.meta.role === "Staff Backend Engineer"`, the slug ends `-staff-backend-engineer`, `parsed.json` role is updated, and there is no role warning.
    - No role → a warning containing `posting lists other roles`.
    - `role: "Designer"` → a warning containing `is not one of the roles`.
    - The parsed company `Confidential (via Hays Recruitment)` → no `research` call, `meta.research === "skipped"`, and the slug contains `hays-recruitment`.
  - move:
    - The company becomes `Atlas Freight Inc` → the folder is renamed to `…-atlas-freight-inc-…`, the toml and `parsed.json` are updated, and the old dir is gone.
    - A `RunCheckpoint` pointing at the old dir is relinked.
    - Moving onto an existing slug gets `-2`.
    - No options → "Nothing to change".
  - cli:
    - `mv <app> --company "Atlas Freight Inc"` exits 0 and stdout contains `→`.
    - `apply` with no input on a non-TTY exits 1 with `No job given`.
- [ ] **Step 2: Run** `bun test tests/intake.test.ts tests/store.test.ts tests/apply.test.ts tests/move.test.ts tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: $EDITOR intake, --role for multi-role postings, agency folders, resumely mv`

---

### Task 10: Opt-in eval harness and fixture JDs

Run after Tasks 7 and 8. Parallel-safe with Task 9.

**Files:**
- Create:
  - `scripts/eval.ts`
  - `scripts/eval-lib.ts`
  - `tests/eval.test.ts`
  - `tests/fixtures/jobs/{frontend,data,pm,mismatched}.md`
  - `tests/fixtures/jobs/mismatched.expect.json`
- Modify: `package.json` (`"eval": "bun scripts/eval.ts"`), `.gitignore` (`eval-results/`)

**Interfaces:**
- Consumes: `applyJob` / `ApplyResult.runId` (Task 8), `checkHarness` / `Probe` (Task 7), `readJobFile`, `initDataRoot`, `loadConfig`, `resolveDataRoot`.
- Produces, in `eval-lib.ts`:
  - `type DocEval = { ready: boolean; ats: "ok" | "failed" | "skipped"; score: number | null; verdict: "pass" | "revise" | null; rounds: number }`
  - `type EvalRow = { harness: string; job: string; ok: boolean; error?: string; resume?: DocEval; cover?: DocEval; gaps: number; fabrication_flags: number; wall_ms: number; expect_ok: boolean | null }`
  - `summarizeRun(o: { harness: string; job: string; wallMs: number; result?: ApplyResult; error?: unknown; runDir?: string; expect?: { min_gaps?: number; max_gaps?: number } }): EvalRow`
    - It reads each saved version's `meta.json` (`ready`, `rounds`), `checks.json` (`ats.status`, `fabrication_warnings`) and `review.json`.
    - `score` is the mean of the review's numeric `scores`, rounded to 1 decimal, or `null` without a review.
    - `fabrication_flags` = the total `fabrication_warnings` + the lines matching `/is not supported by/` across `<runDir>/*/errors.md`.
    - `expect_ok` is `null` without `expect`.
  - `formatSummary(rows: EvalRow[]): string` — a Markdown table with this header:
    ```
    | harness | job | ok | resume ready/ats/score/rounds | cover ready/ats/score/rounds | gaps | fab | time | expect |
    ```
    Each doc cell looks like `✓/ok/4.3/1`, or `-` when there is no document. Time is formatted `m:ss`.
  - `parseEvalArgs(argv: string[]): { harnesses?: string[]; jobs?: string[]; out: string; stretch: boolean }`
    - `--harness a,b`
    - `--jobs a,b` (fixture basenames)
    - `--out DIR`, defaulting to `eval-results/<YYYYMMDD-HHMMSS>`
    - `--stretch`
- `scripts/eval.ts` (never imported by tests):
  1. Choose candidates: `--harness` or the preset names, plus the adapters from the user's real config if `resolveDataRoot()` is initialised.
  2. Check each with `checkHarness`. Available = installed, and `authenticated !== false`. Print skipped harnesses with the reason.
  3. Choose jobs: `tests/fixtures/jobs/*.md`, filtered by `--jobs`.
  4. For each harness × job, **sequentially**:
     - Make a fresh root at `<out>/<harness>-<job>/root`: `initDataRoot`, the Jordan profile copied in, and a `config.toml` with `harness = "<h>"` plus the user's `[adapters]` re-serialised with smol-toml.
     - Run `applyJob({ root, input: await readJobFile(path), harness: h, open: false, mode, onDuplicate: async () => "new", onProgress: m => console.error(\`[${h}/${job}] ${m}\`) })`, timed, catching errors.
     - Call `summarizeRun` with `<job>.expect.json` if present.
  5. Write `<out>/results.json` and `<out>/summary.md`, and print the summary.
  6. Exit 1 only when no harness is available, with the hint `run: resumely doctor`.
- Fixture JDs: fictional companies, English, at least 150 words each and none `isThin`.
  - `frontend.md`: React, TypeScript, accessibility, design systems. A partial match for Jordan.
  - `data.md`: Python, SQL, Airflow, dbt, Spark, Snowflake. A partial match.
  - `pm.md`: a non-technical product manager for a consumer subscription app (roadmaps, stakeholders, user research).
  - `mismatched.md`: a senior embedded firmware engineer (C, RTOS, AUTOSAR, ISO 26262, CAN bus).
  - `mismatched.expect.json`: `{ "min_gaps": 3 }`.

- [ ] **Step 1: Write failing tests** in `tests/eval.test.ts` (the fake harness; latexmk-gated where `applyJob` runs).
  - A happy `applyJob` (the P2 `full()` script) → `summarizeRun` gives:
    - `ok: true`, `resume.ready: true`, `resume.ats` ∈ {`ok`,`skipped`}
    - `resume.score` = the mean of `review-pass.json`'s scores
    - `resume.rounds === 1`
    - `gaps` = the number of gaps in the fixture resume
    - `fabrication_flags === 0`
    - `expect_ok === null`
  - The same with `expect: { min_gaps: 99 }` → `expect_ok === false`.
  - `summarizeRun({ …, error: new Error("boom") })` → `ok: false`, `error: "boom"`.
  - `formatSummary` of 2 rows → 4 lines: header, separator and 2 rows. 65 000 ms renders as `1:05`.
  - `parseEvalArgs(["--harness","claude,codex","--jobs","backend","--stretch"])` → harnesses `["claude","codex"]`, jobs `["backend"]`, `stretch: true`, and `out` starts with `eval-results/`.
  - Every `tests/fixtures/jobs/*.md` has at least 150 words and `!isThin`.
  - `package.json` `scripts.eval === "bun scripts/eval.ts"`. No file under `tests/` imports `scripts/eval.ts`; check by reading the test files' text.
- [ ] **Step 2: Run** `bun test tests/eval.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `eval-lib.ts`, `eval.ts` and the fixtures.
- [ ] **Step 4: Run** `bun test` and `bunx tsc --noEmit`. Expected: PASS. Then run `bun run eval --harness nope` and expect `no harness available` with exit 1, and no LLM call.
- [ ] **Step 5: Commit** `feat: opt-in bun run eval over fixture JDs`

---

### Task 11: Real-harness verification, README, design notes

Runs last.

**Files:**
- Modify: `README.md`, `design.md`
- Possibly modify presets, prompts or templates if verification demands it.

- [ ] **Step 1:** `bunx tsc --noEmit && bun test`. Expected: all pass, with 0 failures.
- [ ] **Step 2:** `bun run previews`. Open all 4 PNGs and check that each looks like its namesake and is 1 page.
- [ ] **Step 3:** `resumely doctor` on this machine. Expected:
  - `✓` for claude and codex (installed and authenticated), latexmk, pdflatex/xelatex/lualatex, every template's packages, and pdftotext
  - exit 0 (pi may show an optional `✗`)
- [ ] **Step 4: Research lockdown.** Use a temp data root with the Jordan profile and run `apply tests/fixtures/jobs/backend.md --harness claude --template modern --no-open`.
  - Expected: `meta.research` is `used` or `none_found` (not `failed`), proving `Write` works under `--tools`.
  - If claude rejects the comma-separated `--tools` value, switch the preset to separate argv elements and re-run.
  - Check `.runs/<run>/research/stdout.log` for any Read/Glob/Bash tool use. Expected: none.
- [ ] **Step 5: Resume.**
  1. Start the same apply with `--template traditional`, and send SIGINT once `cover-write` begins.
  2. Expected: exit 130, and no `$TMPDIR/resumely-research-*` dirs left over.
  3. Run `resumely resume`. Expected: completed steps print `reused from checkpoint`, both documents are saved, and `state.json` is `done`.
  4. Repeat with `resumely resume <id> --harness codex` after a forced failure, e.g. temporarily misconfigure `[adapters.claude] command`.
- [ ] **Step 6:**
  - `templates list`
  - `templates new mine --from minimal`
  - `render <app> --template mine`
  - `render <app> --template modern --cover`

  All exit 0.
- [ ] **Step 7:** `bun run eval --harness claude --jobs backend,mismatched`. Expected: `mismatched` has `expect` ✓ (≥ 3 gaps) and both rows `ok`. Record the wall times.
- [ ] **Step 8: Update `README.md`:**
  - the templates table with previews, and `templates list|new`
  - `doctor`
  - checkpoints / `resume` and `fallback_harnesses`
  - `$EDITOR` intake, `--role`, `mv`, agency handling
  - the "Agent access" paragraph: claude research has only WebSearch/WebFetch/Write and no MCP; codex is cwd-isolated only
  - `bun run eval` with the measured times
  - the status section → P3

  Update `design.md`:
  - §9 table: change `modern`'s engine cell to "LuaLaTeX (fontawesome5)".
  - Resolve the open question "`modern` template dependency" as: "fontawesome5 from stock TeX Live; no vendoring".
- [ ] **Step 9: Commit** `docs: P3 README; verify templates, doctor, resume, research lockdown, eval baseline`
