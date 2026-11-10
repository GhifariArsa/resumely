# resumely P1 — Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One working path end to end: `resumely init` → hand-written profile → `resumely apply <file|--clip|url>` → headless agent parses the JD and writes resume content JSON → deterministic render into the `classic` template → compiled PDF with a send-ready filename → `resumely ls` / `open` / `render`.

**Architecture:** A deterministic TypeScript core owns all files, validation, rendering and compilation. Agents are invoked headless through config-defined adapters using a file-based workspace contract (`instructions.md` in, `out/*.json` out). A `fake` adapter (a Bun script writing canned outputs) lets the whole pipeline be tested with no LLM.

**Tech Stack:** Bun ≥1.2, TypeScript (strict), `commander` (CLI), `zod@^4` (schemas + `z.toJSONSchema`), `smol-toml`, `yaml`, `nunjucks`, `@mozilla/readability` + `linkedom` (URL extraction), `bun test`. TeX Live `latexmk` at runtime.

**Spec:** `design.md` (repo root). Read §2, §3, §4, §5, §6, §7, §8 (steps 1, 3, 4, 5 only), §9, §10 before starting any task.

**Out of scope for P1** (later plans): HR review loop, company research, cover letters, `modern`/`traditional`/`minimal` templates, ATS + fabrication checks, `doctor`, import/inbox/interview, `resumely ui`, checkpoint/resume, duplicate guard, stretch-mode UI, evals.

## Global Constraints

- All user state is plain files under the data root: `RESUMELY_HOME` if set, else `~/resumely/`. (`resumely init <dir>` with a custom dir is deferred; P1 `init` uses the resolved root.)
- The agent writes structured JSON only — never LaTeX. Resume header (name/email/phone/links) comes from `profile/about.md` deterministically, never from the agent.
- Truthful mode is the only mode in P1: every bullet must have ≥1 `entry_ids` that exist in the profile, and `basis` must be `"direct"`.
- Content under a `## Private` heading (until the next `## ` heading or EOF) in any entry body, and the `private` key in `about.md` frontmatter, never appears in the agent payload; `profile context` shows `[private: N lines withheld]`.
- Validation failures re-invoke the agent with errors appended, **max 2 retries**, then fail loudly and keep the run workspace.
- Per-agent-call timeout default **10 minutes** (`timeout_minutes` in config).
- Application folder: `<YYYY-MM-DD>-<company-slug>-<role-slug>`; slugs ASCII-transliterated.
- Send-ready PDF filename default pattern: `{First}_{Last}_{Kind}_{Company}` → e.g. `Jordan_Example_Resume_Atlassian.pdf`.
- Platforms: macOS + Linux. Clipboard: `pbpaste` / `wl-paste` / `xclip -selection clipboard -o`.
- Never shell-interpolate: harness commands are argv arrays, spawned without a shell.

## Review Focus

