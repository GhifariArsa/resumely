# Design — resumely (agent-driven resume & cover letter tailoring CLI)

_Interview held 2026-11-09 – 2026-11-10. Spec: inline brief from `/interview` invocation (see "Original brief" below)._

## Original brief
1. Create tailored resumes.
2. The system knows about me (skills, current projects, what I'm working on, experience, …) — sourced from an existing resume or by interview.
3. Pluggable agent harness (Claude Code, pi, Codex), using my existing subscriptions.
4. Simple way to see and organise generated resumes.
5. Resumes generated in LaTeX from professional templates; a few to choose from.
6. Cover letter generator.
7. Smooth flow: job application → system → generated documents → view quickly.
8. A way to view what the system knows about me, for debugging.
9. Anything else important.

## 1. Problem framing & scope
**Decision:** A local-first CLI, built primarily for the author but installable by anyone. It turns a job posting plus a stored personal profile into a tailored LaTeX resume and cover letter, using whatever agent harness the user already pays for. There is no hosted server; an optional local web viewer is allowed.
**Reasoning:** A single user with personal data argues for files on disk. Making it installable costs little if personal data stays out of the tool's source tree.
**In scope (v1):** profile building, job intake, tailored resume + cover letter generation, organising/viewing outputs, profile inspection, light application tracking (manual `status` field).
**Out of scope:** auto-submitting applications; job search/scraping; heavy tracking (reminders, email integration, CRM); any hosted/multi-tenant service.

## 2. Requirements & constraints
- **Truthful by default** [self-imposed]. The agent may select, reorder, rephrase, emphasise and mirror JD keywords. It may not invent skills, employers, titles, dates, metrics or credentials. Every generated bullet traces to a profile entry, and the trace is stored with the output.
- **Gap flagging** [self-imposed]. JD requirements not supported by the profile are omitted and reported as gaps, so the user can add them to the profile if they're true.
- **Stretch mode (opt-in)** [self-imposed]. Allows *inference* (skills evidenced but not listed, stronger verbs where supported, heavier foregrounding). Never allows new employers/titles/dates/degrees/certs or numeric metrics. Every stretched claim is tagged `inferred` in the trace and surfaced for review.
- **Platforms** [self-imposed]: macOS + Linux. Windows via WSL, not targeted.
- **LaTeX** [self-imposed]: requires a local TeX distribution (`latexmk`). Clear install hint if missing; TeX is not bundled.
- **Privacy** [self-imposed]: profile data leaves the machine only via the user-chosen harness. No telemetry. Resumely's own network use is limited to fetching job URLs. The agent's company-research step (§8) uses the harness's web tools and sends only company/role, never profile data.
- **Portability** [self-imposed]: all state is plain, human-readable, git-trackable files. No opaque DB as source of truth.
- **Speed** [self-imposed]: minutes-scale end-to-end is acceptable. Show progress while the agent works. Optimise for quality, not latency.

## 3. Domain model
**Decision:** Six entities: Profile (made of Entries), Job, Application, Document, Template, Harness. One Job maps to exactly one Application, and iterations are Document versions within it. Each Document version freezes the subset of profile entries it used.
**Reasoning:** The Application is the natural thing the user organises around (which version went to whom, what happened). Freezing entries per version makes every output reproducible and its trace valid after later profile edits, without requiring git.
**Rejected:** Relying on git history for profile provenance (git-trackable ≠ git-required). Multiple Applications per Job (comparisons are handled by versions).

- **Profile**: the user's full knowledge base. A collection of **Entries**.
- **Entry**: one atomic fact-bearing unit (experience, project, education, skill, award, publication, …) with a **stable ID**. IDs persist across edits.
- **Job**: an immutable snapshot of a posting taken at intake: raw source (URL/text/file) plus parsed fields (company, role, requirements, keywords).
- **Application**: Job + its Documents + `status` (`drafted → applied → interviewing → rejected | offer`, manual) + notes + `sent_version` per document kind (recorded when marked `applied`).
- **Document**: a generated artifact of kind `resume` | `cover-letter`, versioned (`v1`, `v2`, …) within an Application. Each version stores content JSON, `.tex`, `.pdf`, trace, final HR review, check results, template ID, frozen entries snapshot, mode (`truthful` | `stretch`).
- **Template**: a selectable LaTeX design.
- **Harness**: an agent backend adapter (claude / codex / pi / …).

## 4. Agent harness integration
**Decision:** Resumely drives the harness (mode A). A deterministic core CLI owns all files, rendering, validation and listing, and invokes the harness headless through a **file-based workspace contract**. The only interactive use is `resumely interview`, a thin launcher that opens the chosen harness interactively with preloaded instructions to propose profile entries via `resumely profile add …`, which writes to the review inbox (§6), never the live profile.
**Reasoning:** The main use case is one-shot "job in → PDFs out". Files are the one I/O channel every harness supports reliably, unlike per-harness structured-stdout flags, and they leave an inspectable workspace for debugging. The interview is rare, so a custom chat loop isn't worth building.
**Rejected:** Mode B as primary (resumely as a toolkit living inside the agent). Resumely-owned multi-turn chat loop via session resume (complexity, fragile per-harness resume semantics).

**Contract (per generation run):**
1. Create a workspace with `profile.json`, `job.md`, `instructions.md` (task + truthfulness/stretch rules), `output.schema.json`.
2. Invoke the harness headless with cwd = workspace, writes sandboxed to it (e.g. `claude -p --permission-mode acceptEdits`, `codex exec --sandbox workspace-write`, `pi -p`). Network/web tools are enabled only for the research step (§8). Exact flags are to be verified per harness version (see Open questions).
3. Agent writes `out/*.json` (content + trace).
4. Resumely validates schema + semantics (trace IDs exist, mode rules respected). On failure it re-invokes with errors appended, **max 2 retries**, then fails loudly and keeps the workspace.

**Adapters:** defined in config as a command template with placeholders (`{workspace}`, `{prompt_file}`, optional `{model}`) plus an installed/auth check. Built-in presets: `claude`, `codex`, `pi`. A default harness is set in config; `--harness <name>` overrides per run.

## 5. Architecture & tech stack
**Decision:** TypeScript on Bun, distributed via npm (`npm i -g resumely` / `bunx resumely`) and as a `bun build --compile` binary. All user data lives in one visible **data root**, default `~/resumely/`, created by `resumely init [dir]` and overridable via `RESUMELY_HOME`.
**Reasoning:** The heavy lifting (PDF parsing, writing) goes to the harness and LaTeX compiling shells out to `latexmk`, so the core is file I/O, validation (Zod → JSON Schema for the contract), templating and subprocesses. One language covers both the CLI and the optional local viewer. The data root is visible because the user browses it (Finder, git), and hiding it works against organising and debugging.
**Rejected:** Python + uv (splits the stack if the viewer is JS, and its parsing advantage is moot since the agent parses). Hidden `~/.resumely` / XDG paths.

**Data root layout:**
```
~/resumely/
  config.toml                 # default harness, default template, adapters
  profile/                    # Entries (format: §6)
  applications/
    <YYYY-MM-DD>-<company>-<role>/
      application.toml        # status, dates, notes, sent_version
      job/                    # raw snapshot, parsed.json, company.md
      resume/v<N>/            # resume.json, .tex, send-ready .pdf, trace.json,
                              # review.json, checks.json, entries.snapshot.json, meta.json
      cover-letter/v<N>/      # same shape
  templates/                  # user custom templates (built-ins ship with the tool)
  .runs/<run-id>/             # agent workspaces + state.json checkpoints (§12)
```

## 6. Profile (knowledge base): ingestion, storage, inspection
**Decision:** The profile is stored as one Markdown file per Entry, with YAML frontmatter for structured, traceable fields and a free-form body for rich context. All ingestion (imports and the interview) goes through a staged inbox that requires review. Inspection is split into "what's stored" vs "what the agent sees".
**Reasoning:** Frontmatter gives traceable structure; the narrative body powers cover letters and stretch inference. Per-entry files give clean diffs and stable IDs. Staged review stops a single bad import from silently poisoning every future document.
**Rejected:** JSON Resume as the storage format (rigid, no narrative context, one giant file); it may be offered later as an export. Direct writes into `profile/` (makes git effectively required for safety).

**Storage:**
```
profile/
  about.md          # name, contact, links, headline, career goals, preferences
  experience/*.md
  projects/*.md
  education/*.md
  skills.yaml
  extras/*.md       # awards, publications, volunteering, certs
  voice/            # 1–3 writing samples, style reference for cover letters (§8)
  .inbox/           # staged proposals awaiting review
```
Frontmatter: `id`, `type`, type-specific fields (`org`, `title`, `start`, `end`, …), `skills`, `tags`. Body: resume-ready bullets + "context/stories" section (not resume-ready, used for cover letters and inference).

**Ingestion:**
- `resumely profile import <file|url>`: resume PDF/DOCX/MD, LinkedIn PDF export, GitHub/personal site URL. Headless. The agent receives the existing profile and proposes new entries, updates to existing IDs, and possible duplicates.
- `resumely interview`: interactive harness session (§4); writes proposals to the same inbox.
- `resumely profile review`: diff-based accept/edit/reject per proposal.

**Inspection (debugging):**
- `resumely profile show [id]`: tree summary or full entry.
- `resumely profile context`: the exact payload the agent receives (ground truth for debugging).
- `resumely profile lint`: deterministic checks (missing/impossible dates, outcome-less bullets, duplicate skills, parse errors, never-used entries).
- `resumely trace <application> [--version N]`: bullet → Entry IDs (`direct`/`inferred`) + gaps.

## 7. Job intake
**Decision:** `resumely apply` accepts a URL, clipboard (`--clip`), a file, or `$EDITOR` paste. Resumely itself fetches the posting and saves an immutable raw snapshot before any agent runs. The run then goes straight through (parse → generate resume + cover letter → compile → open PDFs) with no prompts except a duplicate guard.
**Reasoning:** Many job boards are login-walled or JS-rendered, so clipboard paste is the always-works path. Snapshotting before generation means the Job survives postings being taken down and failed runs. Running straight through is what makes the flow fast; a wrong parse is cheap to fix afterwards.
**Rejected:** URL-only intake (fails on LinkedIn/Workday). Mandatory confirmation step (friction on the common path).

- **URL fetch:** plain HTTP + readability extraction. If the result is thin (< ~150 words, login wall, "enable JavaScript"), report it and fall back to paste.
- **Clipboard:** `pbpaste` / `wl-paste` / `xclip`.
- **Parsing:** the agent's first step writes `job/parsed.json` (company, role, location, requirements, nice-to-haves, keywords). The folder name is derived from it; `resumely mv <app> --company X --role Y` fixes misparses.
- **Duplicate guard:** on a URL or company+role match, ask: new version in the existing Application, or a new Application.
- **Flags:** `--no-cover`, `--review` (pause to show parsed job + gaps before generating), `--template <id>`, `--harness <name>`, `--stretch`.
- **Deferred (post-v1):** browser extension / "send tab to resumely".

## 8. Tailoring & generation (resume + cover letter)
**Decision:** The agent writes **structured content JSON, never LaTeX**. Resumely renders it deterministically into the chosen template. Generation is a **writer → reviewer loop**: a separate HR/recruiter-persona agent critiques the compiled PDF against the JD, and the writer revises, up to 2 review rounds. A one-time company-research step grounds cover letter specifics.
**Reasoning:** Content JSON makes templates swappable without an agent call, removes LaTeX escaping failures, makes the trace structural and enables validation. A reviewer that sees the actual rendered PDF (not the profile) catches what a recruiter would: length, relevance, buried keywords, weak bullets. Exact page facts let the reprompt fix page fit.
**Rejected:** Agent-written LaTeX (escaping/compile failures, templates not swappable). Deterministic priority-based bullet trimming (the user preferred a reviewer-driven reprompt, which also improves quality, not just length).

**Pipeline per `apply`:**
1. **Parse** JD → `job/parsed.json` (§7).
2. **Research** (default on, `--no-research`): the agent uses the harness's own web tools → `job/company.md` with source URLs. Done once per Application and reused across versions. Only the company/role go to search, never the profile. Requires network for this step only.
3. **Write**: the writer agent → `resume.json` / `cover-letter.json`. Every bullet/claim carries `entry_ids` + `direct|inferred`; company facts must cite a URL in `company.md`.
4. **Validate**: schema, trace IDs exist, mode rules, banned phrases (cover letter). Failures → re-invoke the writer (counts against the retry budget, §4).
5. **Render + compile** (§9), then compute **hard facts**: page count, over/underflow, JD keywords present/missing in extracted PDF text.
6. **Review**: HR-persona agent gets PDF + JD + hard facts (not the profile) → `review.json`: 6-second-skim impression, scores (relevance, keyword coverage, bullet impact, formatting/length), red flags, concrete revision requests, `verdict: pass|revise`.
7. On `revise` or a wrong page count → writer re-invoked with review + hard facts → back to 5. Stop on `pass` or after `max_review_rounds` (default 2). The final `review.json` is stored with the version. `--no-review` skips 6–7.
- **Guardrail:** reviewer requests that can't be met truthfully become **gaps**, never fabrications. Validator rules still apply to every revision.
- **Length:** `pages = 1` default in config, `--pages N` per run. Cover letter is always 1 page, ~250–350 words.

**Cover letter voice:**
- `profile/voice/`: 1–3 samples of the user's real writing (style reference only, not content). Optional, prompted during `init`.
- Banned-phrase list (default + user-extendable in config), enforced by the validator ("thrilled", "passionate about", "leverage", "I am writing to express", "delve", "fast-paced environment", …).
- Structure: company/role-specific opening → 2 evidence paragraphs built from Entry context/stories → short concrete close.
- Reviewer adds a rubric item: "does this read as templated/AI-written?"

## 9. LaTeX templates & rendering
**Decision:** Ship four single-column templates, each with a matching cover-letter design, re-implemented as resumely templates with original licence notices preserved. A template is a self-contained directory rendered with Nunjucks using LaTeX-safe delimiters and escape-by-default. User templates in `~/resumely/templates/` are supported in v1.
**Reasoning:** Single-column is the consistent ATS-safe recommendation. The four cover tech-standard, polished, conservative and plain registers (previewed and approved 2026-11-10 from real compiles). Directory templates let anyone add a design without touching code, and centralised escaping kills the most common LaTeX failure.
**Rejected:** Two-column templates (Deedy, AltaCV) as ATS-hostile. TypeScript render functions per template (adding a template would require writing code). Agent-written LaTeX (§8).

| ID | Based on | Licence | Engine | Feel |
|---|---|---|---|---|
| `classic` (default) | Jake's Resume (`jakegut/resume`, from `sb2nov/resume`) | MIT | pdfLaTeX | Dense, small caps section rules; tech standard |
| `modern` | Awesome-CV (`posquit0/Awesome-CV`) | LPPL 1.3c | LuaLaTeX (fontawesome5) | Accent colour, polished, paired cover letter |
| `traditional` | McDowell CV (`dnl-blkv/mcdowell-cv`) | MIT | XeLaTeX | Serif, conservative |
| `minimal` | moderncv `banking` style | LPPL | pdfLaTeX | Sans, clean, icon contact line |

**Template directory:**
```
templates/<id>/
  template.toml        # id, name, description, engine, required packages,
                       # supports [resume, cover-letter], fonts
  resume.tex.njk
  cover-letter.tex.njk
  preview.png          # generated from a fixture profile
  LICENSE
```
- Nunjucks delimiters: `((* … *))` logic, `((( … )))` output. All output is LaTeX-escaped unless a template explicitly opts into raw.
- All templates set `\pdfgentounicode=1` (or engine equivalent) for machine-readable text.
- `resumely templates list` (built-in + user, with previews) and `resumely templates new <id> --from <base>`.
- `resumely render <app> [--version N] --template <id>` re-renders existing content JSON with no agent call.
- Compilation: `latexmk` with the engine from `template.toml`. Build files are kept out of the version folder; only `.tex` and `.pdf` are retained.

## 10. Organising & viewing outputs
**Decision:** Both a CLI and an on-demand local web viewer (`resumely ui`) ship in v1. The viewer is mostly read-only (writes limited to status, notes, re-render). PDFs get send-ready filenames and metadata, and marking an Application `applied` pins which version was sent.
**Reasoning:** Organising, the quick-view flow and debugging are visual tasks (PDFs, version comparison, traces), so the CLI alone undersells them. Keeping profile editing out of the UI keeps files + `profile review` as the single edit path. Version pinning answers "what exactly did this company see?".
**Rejected:** CLI-only v1. A full editing UI (a second source of truth for profile edits).

**CLI:**
- `resumely ls [--status S] [--company X]`: table of date, company, role, status, latest/sent versions, template.
- `resumely open <app> [--cover] [--version N]`: open the PDF in the system viewer (`apply` calls this at the end).
- `resumely status <app> <status>`, `resumely note <app> "…"`. Setting `applied` records `sent_version` for each document kind.
- `resumely export <app> [--version N] [--to DIR]`: copy the send-ready resume + cover letter pair.
- `<app>` arguments accept fuzzy matches on company/role/folder.

**`resumely ui`** (localhost, started on demand, no daemon):
- Applications board (list/kanban by status).
- Application view:
  - PDF preview + version switcher
  - trace panel (hover bullet → source Entry)
  - gaps
  - HR review
  - template switcher (re-render)
  - status/notes editing
  - reveal/copy files
- Profile view:
  - browse Entries with where each was used
  - `profile context` dump
  - lint results

**Output naming:** version PDFs are written as `{First}_{Last}_{Kind}_{Company}.pdf` (pattern configurable). PDF metadata (title, author, subject) is set from the profile and job.

## 11. Quality checks & evaluation
**Decision:** Deterministic checks run on every compiled PDF and feed the reviewer's hard facts. The ATS parse check and the fabrication scanner are gates; keyword coverage is informational. The tool itself is tested with LLM-free unit tests plus an opt-in, subscription-backed eval harness over fixtures.
**Reasoning:** The reviewer and the trace are both LLM-produced and can be wrong. Deterministic checks are the backstop: text extraction catches template bugs, and the scanner catches bullets whose content doesn't match their cited Entry. Evals make prompt and harness changes measurable.

**Per-PDF checks:**
1. **ATS parse check (gate).** `pdftotext` → name/email/phone extractable, all section headings in reading order, no garbled glyphs (broken ligatures, `�`), every bullet present as continuous text. A failure blocks the version from being marked ready.
2. **Fabrication scanner (gate in truthful, warn in stretch).** Every number/metric and capitalised proper noun in the generated text must appear in the cited Entries or `company.md`. Unsourced tokens are flagged in `trace` and the UI.
3. **Keyword coverage (informational).** JD must-haves are classified as present / absent-but-in-profile (missed opportunity, passed to the reviewer) / absent-and-not-in-profile (gap).

**`resumely doctor`:** harnesses installed + authenticated; `latexmk` + required engines; per-template required packages; `pdftotext`; data-root integrity.

**Testing resumely:**
- **Fixtures:** fictional profile ("Jordan Example", ~12 entries: employment gap, current role, overlapping projects, career switch, non-ASCII names, LaTeX-hostile text like `R&D`, `C#`, `100%`, `$5M`) + ~5 JDs (backend, frontend, data, non-tech PM, one deliberately mismatched for gap handling).
- **`bun test`** (no LLM): escaping, render + compile every template, ATS check, fabrication scanner, trace validator, file layout.
- **`bun run eval`** (opt-in, uses subscription): full pipeline per harness → gates passed, fabrication flags, reviewer score, review rounds used, wall time.

## 12. Edge cases & failure modes
**Decision:** Runs are checkpointed per pipeline step and resumable, optionally on a different harness. Harness errors are classified with actionable hints, and there is no automatic harness fallback by default. Private profile content is stripped from agent payloads entirely.
**Reasoning:** Subscription usage caps and expired logins are the most likely failures, and a run spans 4–7 agent calls, so losing progress is costly. Switching harnesses is the main payoff of pluggability but should be deliberate, since it changes voice. Stripping is the only reliable way to keep sensitive notes out of documents; instructions to "not use" them can fail.

**Harness failure:**
- Every step (parse → research → write → review N → revise) writes outputs + `state.json` to `.runs/<run-id>/` before advancing.
- `resumely resume [run-id] [--harness X]` continues from the last completed step (default: most recent failed run).
- Adapter error classes: `auth` | `rate_limit` | `timeout` | `invalid_output` | `unknown`, each with a specific hint.
- Opt-in `fallback_harnesses = [...]` in config; off by default.
- Per-call timeout, default 10 min.

**Content edge cases:**
- **Thin profile:** never pad. The reviewer flags underflow; suggest `resumely interview --focus <gaps>`.
- **Non-English JD:** English-only v1; detect and warn.
- **Multi-role posting:** parse the most prominent role, record the rest; `--role` overrides.
- **Agency/confidential client:** company = "Confidential (via <agency>)", folder from agency + role, research skipped.
- **Unknown hiring manager:** "Dear Hiring Team"; never guess a name.
- **Profile edited mid-run:** the run reads a snapshot at start.
- **Concurrent runs:** safe (separate run dirs, profile read-only during generation).
- **Awkward company names:** ASCII-transliterated folder slugs; display names keep the original, LaTeX-escaped.

**Private content:** a `## Private` heading in any entry body, or a `private:` block in `about.md`, is stripped from the agent payload. `profile context` shows `[private: N lines withheld]`. Facts the agent should use (e.g. work rights) go in non-private fields in sanitised form.

## Terminology
- **Profile / Entry**: the knowledge base, and one atomic stable-ID item in it.
- **Job**: an immutable posting snapshot. **Application**: Job + Documents + status.
- **Document version**: one generated resume or cover letter (`v1`, `v2`, …) inside an Application.
- **Trace**: per-bullet/claim mapping from generated text to Entry IDs, with a tag `direct` | `inferred`.
- **Gap**: a JD requirement with no supporting Entry.
- **Truthful mode / Stretch mode**: generation policies (see §2).
- **Data root**: the user's resumely directory (default `~/resumely/`). Distinct from the tool's source repo.
- **Harness / adapter**: an agent CLI (claude, codex, pi) / the config entry that tells resumely how to invoke and health-check it.
- **Run**: one execution of the pipeline, checkpointed in `.runs/<run-id>/`, resumable.
- **Writer / Reviewer**: the two agent roles in generation. The writer produces content JSON from the profile; the reviewer (HR persona) critiques the rendered PDF without seeing the profile.
- **Hard facts**: deterministic measurements of a compiled PDF (page count, over/underflow, keyword presence, check results) given to the reviewer and writer.
- **Sent version**: the Document version pinned when an Application is marked `applied`.

## Open questions / deferred decisions
- **Verify headless flags per harness** — confirm current non-interactive, sandbox and permission flags for `claude`, `codex`, `pi` (and how each exposes web tools for research). *Trigger:* first task of implementation, before writing adapters.
- **`modern` template dependency** — **Resolved:** fontawesome5 from stock TeX Live; no vendoring (`fontawesome6` is not in stock TeX Live, so `modern` does not use it). `doctor` checks that the package is installed.
- **DOCX output** — some application portals require Word files. Deferred from v1; revisit if a real application needs it (likely via pandoc from content JSON, not from LaTeX).
- **Screening-question answers** — `resumely answer <app> "Why do you want to work here?"` using the same profile, research and trace rules. Strong post-v1 candidate.
- **Browser extension / "send tab to resumely"** — post-v1 (§7).
- **Starting applications from `resumely ui`** (paste box + progress) — post-v1; v1 UI is mostly read-only.
- **JSON Resume export** — post-v1 (§6).
- **Non-English JDs/output** — English-only v1 (§12).
- **User-overridable prompts** — whether writer/reviewer/parse prompts live in the data root for customisation or ship fixed with the tool. *Trigger:* after the first `bun run eval` baseline exists.