1. **LaTeX-hostile text anywhere in content** (`R&D`, `C#`, `100%`, `$5M`, `snake_case`, `~`, `^`, `\`, `{}`) must render escaped and compile — test in Task 4.
2. **Non-ASCII names** (`José Núñez`, `Zoë`, `Société Générale`) must compile under pdfLaTeX and produce ASCII slugs/filenames — tests in Tasks 4 and 7.
3. **Agent produces no file / invalid JSON / unknown entry IDs** → retry with errors, then a clean failure message naming the kept workspace, exit code 1, no half-created application folder — test in Task 8.
4. **Harness binary missing or exiting non-zero** → classified error (`not_installed`, `auth`, `rate_limit`, `timeout`, `unknown`) with a hint, no stack trace — test in Task 5.
5. **Empty clipboard / thin URL page / data root not initialised** → one-line actionable message, exit code 1, nothing written — tests in Tasks 1 and 6.

---

## File Structure

```
package.json  tsconfig.json  README.md
src/
  cli.ts                     # commander wiring; maps errors to exit codes
  errors.ts                  # UserError (message + hint, exit 1)
  paths.ts                   # data-root resolution + layout constants
  config.ts                  # config.toml load + defaults (Zod)
  commands/init.ts
  profile/schema.ts          # Zod: About, Entry, Skills
  profile/load.ts            # read profile dir, frontmatter split, private stripping
  profile/context.ts         # agent payload + human `show` formatting
  pipeline/schemas.ts        # Zod: ParsedJob, ResumeContent; JSON Schema export
  pipeline/validate.ts       # semantic validation against a Profile
  pipeline/workspace.ts      # run workspace creation
  pipeline/prompts/parse-job.md
  pipeline/prompts/write-resume.md
  pipeline/apply.ts          # orchestration
  render/latex-escape.ts
  render/render.ts           # nunjucks env, deep-escape, template loading
  render/compile.ts          # latexmk + page count
  harness/adapter.ts         # presets, argv expansion, spawn w/ timeout, error classification
  job/intake.ts              # file / clipboard / url → JobSource
  application/slug.ts
  application/store.ts       # create, list, find, versions, filenames
templates/classic/{template.toml,resume.tex.njk,LICENSE}
tests/                       # mirrors src/
tests/fixtures/profile-jordan/   # fictional profile (see Task 2)
tests/fixtures/jobs/backend.md
tests/fixtures/fake-harness.ts   # canned-output harness
```

---

### Task 1: Project scaffold, data root, config, `init`

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/cli.ts`, `src/errors.ts`, `src/paths.ts`, `src/config.ts`, `src/commands/init.ts`
- Test: `tests/paths.test.ts`, `tests/config.test.ts`, `tests/init.test.ts`

**Interfaces:**
- Produces:
  - `class UserError extends Error { constructor(message: string, hint?: string) }`
  - `resolveDataRoot(env?: Record<string,string|undefined>): string` — `RESUMELY_HOME` else `~/resumely`
  - `requireDataRoot(root: string): void` — throws `UserError("No resumely data root at <root>", "Run: resumely init")` if `config.toml` missing
  - `layout(root: string): { config, profile, applications, templates, runs }` (absolute paths; `runs` = `<root>/.runs`)
  - `type Config = { harness: string; template: string; pages: number; timeout_minutes: number; filename: string; adapters: Record<string, AdapterConfig> }` — `AdapterConfig` defined in Task 5; P1 `config.ts` types it as `{ command: string[]; check?: string[] }`
  - `loadConfig(root: string): Config` — defaults: `harness="claude"`, `template="classic"`, `pages=1`, `timeout_minutes=10`, `filename="{First}_{Last}_{Kind}_{Company}"`, `adapters={}` (user entries merge over presets in Task 5)
  - `initDataRoot(root: string): void` — creates `config.toml` (defaults, commented), `profile/{experience,projects,education,extras,voice}/`, `profile/about.md` starter, `profile/skills.yaml` starter, `applications/`, `templates/`, `.runs/`; throws `UserError` if `root/config.toml` already exists
  - CLI: `resumely init` (uses `resolveDataRoot()`), bin name `resumely` → `src/cli.ts`

- [ ] **Step 1: Scaffold** — `bun init`, add deps (`commander zod@^4 smol-toml yaml nunjucks @mozilla/readability linkedom`, dev `@types/nunjucks`), `tsconfig` strict, `"bin": {"resumely": "src/cli.ts"}`, script `"test": "bun test"`.
- [ ] **Step 2: Write failing tests**
  - `resolveDataRoot({RESUMELY_HOME:"/x"}) === "/x"`; `resolveDataRoot({HOME:"/h"}) === "/h/resumely"`
  - `loadConfig(tmp)` on a `config.toml` containing only `pages = 2` returns `pages===2`, `harness==="claude"`, `timeout_minutes===10`
  - `initDataRoot(tmp)` creates all listed paths; a second call throws `UserError`
  - `requireDataRoot(emptyTmp)` throws `UserError` whose `hint === "Run: resumely init"`
- [ ] **Step 3: Run** `bun test tests/paths.test.ts tests/config.test.ts tests/init.test.ts` — Expected: FAIL (modules missing)
- [ ] **Step 4: Implement.** `cli.ts` catches `UserError` → prints `error: <message>` and `hint: <hint>` to stderr, exit 1; other errors print message + "please report", exit 2.
- [ ] **Step 5: Run tests** — Expected: PASS. Manually: `RESUMELY_HOME=$(mktemp -d)/r bun src/cli.ts init && ls -a` shows the layout.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: project scaffold, data root, config, init"` (also commit `design.md` and this plan in this first commit)

---

### Task 2: Profile loading, private stripping, `profile show` / `profile context`

**Files:**
- Create: `src/profile/schema.ts`, `src/profile/load.ts`, `src/profile/context.ts`, `tests/fixtures/profile-jordan/**`
- Modify: `src/cli.ts` (add `profile show [id]`, `profile context`)
- Test: `tests/profile.test.ts`

**Interfaces:**
- Produces:
  - `type About = { name: string; email: string; phone?: string; location?: string; headline?: string; links: {label: string; url: string}[]; body: string }` (frontmatter `private` key removed)
  - `type EntryType = "experience"|"project"|"education"|"award"|"publication"|"volunteering"|"certification"|"other"`
  - `type Entry = { id: string; type: EntryType; title: string; org?: string; location?: string; start?: string; end?: string; url?: string; skills: string[]; tags: string[]; body: string; privateLines: number; file: string }` — `id` matches `/^[a-z0-9][a-z0-9-]*$/`; `start`/`end` are `YYYY-MM` or `end: "present"`
  - `type Skills = Record<string, string[]>` (category → items, from `skills.yaml`)
  - `type Profile = { about: About; entries: Entry[]; skills: Skills; aboutPrivateKeys: number }`
  - `loadProfile(profileDir: string): Profile` — reads `about.md`, `skills.yaml`, all `*.md` under `experience/ projects/ education/ extras/`; throws `UserError` naming the file on frontmatter/schema errors and on duplicate IDs
  - `stripPrivate(body: string): { body: string; privateLines: number }`
  - `buildAgentPayload(p: Profile): object` — `{ about: {name, headline, location, body}, skills, entries: [...without file/privateLines] }` (no email/phone: the agent doesn't need them)
  - `formatProfileContext(p: Profile): string` — pretty JSON of the payload, with each entry that had private content followed by a line `// <id>: [private: N lines withheld]`
  - `formatProfileTree(p: Profile): string` and `formatEntry(e: Entry): string`

- [ ] **Step 1: Create fixture `tests/fixtures/profile-jordan/`** — fictional "Jordan Example" (email `jordan@example.com`). At least: 2 experience entries (one `end: present`, one ending 2022-12 with a gap after), 2 projects (one containing text `R&D`, `C#`, `100%`, `$5M`), 1 education at "Université de Montréal", `skills.yaml` with 3 categories, and one entry with a `## Private` section of 3 lines followed by another `## ` section. `about.md` frontmatter includes `private: { salary: "..." }`.
- [ ] **Step 2: Write failing tests**
  - `loadProfile(fixture).entries.length` equals the fixture count; IDs as authored
  - the private-section entry has `privateLines === 3` and its `body` contains neither the private text nor the `## Private` heading, but still contains the following section
  - `JSON.stringify(buildAgentPayload(p))` contains no fixture private strings, no `jordan@example.com`, no `salary`
  - `formatProfileContext(p)` contains `[private: 3 lines withheld]`
  - duplicate ID across two files → `UserError` mentioning both file paths; invalid `start: "2024"` → `UserError` mentioning the file
- [ ] **Step 3: Run** `bun test tests/profile.test.ts` — Expected: FAIL
- [ ] **Step 4: Implement.** Frontmatter split with `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/` + `yaml.parse`. Private section: from a line matching `/^##\s+Private\s*$/i` up to (not including) the next `/^##\s/` line or EOF.
- [ ] **Step 5: Run tests** — Expected: PASS. Manually: `RESUMELY_HOME=<tmp with fixture copied into profile/> bun src/cli.ts profile context`.
- [ ] **Step 6: Commit** `feat: profile loading, private stripping, profile show/context`

---

### Task 3: Content schemas and semantic validation

**Files:**
- Create: `src/pipeline/schemas.ts`, `src/pipeline/validate.ts`
- Test: `tests/validate.test.ts`

**Interfaces:**
- Consumes: `Profile`, `Entry` (Task 2)
- Produces:
  - `ParsedJob` Zod + type: `{ company: string; role: string; location?: string; seniority?: string; requirements: string[]; nice_to_haves: string[]; keywords: string[]; language: string }`
  - `Bullet = { text: string; entry_ids: string[] (min 1); basis: "direct"|"inferred" }`
  - `ResumeItem = { entry_id: string; heading: string; subheading?: string; location?: string; dates?: string; bullets: Bullet[] }`
  - `ResumeSection = { kind: "experience"|"projects"|"education"|"extras"; title: string; items: ResumeItem[] }`
  - `ResumeContent = { summary?: { text: string; entry_ids: string[] }; sections: ResumeSection[]; skills: { category: string; items: string[] }[]; gaps: { requirement: string; note: string }[] }`
  - `jsonSchemaFor(kind: "parsed-job"|"resume"): object` — via `z.toJSONSchema`
  - `type ValidationResult = { ok: true; value: T } | { ok: false; errors: string[] }`
  - `validateParsedJob(raw: unknown): ValidationResult<ParsedJob>`
  - `validateResume(raw: unknown, profile: Profile, mode: "truthful"): ValidationResult<ResumeContent>` — schema errors formatted as `path: message`; semantic errors: unknown `entry_id`/`entry_ids` → `sections[i].items[j]: unknown entry id "x"`; in truthful mode `basis:"inferred"` → `...bullets[k]: inferred claims are not allowed in truthful mode`; empty `sections` → error

- [ ] **Step 1: Write failing tests** — valid fixture content passes; unknown ID, inferred bullet, missing `entry_ids`, non-object input each fail with the exact error substrings above; `jsonSchemaFor("resume")` has `type: "object"` and `required` containing `"sections"`.
- [ ] **Step 2: Run** `bun test tests/validate.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `feat: content schemas and semantic validation`

---

### Task 4: LaTeX escaping, rendering, `classic` template, compile

**Files:**
- Create: `src/render/latex-escape.ts`, `src/render/render.ts`, `src/render/compile.ts`, `templates/classic/template.toml`, `templates/classic/resume.tex.njk`, `templates/classic/LICENSE`
- Test: `tests/render.test.ts`, `tests/compile.test.ts`

**Interfaces:**
- Consumes: `ResumeContent` (Task 3), `About` (Task 2)
- Produces:
  - `latexEscape(s: string): string`
  - `type TemplateMeta = { id: string; name: string; description: string; engine: "pdflatex"|"xelatex"|"lualatex"; supports: ("resume"|"cover-letter")[]; packages: string[]; dir: string }`
  - `listTemplates(dirs: string[]): TemplateMeta[]` — built-in dir is `<repo>/templates`, then `<dataRoot>/templates` (user overrides same id)
  - `findTemplate(id: string, dirs: string[]): TemplateMeta` — `UserError` listing available ids if missing
  - `renderResume(t: TemplateMeta, data: { about: About; content: ResumeContent }): string` — returns `.tex` source
  - `compileTex(tex: string, engine: TemplateMeta["engine"], opts?: { timeoutMs?: number }): Promise<{ pdf: Uint8Array; pages: number; log: string }>` — throws `UserError("LaTeX compile failed", <first "!" error line from log>)`

- [ ] **Step 1: Write failing tests**
  - `latexEscape` table: `&→\&`, `%→\%`, `$→\$`, `#→\#`, `_→\_`, `{→\{`, `}→\}`, `~→\textasciitilde{}`, `^→\textasciicircum{}`, `\→\textbackslash{}`; `"R&D at 100% for $5M"` → `"R\&D at 100\% for \$5M"`; unicode (`Zoë`) passes through unchanged
  - `renderResume(classic, fixtureData)` output contains `R\&D`, `C\#`, `Jordan Example`, `\pdfgentounicode=1`, and does **not** contain raw `R&D`
  - (compile, guarded by `test.skipIf(!Bun.which("latexmk"))`) compiling the fixture render returns `pages === 1` and a PDF starting with `%PDF`; a content variant with a heading `José Núñez — Société Générale` compiles
  - compiling `\documentclass{article}\begin{document}\undefinedmacro\end{document}` throws `UserError` whose hint contains `Undefined control sequence`
- [ ] **Step 2: Run** `bun test tests/render.test.ts tests/compile.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement escaping + render.** Nunjucks `Environment(new FileSystemLoader(t.dir), { autoescape: false, tags: { blockStart: "((*", blockEnd: "*))", variableStart: "(((", variableEnd: ")))", commentStart: "((=", commentEnd: "=))" } })`. Escape-by-default: deep-map every string in `data` through `latexEscape` before rendering; expose the untouched data as `raw` for templates that explicitly opt in (URLs in `\href` use `raw`). `latexEscape` must be a single-pass character map (so `\` → `\textbackslash{}` isn't re-escaped).
- [ ] **Step 4: Port `classic`.** Base on `resume.tex` from https://github.com/jakegut/resume (MIT): keep its preamble and `\resumeSubheading`/`\resumeItem`/`\resumeProjectHeading` macros; add `\usepackage[utf8]{inputenc}`, `\usepackage[T1]{fontenc}`, `\input{glyphtounicode}` + `\pdfgentounicode=1`; header from `about` (name, phone, email, links); loop `content.sections` (projects use `\resumeProjectHeading` with `heading` + optional `subheading`), then `content.skills` as `\textbf{category}: items` lines. `template.toml`: `id="classic"`, `engine="pdflatex"`, `supports=["resume"]`. `LICENSE`: copy jakegut's MIT text with "Template design adapted from jakegut/resume" line.
- [ ] **Step 5: Implement `compileTex`.** Write `main.tex` into a fresh temp dir; run `latexmk -<pdf|xelatex|lualatex> -interaction=nonstopmode -halt-on-error main.tex` with cwd = temp dir (default timeout 120s); page count from log regex `/Output written on .*?\((\d+) pages?/`.
- [ ] **Step 6: Run tests** — Expected: PASS. Open the fixture PDF once and eyeball it against the Jake's preview.
- [ ] **Step 7: Commit** `feat: latex escaping, nunjucks rendering, classic template, compile`

---

### Task 5: Harness adapters

**Files:**
- Create: `src/harness/adapter.ts`, `tests/fixtures/fake-harness.ts`
- Test: `tests/adapter.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1)
- Produces:
  - `type AdapterConfig = { command: string[]; check?: string[] }` — placeholders `{prompt}`, `{workspace}`, `{model}` substituted per argv element (no shell)
  - `PRESETS: Record<"claude"|"codex"|"pi", AdapterConfig>`:
    - `claude`: `["claude","-p","{prompt}","--permission-mode","acceptEdits","--allowedTools","Read Write Edit Glob"]`, check `["claude","--version"]`
    - `codex`: `["codex","exec","--skip-git-repo-check","-s","workspace-write","-C","{workspace}","{prompt}"]`, check `["codex","--version"]`
    - `pi`: `["pi","-p","--no-session","--tools","read,write,edit","{prompt}"]`, check `["pi","--version"]` (verified in Task 9)
  - `resolveAdapter(name: string, cfg: Config): AdapterConfig` — `cfg.adapters[name]` overrides preset; `UserError` listing known names if neither
  - `type HarnessErrorKind = "not_installed"|"auth"|"rate_limit"|"timeout"|"unknown"`
  - `class HarnessError extends UserError { kind: HarnessErrorKind }`
  - `runHarness(a: AdapterConfig, opts: { workspace: string; prompt: string; timeoutMs: number; model?: string; name: string }): Promise<{ stdout: string; stderr: string; durationMs: number }>` — spawn with `cwd = workspace`; writes `stdout.log`/`stderr.log` into the workspace; on failure throws `HarnessError`
  - `classifyFailure(exitCode: number|null, stderr: string, timedOut: boolean, spawnErrorCode?: string): HarnessErrorKind` — `ENOENT`→`not_installed`; timedOut→`timeout`; `/usage limit|rate.?limit|429|quota/i`→`rate_limit`; `/log ?in|logged out|unauthori[sz]ed|401|auth/i`→`auth`; else `unknown`
  - Hints: `not_installed` → `"Install <bin> or choose another harness with --harness"`; `auth` → `"Log in to <name> (run it interactively once)"`; `rate_limit` → `"Usage limit reached; retry later or use --harness <other>"`; `timeout` → `"Raise timeout_minutes in config.toml"`.
  - `tests/fixtures/fake-harness.ts`: invoked as `bun <path> {workspace}`; reads `FAKE_HARNESS_SCRIPT` env (path to a JSON file `{ "<call-index>": { "<relative out path>": <json or "INVALID"> } }`), tracks call index in `<script>.count`, writes the files for that call (string `"INVALID"` writes `{not json`); env `FAKE_HARNESS_EXIT=1` exits 1 with stderr `"usage limit reached"`.

- [ ] **Step 1: Write failing tests** — placeholder expansion (`{prompt}` inside a larger arg too); config override beats preset; unknown name → `UserError`; `classifyFailure` table for each kind; `runHarness` with command `["definitely-not-a-binary-xyz"]` → `HarnessError` kind `not_installed`; `runHarness` with `["sleep","5"]` and `timeoutMs: 200` → `timeout`; fake harness writes expected file into workspace; `FAKE_HARNESS_EXIT=1` → kind `rate_limit`.
- [ ] **Step 2: Run** `bun test tests/adapter.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** with `Bun.spawn` (kill on timeout).
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `feat: harness adapters with presets, timeout and error classification`

---

### Task 6: Job intake

**Files:**
- Create: `src/job/intake.ts`
- Test: `tests/intake.test.ts`, `tests/fixtures/jobs/backend.md`

**Interfaces:**
- Produces:
  - `type JobSource = { kind: "file"|"clipboard"|"url"; text: string; url?: string; path?: string; html?: string }`
  - `readJobFile(path: string): Promise<JobSource>` — `.md`/`.txt` raw; `.html` → readability text; other → `UserError`
  - `readClipboard(run?: (cmd: string[]) => Promise<string>): Promise<JobSource>` — tries `pbpaste`, `wl-paste`, `xclip -selection clipboard -o` in order; empty/whitespace → `UserError("Clipboard is empty", "Copy the job description text, then rerun")`
  - `fetchJobUrl(url: string, fetchImpl?: typeof fetch): Promise<JobSource>` — readability extraction via linkedom; thin → `UserError("Couldn't read enough of that page (<n> words)", "Copy the job text and run: resumely apply --clip")`
  - `isThin(text: string): boolean` — `< 150` words, or matches `/enable javascript|sign in to view|log in to see/i`
  - `resolveJobInput(arg: string|undefined, opts: { clip?: boolean }): Promise<JobSource>` — `--clip` → clipboard; `http(s)://` → url; existing path → file; nothing → `UserError("No job given", "resumely apply <url|file> or --clip")` (`$EDITOR` mode deferred)
- `tests/fixtures/jobs/backend.md`: a realistic ~300-word backend SWE posting for a fictional company "Atlas Freight" (requirements include TypeScript, Postgres, AWS, and Go — the fixture profile lacks Go).

- [ ] **Step 1: Write failing tests** — file read; `.pdf` → `UserError`; clipboard with stub runner returning `"  "` → `UserError` "Clipboard is empty"; `isThin` true for 20 words and for a 300-word text containing "Please enable JavaScript"; `fetchJobUrl` against a local `Bun.serve` serving an HTML page wrapping `backend.md` returns text containing "Atlas Freight"; serving a 30-word page → thin `UserError`.
- [ ] **Step 2: Run** `bun test tests/intake.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `feat: job intake from file, clipboard and url`

---

### Task 7: Application store

**Files:**
- Create: `src/application/slug.ts`, `src/application/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `layout()` (Task 1), `ParsedJob` (Task 3), `JobSource` (Task 6)
- Produces:
  - `slugify(s: string, max = 40): string` — NFKD, strip combining marks, lowercase, non-`[a-z0-9]` runs → `-`, trim `-`, cut at `max` without trailing `-`; empty result → `"unknown"`
  - `sendReadyName(pattern: string, about: {name: string}, kind: "Resume"|"Cover_Letter", company: string): string` — `{First}` = first word of name, `{Last}` = last word, `{Company}` = company transliterated with non-alnum removed (`"AT&T"` → `"ATT"`, `"Société Générale"` → `"SocieteGenerale"`); all ASCII; returns `<…>.pdf`
  - `type ApplicationMeta = { company: string; role: string; created: string /*ISO*/; status: "drafted"|"applied"|"interviewing"|"rejected"|"offer"; notes: string[]; source: { kind: string; url?: string } }`
  - `type Application = { dir: string; slug: string; meta: ApplicationMeta }`
  - `createApplication(appsDir: string, job: ParsedJob, src: JobSource, now?: Date): Application` — dir `<YYYY-MM-DD>-<slugify(company)>-<slugify(role)>`, suffix `-2`, `-3` on collision; writes `application.toml`, `job/raw.md` (source text), `job/source.html` if present, `job/parsed.json`
  - `listApplications(appsDir: string): Application[]` — newest first by `created`
  - `findApplication(appsDir: string, query: string): Application` — exact slug match wins; else case-insensitive substring on slug/company/role; 0 → `UserError("No application matches \"q\"", "resumely ls")`; >1 → `UserError` listing the matching slugs
  - `nextVersionDir(app: Application, kind: "resume"|"cover-letter"): { dir: string; version: number }` — creates `<kind>/v<N>/`
  - `latestVersion(app: Application, kind): { dir: string; version: number } | null`

- [ ] **Step 1: Write failing tests** — `slugify("Société Générale")==="societe-generale"`; `slugify("AT&T")==="at-t"`; `slugify("🚀")==="unknown"`; `sendReadyName("{First}_{Last}_{Kind}_{Company}", {name:"José Núñez"}, "Resume", "Société Générale") === "Jose_Nunez_Resume_SocieteGenerale.pdf"`; create twice same day → second dir ends `-2`; list order; find exact/substring/ambiguous/none; `nextVersionDir` gives v1 then v2.
- [ ] **Step 2: Run** `bun test tests/store.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `feat: application store, slugs and send-ready filenames`

---

### Task 8: `apply` pipeline, prompts, `ls` / `open` / `render`

**Files:**
- Create: `src/pipeline/workspace.ts`, `src/pipeline/prompts/parse-job.md`, `src/pipeline/prompts/write-resume.md`, `src/pipeline/apply.ts`
- Modify: `src/cli.ts` (add `apply`, `ls`, `open`, `render`)
- Test: `tests/apply.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `createRunWorkspace(runsDir: string, step: "parse"|"write"): string` — `<runs>/<timestamp>-<rand>/<step>/` with `out/`
  - `runAgentStep<T>(opts: { adapter: AdapterConfig; name: string; workspace: string; instructions: string; files: Record<string,string>; outFile: string; validate: (raw: unknown) => ValidationResult<T>; timeoutMs: number; maxRetries?: number /*2*/ ; onProgress?: (msg: string) => void }): Promise<T>` — writes `instructions.md` + `files`; prompt is `"Read instructions.md in the current directory and follow it exactly. Write only the files it asks for."`; after each call reads `out/<outFile>`; missing file / JSON parse error / validation errors → writes `errors.md` (bullet list) and appends `"\n\nYour previous attempt was rejected. Read errors.md and fix every issue."` to the prompt; after `maxRetries` retries throws `UserError("Agent output invalid after 3 attempts", "Inspect <workspace>")`
  - `applyJob(opts: { root: string; input: JobSource; harness?: string; template?: string; open?: boolean; onProgress?: (m: string) => void }): Promise<{ app: Application; pdfPath: string; pages: number }>` — order: load config + profile → parse step (`files`: `job.md`, `parsed-job.schema.json`) → `createApplication` → write step (`files`: `profile.json` = `buildAgentPayload`, `job.md`, `parsed-job.json`, `resume.schema.json`; instructions include `pages` target) → render → compile → write version dir: `resume.json`, `resume.tex`, `<sendReadyName>`, `trace.json` (`[{ section, item, bullet, text, entry_ids, basis }]` flattened from content), `entries.snapshot.json` (only referenced entries), `meta.json` (`{ template, harness, mode: "truthful", pages, created, run }`). Gaps printed at the end. If compile reports `pages > config.pages`, print a warning (reviewer loop that fixes this is P2). Application folder is only created after a valid parse.
  - CLI:
    - `resumely apply [input] [--clip] [--harness <n>] [--template <id>] [--no-open]` — progress lines to stderr (`parsing job…`, `writing resume (claude)…`, `compiling…`, `done: <pdf path>`)
    - `resumely ls` — columns `DATE  COMPANY  ROLE  STATUS  RESUME` (latest `vN` or `-`)
    - `resumely open <app> [--version N]` — `open` (macOS) / `xdg-open`
    - `resumely render <app> [--version N] --template <id>` — re-renders that version's `resume.json` into a **new** version dir (no agent call), copying the snapshot and trace
- Prompts (exact requirements; wording is the implementer's):
  - `parse-job.md`: read `job.md`; write `out/parsed-job.json` valid against `parsed-job.schema.json`; `keywords` = concrete skills/tools/domains; `language` = ISO 639-1.
  - `write-resume.md`: read `profile.json`, `job.md`, `parsed-job.json`; write `out/resume.json` valid against `resume.schema.json`. Rules copied from design §2 truthful mode verbatim (may select/reorder/rephrase/emphasise/mirror JD keywords; may not invent skills, employers, titles, dates, metrics or credentials). Every bullet cites `entry_ids` from `profile.json`; `basis` always `"direct"`. Do not output name/contact (filled by the system). Target `{{pages}}` page(s): ~3–5 bullets for recent roles, fewer for older. List unsupported JD requirements in `gaps`. Bullets start with a strong past-tense verb (present tense for current roles), no first person.

- [ ] **Step 1: Write failing e2e tests** (fake harness via config `adapters.fake.command = ["bun", "<abs path>/tests/fixtures/fake-harness.ts", "{workspace}"]`, data root in a temp dir with the Jordan profile; compile tests `skipIf(!latexmk)`):
  - happy path: `applyJob` with `backend.md` → app dir `*-atlas-freight-*`; `resume/v1/` contains `resume.json`, `resume.tex`, `Jordan_Example_Resume_AtlasFreight.pdf`, `trace.json`, `entries.snapshot.json`, `meta.json`; `meta.mode === "truthful"`; snapshot contains only referenced IDs
  - retry: call 2 (write) returns `"INVALID"`, call 3 returns valid → succeeds; `errors.md` exists in the write workspace
  - unknown entry id on all write attempts → `UserError` "after 3 attempts"; `applications/` contains the app (parse succeeded) but no `resume/v1/resume.json`
  - invalid parse output on all attempts → no application dir created at all
  - `render` with `--template classic` on v1 → v2 created with identical `resume.json`
  - `findApplication(…, "atlas")` resolves; `ls` output contains `Atlas Freight` and `v1`
- [ ] **Step 2: Run** `bun test tests/apply.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement workspace + `runAgentStep`** — Expected: retry tests can now pass
- [ ] **Step 4: Implement `applyJob` + prompts + CLI commands**
- [ ] **Step 5: Run the full suite** `bun test` — Expected: all PASS
- [ ] **Step 6: Commit** `feat: apply pipeline with retrying agent steps, ls/open/render`

---

### Task 9: Real-harness verification and README

**Files:**
- Modify: `README.md`, `src/harness/adapter.ts` (only if a preset needs fixing)

- [ ] **Step 1:** With a temp data root containing the Jordan fixture profile: `RESUMELY_HOME=<tmp> bun src/cli.ts apply tests/fixtures/jobs/backend.md --harness claude --no-open` — Expected: exit 0, a 1-page PDF; `gaps` mentions Go. Open the PDF and check it reads like a real resume.
- [ ] **Step 2:** Same with `--harness codex` — Expected: exit 0.
- [ ] **Step 3:** Verify pi: `pi --list-models` / `pi auth check --provider <configured>`; run with `--harness pi`. If the tool-name list or flags differ, fix the `pi` preset; if pi has no authenticated provider, record that in README as "requires a configured provider" and do not block.
- [ ] **Step 4:** README: install (`bun install`, `bun link`), prerequisites (Bun, TeX Live/latexmk, one harness), quickstart (`init` → edit `profile/` → `apply --clip` → `ls`/`open`), profile file format with an example entry including a `## Private` section, adapter config example.
- [ ] **Step 5: Commit** `docs: README quickstart; verify harness presets`
