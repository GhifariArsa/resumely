# resumely P4 — Profile Building Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new user can go `resumely init` → `resumely profile import resume.pdf` → `resumely profile review` → `resumely apply`. Agents never write the live profile: `profile import` (headless) and `resumely interview` (interactive harness calling `resumely profile add`) stage proposals in `profile/.inbox/`, and `profile review` accepts, edits, rejects or skips them. `profile lint` and `trace` make the profile and the outputs debuggable.

**Architecture:**
- **Inbox.** Proposals are JSON files in `profile/.inbox/` that resumely itself writes. An agent only produces JSON in its workspace (import) or calls `resumely profile add` (interview). Accepting a proposal renders a Markdown entry file deterministically into the live profile, keeping any `## Private` sections the agent never saw.
- **Import.** Import reuses `runAgentStep` (workspace contract, zod schema, validator, max 2 retries). Its validator checks the proposals against the deterministically extracted source text with `scanClaims`.
- **Interview.** The interview is a thin launcher. It spawns the harness's `interactive_command` with inherited stdio and a prepared workspace.
- **Read-only reports.** `lint` and `trace` are pure library functions (other phases rely on their contracts) with thin CLI wrappers.

**Tech Stack:** As in P1/P2 (Bun, TypeScript strict, commander, zod v4, `yaml`, `smol-toml`, `@mozilla/readability` + `linkedom`). Runtime tools:
- `pdftotext` (poppler): required for PDF import.
- DOCX import uses the first available of `textutil` (macOS), `pandoc` or `unzip`.
- No new npm dependencies.

**Spec:** `design.md`. Read §2, §3, §4, §6, §10 and §12 before starting any task. The P1 and P2 plans (`docs/superpowers/plans/2026-11-10-resumely-p1-vertical-slice.md`, `…-p2-generation-core.md`) explain the existing modules.

**Out of scope:**
- P3: templates, `doctor`, checkpoint/`resume` of runs. Import and interview runs are not resumable.
- P5: `resumely ui`.
- JSON Resume export.

**Parallel work:** P3 is implemented at the same time and also edits `src/cli.ts`, `src/config.ts` and `src/harness/adapter.ts`. In this plan:
- edits to `src/cli.ts` are additive command blocks plus at most 3 lines in the existing `init` and `apply` actions
- `src/config.ts` gets exactly one new optional field
- `src/harness/adapter.ts` is **not modified**: the interactive presets live in `src/profile/interview.ts`

## Global Constraints

- **Agents write JSON only, never the live profile.** Nothing under `profile/` except `profile/.inbox/` is written by any code path an agent triggers. Only `profile review` (a human decision) writes entry files, `skills.yaml` or `about.md`.
- **Harness commands are argv arrays and never pass through a shell.** This covers the interactive command and `$EDITOR`. `$EDITOR`/`$VISUAL` is split on whitespace, never passed to a shell.
- **Data root** is `RESUMELY_HOME` if set, else `~/resumely/` (`resolveDataRoot`).
- **Private content never reaches an agent payload.**
  - The import and interview workspaces get `buildAgentPayload(profile)`, which already strips `## Private` and `about.private`.
  - Accepting an update re-attaches the live file's private sections verbatim.
- **Truthful import.** The agent may only propose facts present in the source document.
  - Every number in a proposed title, bullet, context, headline or summary must appear in the source text: `scanClaims` with the source (plus, for updates, the target entry's text) as the only sources. An unsourced number is a validation **error**.
  - Each skill must appear as a whole token in the sources (error).
  - The year of each `start`/`end` must appear in the sources (error).
  - Unsourced proper nouns are **warnings**, recorded on the proposal as `flags` and shown in review.
- **Validation retries:** max 2 retries per agent step (`runAgentStep` default), then fail loudly and keep the workspace.
- **Entry ids** are assigned by resumely, never by the agent, for new entries. The form is `<prefix>-<slug>`, made unique with `-2`, `-3`, … against live ids and pending proposals.
  - Prefixes: experience `exp`, project `proj`, education `edu`, award `award`, publication `pub`, volunteering `vol`, certification `cert`, other `extra`.
  - The slug is `slugify(org ?? title, 30)` for experience/education, else `slugify(title, 30)`.
- **Entry files** go in `experience/` (experience), `projects/` (project), `education/` (education) or `extras/` (everything else). The filename is the id with its type prefix removed (`exp-atlas-labs` → `experience/atlas-labs.md`), and `-2`, … is added if that file exists.
- **Tests are LLM-free.** The headless import uses the existing step-keyed `tests/fixtures/fake-harness.ts` (step `import`). The interview uses a new `tests/fixtures/fake-interactive.ts`. `bun test` and `bunx tsc --noEmit` must be green after every task.
- **Commit messages** end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Accepting an update to an entry that has a `## Private` section.** The agent never saw that section, so its proposed full content lacks it. After accept, the live file must still contain the private section verbatim. Test in Task 4.
2. **Importing the same resume twice, or importing a resume whose entries already exist.** The inbox must not fill with copies:
   - an import proposal identical to a pending one is not re-staged
   - a `new` entry matching a live entry becomes a `duplicate`
   - an `update` that changes nothing is dropped

   Test in Task 5.
3. **A scanned (image-only) PDF, `pdftotext` not installed, an unsupported extension, or a login-walled URL (LinkedIn).** Each gives a one-line actionable error with an install/export hint, before any agent call, with nothing staged. Test in Task 5.
4. **Shell-hostile text from an agent calling `profile add`** (quotes, `$HOME`, backticks, newlines, `R&D`, `C#`, `100%`). Via `--json -` on stdin it is stored byte-for-byte. Invalid input gives one `error:` line naming the field, exit 1, and nothing staged. Test in Task 6.
5. **One malformed profile file (bad YAML/frontmatter).** `profile lint` reports a `parse-error` for that file and still lints every other file; it never throws. Test in Task 2.

---

## File Structure

```
src/profile/schema.ts             # + export MonthSchema, EntryIdSchema (no behaviour change)
src/profile/load.ts               # + export parseEntryText, listEntryFiles, loadSkills (loadProfile refactored onto them)
src/profile/proposal.ts           # zod: DraftEntry, ProposedEntry, AboutChange, ImportResult, Proposal
src/profile/inbox.ts              # inbox store, pid allocation, id generation, duplicate detection, staging
src/profile/diff.ts               # small LCS unified line diff
src/profile/accept.ts             # render entry markdown, accept (write live profile), skills/about merge, preview
src/profile/source.ts             # import source → text (pdf / docx / md / txt / html / url)
src/profile/import.ts             # validateImport + importProfile (headless agent step)
src/profile/add.ts                # `profile add` input parsing/validation → staged proposal
src/profile/review.ts             # interactive + scripted review
src/profile/interview.ts          # interactive presets, self command, launchInterview
src/profile/lint.ts               # lintProfile, dateIssues  (contract for P5)
src/application/trace.ts          # buildTrace, formatTrace  (contract for P5)
src/commands/editor.ts            # $VISUAL/$EDITOR launcher
src/commands/prompt.ts            # export lineReader (no behaviour change)
src/job/intake.ts                 # + export htmlToText, fetchPage (fetchJobUrl refactored onto it)
src/config.ts                     # + AdapterConfig.interactive_command
src/commands/init.ts              # + commented interactive_command line in CONFIG_TOML
src/pipeline/prompts/import-profile.md
src/pipeline/prompts/interview.md
src/cli.ts                        # profile import|add|review|lint, interview, trace; init next steps; apply hints
tests/fixtures/fake-interactive.ts
tests/fixtures/import/resume.md   # fictional "Jordan Example" resume text with a new job + an Atlas Labs update
tests/fixtures/pdf.ts             # minimalPdf(text) helper for pdftotext-gated tests
README.md
```

## Parallelism

| Wave | Tasks | Notes |
|---|---|---|
| A | **1, 2, 3** | Fully disjoint files. |
| B | **4, 5, 6** (after 1 and 2) | Disjoint files. Only Task 6 touches `src/cli.ts`. |
| C | **7**, then **8** (after 4 and 6) | Both edit `src/cli.ts` and `src/commands/*`, so run them sequentially. |
| D | **9** (after all) | |

---

### Task 1: Proposal model and inbox store

**Files:**
- Modify: `src/profile/schema.ts` (export the existing `month` regex schema as `MonthSchema` and the id schema as `EntryIdSchema`; `EntryFrontmatter` uses them)
- Create: `src/profile/proposal.ts`, `src/profile/inbox.ts`
- Test: `tests/inbox.test.ts`

**Interfaces:**
- Consumes:
  - `slugify(s, max)` from `src/application/slug.ts`
  - `normaliseSkill` from `src/pipeline/validate.ts`
  - `Profile` / `Entry` / `ENTRY_TYPES`
- Produces (`proposal.ts`):
  - `DraftEntry` (zod):
    ```
    {
      type: enum(ENTRY_TYPES);
      title: string(min 1);
      org?: string;
      location?: string;
      start?: MonthSchema;
      end?: MonthSchema | "present";
      url?: string;
      skills: string[] (default []);
      tags: string[] (default []);
      bullets: string[] (default []);
      context: string (default "");
    }
    ```
  - `ProposedEntry = DraftEntry & { id: EntryIdSchema; body?: string }`. `body`, when set (after a review edit), is used verbatim instead of rendering `bullets` and `context`.
  - `AboutChange` (zod, all optional): `name`, `email`, `phone`, `location`, `headline`, `links: {label,url}[]`, `summary`.
  - `ImportResult` (zod) — the agent's `out/proposals.json`:
    ```
    {
      proposals: { kind: "new" | "update" | "duplicate"; target_id?: string; entry: DraftEntry; rationale: string(min 1) }[];
      skills: Record<string, string[]> (default {});
      about: AboutChange | null (default null);
    }
    ```
  - `Proposal` (zod):
    ```
    {
      pid: /^\d+-[a-z0-9-]+$/;
      kind: "new" | "update" | "duplicate" | "skills" | "about";
      created: string;
      source: { kind: "import" | "interview" | "manual"; ref: string; run?: string };
      rationale: string (default "");
      flags: string[] (default []);
      target_id?: string;
      entry?: ProposedEntry;
      skills?: Record<string, string[]>;
      about?: AboutChange;
      decision?: { kind: "accepted" | "rejected"; at: string; as?: "update" | "new"; file?: string };
    }
    ```
    Kinds `new` / `update` / `duplicate` carry `entry`. `update` / `duplicate` carry `target_id`, and `entry.id === target_id`.
  - `type Draft = { kind: "new" | "update" | "duplicate"; target_id?: string; entry: DraftEntry; rationale: string; flags?: string[] }`
- Produces (`inbox.ts`):
  - `inboxDir(profileDir: string): string` returns `join(profileDir, ".inbox")`. The archive is `.inbox/archive/`.
  - `listProposals(profileDir: string): Proposal[]`
    - pending only, sorted by the numeric pid prefix
    - an unparseable file is skipped and reported via `listProposalsDetailed(profileDir): { proposals: Proposal[]; broken: string[] }`
  - `writeProposal(profileDir, p: Omit<Proposal, "pid" | "created">, now?: Date): Proposal`
    - pid = `${n}-${slug}`, where `n` = 1 + the max numeric prefix over the inbox **and** the archive, and `slug` = `entry.id`, or `"skills"` / `"about"`
    - the file is written with flag `wx`; on `EEXIST`, recompute `n` and retry
  - `findProposal(profileDir, ref: string): Proposal` matches an exact pid or the numeric prefix (`"3"` → `3-…`). Throws `UserError("No pending proposal \"<ref>\"", "resumely profile review --list")`.
  - `archiveProposal(profileDir, p: Proposal, decision: NonNullable<Proposal["decision"]>): void` moves the proposal to `archive/<pid>.json` with `decision` set.
  - `saveProposal(profileDir, p: Proposal): void` rewrites a pending proposal in place (used by review edit).
  - `ID_PREFIX: Record<EntryType, string>`
  - `newEntryId(type: EntryType, e: { title: string; org?: string }, taken: Set<string>): string` (rule in Global Constraints)
  - `takenIds(profileDir: string, profile: Profile): Set<string>`: live ids plus the `entry.id` of pending `new` proposals.
  - `findLikelyDuplicate(e: DraftEntry, entries: Entry[]): Entry | null`. Match on the same `type`, then by type:
    - experience/education: `slugify(org)` equal, and either `slugify(title)` equal or the date ranges overlap (`present` = now; a missing date counts as overlapping)
    - other types: `slugify(title)` equal
  - `stageDrafts(profileDir, profile: Profile, drafts: Draft[], extra: { skills?: Record<string, string[]>; about?: AboutChange | null }, source: Proposal["source"], now?: Date): { staged: Proposal[]; skipped: string[] }`. Deterministic, in order:
    - `new` with a likely duplicate → kind `duplicate`, with `target_id` = that entry's id
    - otherwise `new` gets `newEntryId`, and the id is added to `taken`
    - `update` / `duplicate` take `id = target_id`
    - (Task 4 adds a no-op-update skip here: an update equal to the live entry is skipped with `"<id>: no changes"`.)
    - a draft deep-equal (kind, target_id, entry minus id) to a pending proposal is skipped with `"<title>: already in the inbox (<pid>)"`
    - `skills`: drop items already present anywhere in `profile.skills` (`normaliseSkill`); stage one `skills` proposal if any remain
    - `about`: drop fields equal to the live `profile.about` values (`summary` compares to `about.body`); stage one `about` proposal if any remain

- [ ] **Step 1: Write failing tests** in `tests/inbox.test.ts`. Use a temp data root with `init` and `profile-jordan` copied in, as in `tests/apply.test.ts`.
  - `newEntryId("experience", { title: "Staff Engineer", org: "Acme Robotics" }, new Set())` returns `"exp-acme-robotics"`. With `exp-acme-robotics` taken it returns `"exp-acme-robotics-2"`. `("project", { title: "RouteKit" }, …)` returns `"proj-routekit"`. `("award", { title: "Best Paper — ICSE" }, …)` returns `"award-best-paper-icse"`. `("education", { title: "B.Sc.", org: "Université de Montréal" }, …)` returns `"edu-universite-de-montreal"`.
  - `writeProposal` twice gives pids `1-exp-acme-robotics` and `2-skills`. After archiving pid 2, the next pid is `3-…` (numbers are never reused).
  - `findProposal(dir, "1")` and `findProposal(dir, "1-exp-acme-robotics")` find the same proposal. `findProposal(dir, "9")` throws `UserError`.
  - `findLikelyDuplicate({ type: "experience", title: "Senior Software Engineer", org: "Atlas Labs", … }, jordan.entries)?.id === "exp-atlas-labs"`. A project titled `"routekit"` matches `proj-routekit`. An experience at `"Acme"` returns `null`.
  - `stageDrafts` with one new Acme job, one new Atlas Labs job (→ duplicate of `exp-atlas-labs`), `skills: { Languages: ["go", "Rust"] }` and `about: { name: "Jordan Example", headline: "Backend engineer" }` stages 4 proposals:
    - `new` `exp-acme`
    - `duplicate` with `target_id` `exp-atlas-labs`
    - `skills` with `{ Languages: ["Rust"] }`
    - `about` with only `headline`
  - Running the same `stageDrafts` again stages 0, and `skipped` mentions `already in the inbox`.
  - `listProposalsDetailed` with a corrupt `.inbox/7-x.json` returns it in `broken` and still lists the others.
  - `loadProfile` on the root still loads 5 entries with a non-empty `.inbox/`, so the inbox is ignored by the loader.
- [ ] **Step 2: Run** `bun test tests/inbox.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `proposal.ts`, `inbox.ts` and the `schema.ts` exports.
- [ ] **Step 4: Run** `bun test tests/inbox.test.ts && bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(profile): proposal model and staged inbox`

---

### Task 2: `lintProfile` (contract) and tolerant entry parsing

**Files:**
- Modify: `src/profile/load.ts`. Extract the per-file logic so lint can parse files one at a time; `loadProfile` behaviour and error messages stay identical.
- Create: `src/profile/lint.ts`
- Test: `tests/lint.test.ts` (existing `tests/profile.test.ts` must stay green unchanged)

**Interfaces:**
- Produces (`load.ts`):
  - `listEntryFiles(profileDir: string): { file: string; dirType: EntryType }[]`: the `DIR_TYPE` dirs, `*.md`, sorted.
  - `parseEntryText(text: string, file: string, dirType?: EntryType): Entry` throws `UserError` exactly as today, on missing frontmatter, invalid YAML or schema errors. `type` defaults to `dirType`, then `"other"`.
  - `loadSkills(profileDir: string): Skills` throws `UserError` on invalid YAML or schema.
- Produces (`lint.ts`), the **contract for P5**:
  ```ts
  export interface LintIssue { entry_id: string | null; file: string; severity: "error" | "warning"; code: string; message: string }
  export function lintProfile(root: string, opts?: { now?: Date }): LintIssue[]
  export function dateIssues(e: { type: EntryType; start?: string; end?: string }, now?: Date): Omit<LintIssue, "entry_id" | "file">[]
  export function formatLint(issues: LintIssue[]): string
  ```
  - `root` is the **data root**. `file` is relative to the data root (e.g. `profile/experience/atlas-labs.md`). `lintProfile` never throws for profile content problems. It throws `UserError` only if `root` is not a data root (`requireDataRoot`).
  - Codes, all fixed:

    | code | severity | rule |
    |---|---|---|
    | `parse-error` | error | an entry file, `about.md` or `skills.yaml` fails to parse. Message = the `UserError` message. `entry_id` = the `id:` scraped by `/^id:\s*(\S+)/m` if present, else null. |
    | `duplicate-id` | error | the second and later files with an id (message names the first file) |
    | `missing-dates` | warning | experience/education with no `start` |
    | `end-before-start` | error | both months and `end < start` |
    | `future-start` | error | `start` after the current month |
    | `future-end` | warning | `end` (not `present`) after the current month, except for education (expected graduation) |
    | `outcome-less-bullet` | warning | see below |
    | `duplicate-skill` | warning | the same `normaliseSkill` value appears more than once across all `skills.yaml` categories (one issue per extra occurrence, naming both categories); `entry_id` null, file `profile/skills.yaml` |
    | `unused-entry` | warning | an entry id cited by no `entry_ids` in any `applications/*/{resume,cover-letter}/v*/trace.json`. The check is skipped entirely when no trace file exists. An unreadable trace is ignored. |
    | `private-heading` | warning | each `privateHeadingWarnings` item |
    | `pending-proposals` | warning | `N proposals awaiting review`; `entry_id` null, file `profile/.inbox` |

  - `outcome-less-bullet` applies to experience, project and volunteering entries. It checks each body line matching `/^\s*[-*]\s+(.+)/` (private already stripped) that is not under a `## ` heading matching `/context|stor(y|ies)|notes/i`. A bullet is flagged when it has no digit and none of these result words (case-insensitive, word-bounded):
    > reduced, increased, improved, cut, grew, saved, doubled, tripled, halved, launched, shipped, delivered, won, eliminated, accelerated, lowered, raised, boosted, scaled, achieved, generated, resulting, so that, leading to

    The message is `no measurable outcome: "<first 60 chars>"`.
  - Output order: errors before warnings, then by `file`, then by `code`.
  - `formatLint` prints one line per issue: `<severity padded> <entry_id or "-"> <file>  <code>: <message>`. It ends with `N errors, M warnings`, or `profile looks good` when there are none.

- [ ] **Step 1: Write failing tests** in `tests/lint.test.ts`. Use a temp data root with `profile-jordan` and `now = new Date("2026-11-11")`.
  - The Jordan fixture gives no errors. Exactly one `outcome-less-bullet`: entry `exp-northwind`, message containing `"Migrated a legacy Python monolith`. No `unused-entry` (no applications yet).
  - Add `applications/x/resume/v1/trace.json` with `[{ "entry_ids": ["exp-atlas-labs"] }]`. Then `unused-entry` is reported for `exp-northwind`, `proj-ledgerly`, `proj-routekit` and `edu-udem`, and not for `exp-atlas-labs`.
  - **Review Focus 5:** overwrite `projects/routekit.md` with `---\nid: [unclosed\n---\n`. The result has one `parse-error` with `file === "profile/projects/routekit.md"`, and other files are still linted (the Northwind outcome warning is still present).
  - A copy of `atlas-labs.md` saved as `experience/atlas-copy.md` gives `duplicate-id` (error) on `profile/experience/atlas-copy.md`.
  - `dateIssues({ type: "experience", start: "2024-05", end: "2023-01" })` has code `end-before-start`. `start: "2027-01"` with `now` 2026-11 gives `future-start`. Education with `end: "2027-06"` gives no issue; experience with the same gives `future-end`. Experience with no start gives `missing-dates`.
  - `skills.yaml` with `Languages: [Go, SQL]` and `Tools: [go]` gives one `duplicate-skill` mentioning both categories.
  - A `.inbox/1-x.json` file gives `pending-proposals` with the message `1 proposal awaiting review`.
  - `tests/profile.test.ts` passes unchanged.
- [ ] **Step 2: Run** `bun test tests/lint.test.ts`. Expected: FAIL.
- [ ] **Step 3: Refactor `load.ts`** onto `listEntryFiles` / `parseEntryText` / `loadSkills`, then implement `lint.ts`.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(profile): deterministic profile lint`

---

### Task 3: `buildTrace` (contract)

**Files:**
- Create: `src/application/trace.ts`
- Test: `tests/trace.test.ts`

**Interfaces:**
- Consumes the files P2 saves in a version dir (see `src/pipeline/apply.ts` `save`, `src/pipeline/version.ts`):
  - resume `trace.json`: `{ section; item; bullet; text; entry_ids; basis }[]`, with the summary row first (`section: "summary"`, `item: ""`), then sections → items → bullets in `resume.json` order
  - cover `trace.json`: `{ paragraph; text; entry_ids; company_fact_ids }[]`
  - `resume.json`: `ResumeContent` with `gaps: { requirement; note }[]`
  - `checks.json`: `HardFacts & { warnings: string[] }`
    - `fabrication_warnings` entries look like `sections[0].items[1].bullets[2]: "Kafka" is not supported by …`, `summary: "…" …` or `paragraphs[1]: "…" …`
    - `keywords.absent: string[]`
- Produces, the **contract for P5**:
  ```ts
  export interface TraceRow { section: string; text: string; entry_ids: string[]; basis: "direct" | "inferred"; flags: string[] }
  export interface TraceReport { app: string; kind: "resume" | "cover-letter"; version: number; rows: TraceRow[]; gaps: string[]; warnings: string[] }
  export function buildTrace(appDir: string, kind: "resume" | "cover-letter", version?: number): TraceReport
  export function formatTrace(r: TraceReport): string
  ```
  - `app` = `basename(appDir)`. Without `version`, use the highest `<kind>/v<N>` dir.
    - No versions → `UserError("<app> has no <resume|cover letter> versions yet", "Run: resumely apply")`.
    - Unknown version → `UserError("<app> has no <label> v<N>")`.
    - Missing or invalid `trace.json` → `UserError` naming the path.
  - **Resume rows:**
    - `section` = `item ? "<section> / <item>" : section`
    - `basis` from the row
    - `flags` = `unsourced "<tok>"` for each fabrication warning whose path maps to this row. The flat index is 1 for the summary if present, then counted through `resume.json` sections → items → bullets.
  - **Cover rows:**
    - `section` = `paragraph <i+1>`
    - `entry_ids` = `[...entry_ids, ...company_fact_ids]` (`co-N` ids resolve via `company.snapshot.json`)
    - `basis` = `"direct"`
    - flags map from `paragraphs[i]`
  - **`gaps`:**
    - resume: `"<requirement>: <note>"` for each `resume.json` gap, then `keyword not in profile: <k>` for each `checks.keywords.absent` keyword not already named by a gap requirement (case-insensitive)
    - cover: the keyword lines only
  - **`warnings`:** `checks.json.warnings`, then any fabrication warning that maps to no row, then `missing checks.json` / `missing resume.json` if absent (the report still builds from `trace.json`).
  - `formatTrace` prints:
    - header `<kind> v<N> — <app>`
    - rows grouped by `section`, each as `  [direct]   exp-a, exp-b  <text>`, with `  ! unsourced "Kafka"` lines under flagged rows
    - then `gaps:` and `warnings:` blocks, omitted when empty

- [ ] **Step 1: Write failing tests** in `tests/trace.test.ts`. Build `appDir/resume/v1/` in a temp dir:
  - `resume.json` = `tests/fixtures/resume-content.json`
  - `trace.json` = `resumeTrace(resolveResume(content, loadProfile(fixture).entries))` (real P2 shape)
  - `checks.json` = `{ …minimal HardFacts…, keywords: { present: [], missed_in_profile: [], absent: ["Rust", "Kafka"] }, fabrication_warnings: ['sections[0].items[1].bullets[2]: "Kafka" is not supported by the cited entries'], warnings: ["fabrication: x"] }`

  Assertions:
  - `rows.length === 11`. `rows[0].section === "summary"` with `entry_ids` `["exp-atlas-labs", "exp-northwind"]`. `rows[1].section === "Experience / Senior Software Engineer"`.
  - `rows[6].flags` deep-equals `['unsourced "Kafka"']` (summary + 3 Atlas bullets + Northwind bullet index 2). All other rows have `flags: []`.
  - `gaps` deep-equals `["Rust: No Rust experience in the profile; omitted.", "keyword not in profile: Kafka"]`.
  - `warnings` contains `"fabrication: x"`.
  - Add `resume/v2` and check that `buildTrace(appDir, "resume")` picks v2 and `buildTrace(appDir, "resume", 1)` picks v1. `buildTrace(appDir, "cover-letter")` throws `UserError` "has no cover letter versions yet".
  - Cover: `cover-letter/v1/trace.json` = `coverTrace(tests/fixtures/cover-letter.json)` plus `checks.json` with a `paragraphs[2]` warning. The rows are `paragraph 1…n`, `entry_ids` include the paragraph's `co-` ids, and row 3 is flagged.
  - `formatTrace` output contains `resume v1 — ` and `! unsourced "Kafka"`.
- [ ] **Step 2: Run** `bun test tests/trace.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `trace.ts`.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: trace report for a stored document version`

---

### Task 4: Accepting proposals into the live profile

**Files:**
- Create: `src/profile/accept.ts`, `src/profile/diff.ts`
- Modify: `src/profile/inbox.ts` (`stageDrafts` skips an `update` for which `sameAsLive(entry, liveEntry)` is true, with `"<id>: no changes"`)
- Test: `tests/accept.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `Proposal`, `ProposedEntry`, `archiveProposal`, `newEntryId`, `takenIds`, `ID_PREFIX`
  - Task 2: `parseEntryText`
  - `stripPrivate`
- Produces (`diff.ts`): `unifiedDiff(a: string, b: string, o: { from: string; to: string; context?: number /* default 3 */ }): string`. Line LCS (O(n·m) DP is fine for profile-sized files). Output:
  - a `--- <from>` / `+++ <to>` header
  - `@@ -l,n +l,n @@` hunks with ` ` / `-` / `+` lines
  - `""` when equal
- Produces (`accept.ts`):
  - `entryMarkdown(e: ProposedEntry): string`
    - YAML frontmatter via `yaml` `stringify` with keys in the order `id, type, title, org, location, start, end, url, skills, tags`, omitting undefined
    - then the body: `e.body` if set; otherwise `## Highlights\n\n- …` (when there are bullets) and `## Context\n\n<context>` (when non-empty), separated by a blank line
    - the result must round-trip through `parseEntryText` with equal frontmatter (dates stay strings)
  - `entryFileFor(profileDir: string, e: { id: string; type: EntryType }): string` (rule in Global Constraints)
  - `privateSections(fileText: string): string`: the raw `## Private…` sections (heading through the line before the next `## ` or EOF), joined. Same heading rule as `stripPrivate`.
  - `sameAsLive(e: ProposedEntry, live: Entry): boolean`: rendered frontmatter fields equal, and the rendered body (stripped) equals `live.body` after whitespace trim.
  - `previewProposal(profileDir: string, p: Proposal): string`
    - `new`: `entryMarkdown`
    - `update` / `duplicate`: `unifiedDiff(liveFileText, newFileText, { from: "a/profile/<rel>", to: "b/profile/<rel>" })`, where `newFileText` includes the preserved private sections
    - `skills`: `+ <Category>: a, b` lines
    - `about`: a diff of `about.md`
  - `acceptProposal(profileDir: string, p: Proposal, o?: { as?: "update" | "new"; now?: Date }): { file: string; id?: string }` (`file` is relative to `profileDir`). Behaviour by kind:
    - **`new`**: if `entry.id` is now in `takenIds`, reassign it with `newEntryId`. Write `entryFileFor` with flag `wx`.
    - **`update`**:
      - The live entry `target_id` must exist, else `UserError("Entry \"<id>\" no longer exists", "Reject it, or accept it as new: resumely profile review --accept <pid> --as new")`; `as: "new"` on an update is allowed and behaves like new with a fresh id.
      - Write to the live entry's own file: `entryMarkdown(entry)` + `"\n" + privateSections(liveText)` when non-empty.
      - The write is atomic (temp file in the same dir, then `renameSync`).
    - **`duplicate`**: requires `o.as`, else `UserError("<pid> is a possible duplicate of <target>", "Choose: --as update (replace <target>) or --as new (keep both)")`. `update` / `new` then behave as above.
    - **`skills`**:
      - Edit `skills.yaml` via `yaml` `parseDocument` so comments survive.
      - Append missing items to existing categories (`normaliseSkill` dedupe), and create missing categories.
      - Return `file: "skills.yaml"`.
    - **`about`**:
      - Edit `about.md` frontmatter via `parseDocument` (the `private:` key and comments survive).
      - Set the provided scalar fields. Merge `links` by URL (append the new ones).
      - `summary` replaces the body, then the body's private sections are appended.
    - **Every kind:** before writing, re-validate the result (`parseEntryText` on the new entry text; `AboutFrontmatter` / `SkillsSchema` on the new docs). On failure throw `UserError` and write nothing. On success call `archiveProposal(…, { kind: "accepted", at, as, file })`.
  - `rejectProposal(profileDir: string, p: Proposal, now?: Date): void` archives with `{ kind: "rejected" }`.

- [ ] **Step 1: Write failing tests** in `tests/accept.test.ts` (temp root + Jordan profile; proposals made with Task 1's `writeProposal`):
  - `unifiedDiff("a\nb\nc\n", "a\nB\nc\n", {from:"x",to:"y"})` contains `-b` and `+B`; equal inputs give `""`.
  - `entryMarkdown` of a draft with `start: "2024-05"`, bullets `["Cut costs 30%"]` and context `"Story."` contains `## Highlights` and `- Cut costs 30%`. `parseEntryText` of the result returns `start === "2024-05"`.
  - Accepting `new` `exp-acme` writes `experience/acme.md`. `loadProfile` then has 6 entries, and the proposal is in `.inbox/archive/` with `decision.kind === "accepted"`.
  - **Review Focus 1:** accepting an `update` of `exp-atlas-labs` (bullets changed) rewrites `experience/atlas-labs.md`. The file still contains `## Private`, `Compensation: 145000 CAD plus equity.` and the new bullet. `loadProfile` shows the new bullet in `body`, but `buildAgentPayload` still has no "Compensation".
  - Accepting a `duplicate` without `as` throws a `UserError` whose hint contains `--as update`. With `as: "new"` it creates `exp-atlas-labs-2` in `experience/atlas-labs-2.md`.
  - An update whose target file was deleted throws `"no longer exists"` and writes nothing.
  - `skills` `{ Languages: ["Rust"], Cloud: ["AWS"] }`: `skills.yaml` gains both and keeps its existing items. A leading comment line in `skills.yaml` survives.
  - `about` `{ headline: "Backend engineer", links: [{label:"Site", url:"https://jordan.dev"}] }`: `about.md` keeps `private:` (`loadAbout(...).privateKeys === 1`), the headline is updated, and links grow to 3.
  - Writing `new` when the file `experience/acme.md` already exists (different id) writes `acme-2.md`.
  - `rejectProposal` archives with `decision.kind === "rejected"` and leaves the profile unchanged.
  - `previewProposal` for the Atlas update contains `--- a/profile/experience/atlas-labs.md`.
- [ ] **Step 2: Run** `bun test tests/accept.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `diff.ts` and `accept.ts`, and add the no-op-update skip to `stageDrafts` (add a case to `tests/inbox.test.ts`: staging an update of `proj-routekit` whose content equals the live entry stages nothing and `skipped` contains `proj-routekit: no changes`).
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(profile): accept/reject proposals with private-section preservation`

---

### Task 5: `profile import` — sources, validator, headless step

**Files:**
- Modify: `src/job/intake.ts`. Export `htmlToText`, and add `fetchPage(url, o: { fetchImpl?: typeof fetch; hint: string }): Promise<{ html: string; text: string }>`, which does the fetch, HTTP-status and network-error handling now inside `fetchJobUrl`. `fetchJobUrl` calls it with `CLIP_HINT`; its behaviour is unchanged.
- Create: `src/profile/source.ts`, `src/profile/import.ts`, `src/pipeline/prompts/import-profile.md`, `tests/fixtures/import/resume.md`, `tests/fixtures/pdf.ts`
- Test: `tests/import.test.ts` (`tests/intake.test.ts` stays green)

**Interfaces:**
- Consumes:
  - Task 1: `ImportResult`, `stageDrafts`, `Draft`
  - Task 2: `dateIssues`
  - `runAgentStep`, `createRunWorkspace`, `newRunId`
  - `resolveAdapter`, `loadConfig`
  - `buildAgentPayload`, `loadProfile`
  - `scanClaims`, `hasToken`
  - `unsupportedChars`
  - `extractPdfTextDetailed`
  - `spawnWithTimeout`
- Produces (`source.ts`):
  - `type ImportSource = { kind: "pdf" | "docx" | "text" | "html" | "url"; ref: string; text: string; html?: string; attachment?: { name: "source.pdf"; bytes: Uint8Array }; warnings: string[] }`
  - `readImportSource(arg: string, o?: { fetchImpl?: typeof fetch; run?: (argv: string[]) => Promise<{ code: number | null; stdout: string } | null>; pdftotext?: string }): Promise<ImportSource>`. `run` (used for DOCX) returns null when the binary is missing (ENOENT); the default uses `spawnWithTimeout` with 30 s. `pdftotext` overrides the binary passed to `extractPdfTextDetailed({ bin })`. Behaviour by input:
    - **`http(s)://` URL:** `fetchPage` with hint `"Save the page as PDF (or copy its text into a .md file) and import that file"`. Fewer than 30 words, or `/sign in|log in|enable javascript/i` → `UserError("Couldn't read enough of <url> (<n> words)", <same hint>)`; LinkedIn's hint is `"LinkedIn requires login: use More → Save to PDF on your profile and import the PDF"`.
    - **`.pdf`:**
      - Read the bytes, then `extractPdfTextDetailed`.
      - `reason === "missing"` → `UserError("pdftotext is required to import PDFs", "macOS: brew install poppler · Debian/Ubuntu: apt install poppler-utils")`.
      - Fewer than 20 words → `UserError("No extractable text in <file> (scanned image?)", "Export a text-based PDF, or paste the text into a .md file and import that")`.
      - Set `attachment = { name: "source.pdf", bytes }`.
    - **`.docx`:** try in order `["textutil", "-convert", "txt", "-stdout", file]`, `["pandoc", "-t", "plain", "--wrap=none", file]`, then `["unzip", "-p", file, "word/document.xml"]` → `docxXmlToText`. All missing → `UserError("Can't read .docx: none of textutil, pandoc or unzip is installed", "Save it as PDF or Markdown and import that")`.
    - **`.md` / `.txt`:** read as is. **`.html` / `.htm`:** `htmlToText`.
    - **Other extensions:** `UserError("Unsupported file type \"<ext>\"", "Use .pdf, .docx, .md, .txt, .html or a URL")`. A missing file → `UserError("File not found: <arg>")`.
    - Text longer than 100 000 chars is truncated, with the warning `source truncated to 100000 characters`. Empty text → `UserError("<ref> is empty")`.
  - `docxXmlToText(xml: string): string`
    - `</w:p>` → `\n`
    - `<w:tab/>` → `\t`
    - `<w:br/>` → `\n`
    - strip the other tags
    - decode `&amp; &lt; &gt; &quot; &apos;`
- Produces (`import.ts`):
  - `validateImport(raw: unknown, o: { profile: Profile; sourceText: string; sourceHtml?: string; now?: Date }): ValidationResult<ImportResult>`. Errors use the agent-facing path, e.g. `proposals[2].entry.bullets[1]: "40%" does not appear in the source`.
    - Schema errors via `schemaErrors`.
    - `new` must not have `target_id`. `update` / `duplicate` need a `target_id` that exists in the profile. `update` needs `entry.type === target.type`.
    - **Dates:** each `dateIssues` issue with severity `error` is an error. The year of `start`/`end` (unless `present`) must appear as a number in the sources.
    - **Sources:** `[sourceText]`, plus for update/duplicate the target entry's title, org, body, skills and its start/end years.
    - **Numbers:** run `scanClaims(field, sources)` on each of `title`, `org`, `location`, every bullet, `context`, `about.headline` and `about.summary`. Tokens starting with `$` or a digit are errors. Other tokens (proper nouns) go into `warnings` as `proposals[i]: unsourced "<tok>"`, and `importFlags` (below) recomputes them per proposal.
    - **Skills:** each entry skill and each `skills` addition must satisfy `hasToken(sources.join("\n"), s, s.length <= 3)`.
    - **About:**
      - `email` must appear case-insensitively in `sourceText`
      - `phone`'s digits must appear in the digits-only source
      - each link URL, minus scheme and trailing `/`, must appear in `sourceText` or `sourceHtml`
      - each `name` token must appear (`hasToken`)
    - `unsupportedChars` on title, org, location, skills and about.name: these reach LaTeX directly.
    - Two `new` proposals with the same type and `slugify(org ?? "")`/`slugify(title)` → error `proposals[j]: duplicates proposals[i]`.
  - `importFlags(entry: DraftEntry, sources: string[]): string[]` returns `unsourced "<tok>"` for each proper noun `scanClaims` reports across the scanned fields (deduped). The numbers are already guaranteed sourced.
  - `importProfile(o: { root: string; source: string; harness?: string; onProgress?: (m: string) => void; fetchImpl?: typeof fetch; now?: Date }): Promise<{ staged: Proposal[]; skipped: string[]; warnings: string[]; workspace: string }>`
    1. Load the config, `resolveAdapter(name)` (the normal command, no research), `loadProfile` and `readImportSource`.
    2. Create the workspace with `createRunWorkspace(layout.runs, "import")`. Write `source.pdf` bytes into it when there is an attachment.
    3. Call `runAgentStep` with:
       - files: `profile.json` (`buildAgentPayload`), `source.txt`, `import.schema.json` (`z.toJSONSchema(ImportResult)`)
       - `outFile: "proposals.json"`
       - `validate: validateImport`
       - the timeout from `timeout_minutes`
    4. Call `stageDrafts` with `source = { kind: "import", ref: <basename of file, or URL>, run: <runId> }` and per-draft `flags` from `importFlags`.
    5. Return. `warnings` = source warnings + step warnings.
  - Prompt `import-profile.md`. The rules (verbatim intent):
    - **Inputs.** Read `profile.json` (the existing profile; private notes are withheld) and `source.txt` (the authoritative text of the document). `source.pdf`, when present, is only a layout reference, and every fact must be in `source.txt`.
    - **Proposal kinds.** For each role, project, degree, award, publication, volunteering or certification in the source:
      - not in the profile → `kind: "new"`
      - already in the profile and the source adds or corrects facts → `kind: "update"` with `target_id` and the **complete** new content (the existing bullets you keep plus the new ones)
      - unsure whether it is the same item → `kind: "duplicate"` with `target_id`
      - nothing new → omit it
    - **Truthfulness.** Never invent, round or infer. Copy numbers exactly.
      - Dates are `YYYY-MM`. If the source gives only a year, omit the date and state the years in `rationale`.
      - `skills` lists only skills the source names for that item.
      - `tags`: 1–3 lowercase labels.
    - **Bullets and context.** `bullets` are resume-ready, one achievement each, close to the source wording. `context` holds other narrative from the source useful for cover letters.
    - **Skills and about.** Top-level `skills` lists only additions, keyed by an existing category from `profile.json` when one fits. `about` holds only fields the source states (`summary` only if the source has a profile/summary paragraph), else `null`.
    - **Output.** Write only `out/proposals.json`, conforming to `import.schema.json`. Never write ids for new entries.

- [ ] **Step 1: Write failing tests** in `tests/import.test.ts`. Use a temp root with the Jordan profile and the fake adapter configured as in `tests/apply.test.ts`; `script()` is keyed by the step `import`.
  - `tests/fixtures/import/resume.md` is a short fictional resume for Jordan Example. It contains:
    - a new job "Staff Engineer, Acme Robotics, 2025-01 – present" with "Cut fleet downtime 35% across 120 robots"
    - the Atlas Labs role with an extra bullet "Reduced infra spend by 18%"
    - a skills line containing `Rust`
    - `jordan@example.com`
  - Happy path: the script writes `out/proposals.json` with a `new` Acme proposal, an `update` of `exp-atlas-labs` (existing bullets + the 18% bullet), `skills: { Languages: ["Rust"] }` and `about: null`. Then:
    - `staged` kinds are `["new", "update", "skills"]`, with ids `exp-acme-robotics` and `exp-atlas-labs`
    - the `import` workspace has `profile.json` with no `Compensation`, and `source.txt` equal to the fixture text
    - `.inbox/` has 3 files
  - Fabricated number: attempt 0 has the bullet `"Cut fleet downtime 50%"` and attempt 1 is valid. Then `.calls` shows `import` twice, `errors.md` in the workspace contains `"50%" does not appear in the source`, and the final staged proposal has 35%.
  - Unsourced proper noun `"Kubernetes"` in a bullet gives success, and that proposal's `flags` include `unsourced "Kubernetes"`.
  - A skill not in the source (`"Kafka"`) on all attempts → rejects with `UserError` "Agent output invalid after 3 attempts", and nothing is staged.
  - `update` with `target_id: "exp-ghost"` → its error text contains `unknown`.
  - **Review Focus 2:** the happy-path import run twice stages 0 the second time, and `skipped` has 3 items. A `new` Atlas Labs "Senior Software Engineer" draft is staged as `duplicate` of `exp-atlas-labs`.
  - **Review Focus 3** (no agent call: assert no `.calls` file):
    - a `.rtf` file → "Unsupported file type"
    - a missing file → "File not found"
    - `readImportSource("https://www.linkedin.com/in/x", { fetchImpl })` with a stub returning a 40-word "Sign in" page → hint contains `Save to PDF`
    - a `.pdf` with `{ pdftotext: "/nonexistent/pdftotext" }` → `"pdftotext is required"`
  - (pdftotext-gated) `readImportSource` on `minimalPdf("Jordan Example Staff Engineer at Acme Robotics …")` (from `tests/fixtures/pdf.ts`; ≥ 20 words) returns `kind: "pdf"`, text containing `Acme Robotics` and `attachment.name === "source.pdf"`. A `minimalPdf("")` gives "No extractable text".
  - `docxXmlToText('<w:p><w:r><w:t>R&amp;D lead</w:t></w:r></w:p><w:p><w:r><w:t>C#</w:t></w:r></w:p>')` returns `"R&D lead\nC#\n"`. (`textutil`-gated) a `.docx` made with `textutil -convert docx` from a `.txt` round-trips its text.
  - `fetchJobUrl` tests in `tests/intake.test.ts` still pass.
- [ ] **Step 2: Run** `bun test tests/import.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the `intake.ts` refactor, `source.ts`, `tests/fixtures/pdf.ts`, `import.ts` and the prompt.
  - `minimalPdf(text)` builds a one-page PDF with a Helvetica `BT /F1 10 Tf … Tj ET` content stream, one line per ~60 characters, with correct xref offsets computed from the byte lengths.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(profile): headless profile import into the inbox`

---

### Task 6: `resumely profile add` (agent-callable staging)

**Files:**
- Create: `src/profile/add.ts`
- Modify: `src/cli.ts` (one additive `profile add` command block)
- Test: `tests/add.test.ts`, `tests/cli.test.ts` (new cases)

**Interfaces:**
- Consumes:
  - Task 1: `stageDrafts`, `DraftEntry`, `AboutChange`, `Proposal`
  - Task 2: `dateIssues`
  - `unsupportedChars`, `schemaErrors`
- Produces:
  - `type AddFlags = { title?: string; org?: string; location?: string; start?: string; end?: string; url?: string; skill: string[]; tag: string[]; bullet: string[]; context?: string; update?: string; category?: string; headline?: string; phone?: string; email?: string; name?: string; link: string[] /* "Label=https://…" */; summary?: string; rationale?: string }`
  - `AddInput` (zod), a discriminated union on `type`:
    - an entry: `{ type: EntryType; update?: string; rationale?: string } & DraftEntry fields`
    - skills: `{ type: "skills"; skills: Record<string, string[]>; rationale?: string }`
    - about: `{ type: "about"; about: AboutChange; rationale?: string }`
  - `parseAddInput(type: string | undefined, flags: AddFlags, json: unknown | undefined): AddInput`
    - With `json`, flags other than `rationale` must be empty, else `UserError("--json can't be combined with field flags")`. The JSON object's `type` wins, and the positional `type` must match when both are given.
    - Without `json`, the flags map onto fields. `--skill` for type `skills` requires `--category`. `--link` items must match `^[^=]+=https?://`.
    - Errors are one `UserError` whose message is `invalid proposal: <path>: <msg>; …` and whose hint is `resumely profile add --help`.
  - `stageAdd(profileDir: string, profile: Profile, input: AddInput, source: Proposal["source"], now?: Date): { staged: Proposal[]; skipped: string[] }`
    - an entry input with `update` maps to a `Draft` of kind `update` (the target must exist, else `UserError("No entry \"<id>\" to update", "resumely profile show")`)
    - any other entry input maps to a `new` draft
    - `skills` / `about` inputs go through `stageDrafts`' `extra` argument with no drafts
    - `dateIssues` errors and `unsupportedChars` on title, org, location and skills are `UserError`s
    - no source-text scan: the user is the source
    - then `stageDrafts`
  - CLI: `resumely profile add [type]`.
    - Types: the entry types plus `skills` and `about`.
    - Options:
      - repeatable (commander collector): `--skill <s>`, `--tag <t>`, `--bullet <text>`, `--link <label=url>`
      - single-value: `--title`, `--org`, `--location`, `--start <YYYY-MM>`, `--end <YYYY-MM|present>`, `--url`, `--context <text>`, `--update <id>`, `--category <c>`, `--headline`, `--phone`, `--email`, `--name`, `--summary`, `--rationale <text>`
      - `--json <file|->`: `-` reads stdin to EOF
      - `--source <label>`, default `manual`; the interview passes `interview`
    - Success prints to **stdout** one line per staged proposal: `proposed <pid> (<kind> <entry id | skills | about>)`. If nothing was staged it prints `nothing new: <skipped reasons>`. Exit 0 in both cases.
    - The help text includes a heredoc example:
      ```
      resumely profile add --json - <<'EOF'
      {"type":"experience","title":"…","org":"…","start":"2024-01","end":"present","bullets":["…"]}
      EOF
      ```

- [ ] **Step 1: Write failing tests.**
  - `tests/add.test.ts`:
    - `parseAddInput("experience", { title: "Staff Engineer", org: "Acme", start: "2024-01", end: "present", bullet: ["Cut costs 30%"], skill: [], tag: [], link: [] }, undefined)` gives an entry input with `bullets: ["Cut costs 30%"]`.
    - `--start 2024-13` → `UserError` whose message contains `start`.
    - `type: "skills"` with `skill: ["Rust"]` and no `--category` → `UserError`.
    - `--json` combined with `--title` → `UserError`.
    - `stageAdd` with `update: "exp-ghost"` → "No entry".
    - `stageAdd` new Acme → pid `1-exp-acme`, source kind `manual`.
    - `end` before `start` → `UserError` containing `before`.
  - `tests/cli.test.ts`:
    - **Review Focus 4:** spawn `profile add --json - --source interview` with stdin = JSON whose title is `Lead "R&D" — C# $HOME \`x\``, with a context containing `100%` and a newline. Expect exit 0 and stdout matching `/^proposed 1-exp-/`. The inbox proposal's `entry.title` and `entry.context` equal the input byte-for-byte, and `source.kind === "interview"`.
    - `profile add experience --title X --start nope` → exit 1, and stderr has exactly one line starting `error: invalid proposal: start`.
    - `profile add skills --category Languages --skill Go` → `nothing new` (Go is already listed), exit 0.
- [ ] **Step 2: Run** `bun test tests/add.test.ts tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `add.ts` and the CLI block. Read stdin with `await Bun.stdin.text()` for `--json -`.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(profile): profile add stages proposals for agents and humans`

---

### Task 7: `resumely profile review` (interactive and scripted)

**Files:**
- Create: `src/profile/review.ts`, `src/commands/editor.ts`
- Modify: `src/commands/prompt.ts` (export `lineReader`; no behaviour change), `src/cli.ts` (one additive `profile review` block)
- Test: `tests/review.test.ts`, `tests/cli.test.ts` (new cases), `tests/fixtures/fake-editor.ts`

**Interfaces:**
- Consumes:
  - Task 1: `listProposals`, `findProposal`, `saveProposal`, `takenIds`
  - Task 2: `parseEntryText`
  - Task 4: `previewProposal`, `acceptProposal`, `rejectProposal`, `entryMarkdown`
  - `PromptIO` / `lineReader`, `isInteractive`
- Produces:
  - `editorArgv(env?: Record<string, string | undefined>): string[]`: `(env.VISUAL || env.EDITOR || "vi").trim().split(/\s+/)`.
  - `openInEditor(file: string, env?: …): Promise<void>`
    - `Bun.spawn([...editorArgv(env), file], { stdin/stdout/stderr: "inherit" })`
    - a non-zero exit → `UserError("Editor exited with <code>; proposal unchanged")`
    - ENOENT → `UserError("Editor \"<bin>\" not found", "Set $EDITOR, e.g. export EDITOR=nano")`
  - `formatInboxList(ps: Proposal[]): string`
    - columns `PID  KIND  ENTRY  TITLE  SOURCE  FLAGS`
    - ENTRY = the entry id, or `-`
    - TITLE = `title @ org`, `skills: a, b` or `about: headline, links`
    - SOURCE = `<source.kind>:<ref>`
    - FLAGS = flag count or `-`
    - empty → `Inbox is empty.`
  - `reviewInbox(o: { profileDir: string; io?: PromptIO; edit?: (file: string) => Promise<void>; out?: { write(s: string): unknown } }): Promise<{ accepted: string[]; rejected: string[]; skipped: string[] }>`
    - **Per pending proposal, in pid order**, write:
      - `[i/n] <pid>  <kind>  <entry id | skills | about>   (<source.kind>: <ref>)`
      - the rationale
      - one `! <flag>` line per flag
      - `previewProposal`
    - **Prompts:**
      - new / update / skills / about: `[a]ccept [e]dit [r]eject [s]kip [q]uit: `
      - duplicate: `[u]pdate <target> / [n]ew entry / [e]dit / [r]eject / [s]kip / [q]uit: `
    - **Answers** are case-insensitive. Anything else re-asks. EOF = quit; the remaining proposals stay pending and are not counted as skipped.
    - **Accept** prints `accepted <pid> → profile/<file>`. An accept `UserError` is printed as `error: …` (plus `hint:`) and the same proposal is re-asked.
    - **Edit:**
      1. Write the editable form to `.inbox/<pid>.edit.md` (entries: `entryMarkdown`) or `.inbox/<pid>.edit.yaml` (skills / about: YAML of `skills` / `about`), call `edit(file)` (default `openInEditor`) and re-parse:
         - entries: `parseEntryText` → `ProposedEntry`, with `body` = the parsed body and `bullets`/`context` kept
         - skills/about: `yaml` parse plus a schema check
      2. Reject a changed id on update/duplicate (`id must stay <target>`), and on `new` reject an id that is invalid or in `takenIds`.
      3. Apply the result:
         - Valid: `saveProposal`, delete the edit file, re-show the preview and re-ask.
         - Invalid: print the error, keep the proposal unchanged, delete the edit file and re-ask.
    - Returns the pids.
    - Ends with `<a> accepted, <r> rejected, <s> skipped, <p> still pending`.
  - CLI: `resumely profile review [--list] [--accept <pid>]… [--reject <pid>]… [--accept-all] [--as <update|new>]`
    - `--list` → `formatInboxList`.
    - `--accept` / `--reject` are applied in order, printing one line each.
    - `--as` is valid only with exactly one `--accept`, else `UserError`.
    - `--accept-all` accepts every pending non-duplicate. Duplicates are left pending and listed as `needs a decision: <pid> (resumely profile review --accept <pid> --as update|new)`.
    - No flags on a TTY → `reviewInbox`.
    - No flags on a non-TTY → `UserError("profile review needs an interactive terminal", "Use --list, --accept <pid>, --reject <pid> or --accept-all")`.
    - Exit 1 if any requested accept/reject failed.

- [ ] **Step 1: Write failing tests.**
  - `tests/review.test.ts` (inject `io` from an array of lines and `out` to a string buffer). Stage 4 proposals: new Acme, update Atlas, duplicate Atlas, skills.
    - Answers `["a", "r", "n", "s"]` give accepted = the pids starting `1-` and `3-`, rejected = `2-…` and skipped = `4-…`. `experience/acme.md` and `experience/atlas-labs-2.md` exist, and `skills.yaml` is unchanged.
    - Answers `["x", "a", …]`: the first proposal is re-asked, so the output has its prompt twice.
    - EOF after the first answer: the summary reports `3 still pending`.
    - Edit with an injected `edit` that replaces `title: Staff Engineer` with `title: Principal Engineer`, then `a` → the written file has `Principal Engineer`.
    - Edit that writes broken YAML → output contains `error:` and the proposal is unchanged.
    - Edit that changes an update's id → `id must stay exp-atlas-labs`.
    - The duplicate preview shows `--- a/profile/experience/atlas-labs.md`.
    - Flags render as `! unsourced "Kubernetes"`.
    - `editorArgv({ EDITOR: "code -w" })` deep-equals `["code", "-w"]`. `editorArgv({})` is `["vi"]`. `VISUAL` wins over `EDITOR`.
    - `openInEditor` with `EDITOR="bun <fixtures>/fake-editor.ts"` (a script that appends `\n<!-- edited -->` to its argument) changes the file.
  - `tests/cli.test.ts`:
    - `profile review` on a non-TTY with no flags → exit 1 with hint `--accept-all`.
    - Stage via `profile add` ×2, then `profile review --list` shows both pids.
    - `--accept 1` → exit 0 and `profile show exp-…` works.
    - `--accept-all` with a pending duplicate → it remains, and stdout contains `needs a decision`.
    - `--as new` with two `--accept` → exit 1.
- [ ] **Step 2: Run** `bun test tests/review.test.ts tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `editor.ts`, `review.ts`, the `lineReader` export and the CLI block.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(profile): interactive and scripted inbox review`

---

### Task 8: `resumely interview` launcher

**Files:**
- Modify: `src/config.ts` (one line: `interactive_command: z.array(z.string()).optional()` on `AdapterConfig`, with a doc comment), `src/commands/init.ts` (a commented `# interactive_command = [...]` line in the adapters example), `src/cli.ts` (one additive `interview` block)
- Create: `src/profile/interview.ts`, `src/pipeline/prompts/interview.md`, `tests/fixtures/fake-interactive.ts`
- Test: `tests/interview.test.ts`, `tests/config.test.ts` (one case)

**Interfaces:**
- Consumes: `expandCommand`, `HarnessError` (from `src/harness/adapter.ts`, unmodified), `buildAgentPayload`, `loadProfile`, `createRunWorkspace`, `newRunId`, `listProposals`, `inboxDir`.
- Produces:
  - `INTERACTIVE_PRESETS: Record<"claude" | "codex" | "pi", string[]>`. Verified against the local `--help` on 2026-11-11:
    - claude: `["claude", "{prompt}"]`. A bare positional prompt starts an interactive session. Bash calls go through Claude's own permission prompt.
    - codex: `["codex", "-C", "{workspace}", "-s", "workspace-write", "--add-dir", "{inbox}", "{prompt}"]`. `--add-dir` makes the inbox writable from the sandbox.
    - pi: `["pi", "--tools", "read,bash", "{prompt}"]`.
  - `resolveInteractive(name: string, cfg: Config): string[]`
    - Returns `cfg.adapters[name]?.interactive_command`, else the preset.
    - A configured adapter with no `interactive_command` and no preset → `UserError("Harness \"<name>\" has no interactive_command", "Set [adapters.<name>] interactive_command = [...] in config.toml")`.
    - An unknown name → the same "Unknown harness" error as `resolveAdapter`.
  - `expandInteractive(argv: string[], vars: { prompt: string; workspace: string; inbox: string; model?: string }): string[]`: replace `{inbox}` in each element, then delegate to `expandCommand({ command }, vars)`.
  - `selfCommand(): string[]`: `[process.execPath]` when `basename(process.execPath)` is not `bun` / `bun.exe` (compiled binary), else `[process.execPath, resolve(import.meta.dir, "../cli.ts")]`.
  - `INTERVIEW_PROMPT = "Read instructions.md in the current directory and follow it. Start the interview now."`
  - `launchInterview(o: { root: string; harness?: string; focus?: string; spawn?: (argv: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => Promise<number> }): Promise<{ workspace: string; exitCode: number; proposals: Proposal[] }>`
    - Uses workspace `createRunWorkspace(layout.runs, "interview")` and writes these files into it:
      - `profile.json` (`buildAgentPayload`)
      - `resumely.json` = `{ "add": [...selfCommand(), "profile", "add"] }`
      - `instructions.md` = `interview.md` with `{{add_command}}` (the add argv joined with spaces, each element single-quoted if it contains a space) and `{{focus}}` replaced (focus text, or `"Ask broadly: recent work first, then projects, education, awards."`)
    - Spawns `expandInteractive(resolveInteractive(...), { prompt: INTERVIEW_PROMPT, workspace, inbox: inboxDir(profileDir) })` with `cwd = workspace` and `env = { ...process.env, RESUMELY_HOME: root }`. The default spawn is `Bun.spawn` with all stdio `"inherit"`, awaiting `exited`.
    - `mkdir -p` the inbox before spawning, since codex `--add-dir` needs it to exist.
    - ENOENT → `HarnessError("<name> is not installed", "Install <bin> or choose another harness with --harness", "not_installed")`.
    - `proposals` = pending proposals whose pid is not in the set listed before the launch.
    - No timeout: the session is interactive.
  - `interview.md` rules:
    - You are interviewing the user to extend their resume profile. `profile.json` is what is already known (private notes withheld). Do not re-ask what is there unless you are filling a gap.
    - Ask one question at a time. Focus areas: {{focus}}.
    - Prefer concrete outcomes. Ask for numbers only if the user knows them, and never estimate or invent.
    - After the user confirms a fact, stage it by running `{{add_command}} --source interview --json - <<'EOF' … EOF` with JSON fields `type`, `title`, `org`, `location`, `start`/`end` (YYYY-MM or present), `bullets`, `context`, `skills`, `tags`, plus `update: "<id>"` with the complete new content to change an existing entry.
    - Skills: `{"type":"skills","skills":{"<Category>":["…"]}}`.
    - Never edit files directly. Read the command's output (`proposed <pid> …` or `error: …`) and fix errors.
    - When done, tell the user to run `resumely profile review`.
  - CLI: `resumely interview [--harness <name>] [--focus <text>]`
    - Non-TTY → `UserError("interview needs an interactive terminal")`.
    - After the session it prints `<n> proposals staged — review them with: resumely profile review`, or `no proposals staged`.
    - Exit code = the harness exit code, or 0.
  - `tests/fixtures/fake-interactive.ts <workspace>`:
    - reads `<workspace>/resumely.json` and the JSON file named by `FAKE_INTERVIEW_PROPOSAL`
    - spawns `[...add, "--source", "interview", "--json", "-"]` with that JSON on stdin, inheriting `RESUMELY_HOME`
    - appends its own argv to `FAKE_INTERVIEW_ARGV` (JSON line), then exits with the child's code

- [ ] **Step 1: Write failing tests.**
  - `tests/config.test.ts`: `[adapters.claude] interactive_command = ["x","{prompt}"]` parses. A non-array value → `UserError`.
  - `tests/interview.test.ts` (temp root + Jordan profile):
    - `resolveInteractive("codex", cfg)` contains `"--add-dir"` and `"{inbox}"`. A user `interactive_command` wins. `[adapters.fake] command=[…]` without `interactive_command` → `UserError` with hint `interactive_command`.
    - `expandInteractive(["c", "--add-dir", "{inbox}", "{prompt}"], { prompt: "P", workspace: "/w", inbox: "/i" })` deep-equals `["c", "--add-dir", "/i", "P"]`.
    - With an injected `spawn`:
      - `argv` ends with `INTERVIEW_PROMPT`
      - `cwd` is the workspace and its basename is `interview`
      - `env.RESUMELY_HOME === root`
      - the workspace `instructions.md` contains `profile add` and the focus text `"Kafka, team leadership"`
      - `profile.json` has no `Compensation`
      - `resumely.json.add[0] === process.execPath`
    - End to end: config `[adapters.fake] interactive_command = ["bun", "<fixtures>/fake-interactive.ts", "{workspace}"]` and `FAKE_INTERVIEW_PROPOSAL` = a new Acme experience. The real spawn gives `exitCode 0` and `proposals.length === 1`, and `proposals[0].source.kind === "interview"`.
    - `spawn` throwing ENOENT → `HarnessError` with kind `not_installed`.
  - `tests/cli.test.ts`: `interview` with stdin ignored → exit 1, "needs an interactive terminal".
- [ ] **Step 2: Run** `bun test tests/interview.test.ts tests/config.test.ts tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: resumely interview launches the harness interactively`

---

### Task 9: CLI for import / lint / trace, the new-user path, README, real-harness check

**Files:**
- Modify:
  - `src/cli.ts` (additive `profile import`, `profile lint`, `trace` blocks; ≤ 3 lines in `init`; ≤ 3 lines in `apply`)
  - `src/profile/inbox.ts` (add `profileReadiness`)
  - `README.md`
- Test: `tests/cli.test.ts` (new cases)

**Interfaces:**
- Consumes: `importProfile` (Task 5), `lintProfile` / `formatLint` (Task 2), `buildTrace` / `formatTrace` (Task 3), `listProposals` (Task 1), `findApplication`.
- Produces:
  - **`profile import <file|url> [--harness <name>]`.** Progress goes to stderr.
    - When something was staged, stdout shows `staged <n> proposals:`, then one line per proposal: `  <pid>  <kind>  <id|skills|about>  <title @ org>` plus `  ! <flag>` lines.
    - Then `skipped:` lines and `warning:` lines.
    - Then `next: resumely profile review`.
    - With nothing staged: `nothing new found in <ref>`. Exit 0.
  - **`profile lint [--json]`:** prints `formatLint`, or the issues as JSON with `--json`. Exit 1 if any issue has severity `error`.
  - **`trace <app> [--version N] [--cover] [--json]`:** `buildTrace(findApplication(...).dir, cover ? "cover-letter" : "resume", parseVersion(version))`, printed with `formatTrace`, or as JSON with `--json`.
  - **`init`** prints this after the existing line:
    ```
    Next:
      resumely profile import ~/Downloads/resume.pdf   # or a LinkedIn PDF, .docx, .md, or a URL
      resumely profile review                          # accept what's right
      resumely apply --clip                            # tailor to a job
    ```
  - **The `program` description / `addHelpText("after", …)`** gets a `Getting started:` block with the same 4 commands (init, import, review, apply).
  - **`apply`**, before `resolveJobInput`, through a helper `profileReadiness(profileDir): { error?: UserError; warnings: string[] }` exported from `src/profile/inbox.ts`:
    - zero entries → `UserError("Your profile has no entries yet", "Run: resumely profile import <resume.pdf>, then resumely profile review")`
    - pending proposals → the warning `<n> profile proposals awaiting review (resumely profile review)`
  - **After printing gaps**, `apply` prints `hint: if any of these are true, add them: resumely interview --focus "<g1>, <g2>, …"` (the first 5 gap requirements).
- [ ] **Step 1: Write failing tests** in `tests/cli.test.ts` (fake harness, temp root):
  - `init` in a fresh `RESUMELY_HOME` → stdout contains `resumely profile import`.
  - `profile import tests/fixtures/import/resume.md` with the Task 5 happy-path script under the step `import` → exit 0. Stdout contains `staged 3 proposals`, `exp-acme-robotics` and `next: resumely profile review`. Then `profile review --accept-all` → `profile show exp-acme-robotics` exits 0.
  - `profile import nope.rtf` → exit 1 and `hint: Use .pdf`.
  - `profile lint` on Jordan → exit 0 and stdout contains `outcome-less-bullet`. After corrupting `projects/routekit.md` → exit 1 with `parse-error`. `profile lint --json` → valid JSON array.
  - After a full fake `apply` (the existing P2 CLI script): `trace <app>` contains `resume v1` and `exp-atlas-labs`; `trace <app> --cover` contains `paragraph 1`; `trace <app> --json` parses to an object with `kind === "resume"` and `rows.length > 0`.
  - `apply` against a profile whose entries were all deleted → exit 1, `hint: Run: resumely profile import`, and the fake `.calls` file is absent (no agent call).
  - With one pending proposal, `apply` stderr contains `profile proposals awaiting review`. P2's gap output is followed by `resumely interview --focus`.
- [ ] **Step 2: Run** `bun test tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the CLI blocks and `profileReadiness`.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Real-harness import check.** Use a temp `RESUMELY_HOME` after `init`, with the source the PDF of a P2 fixture compile (or `tests/fixtures/import/resume.md` converted with `textutil -convert docx`).
  - Run `profile import <pdf> --harness claude`, then `--harness codex`, then `--harness pi` (with the provider override from the README), each in a fresh root.
  - Expected each time: exit 0, ≥ 3 proposals staged, `about` proposes the name/email (replacing the init placeholders), and no proposal flagged with an invented number.
  - Then run `profile review --accept-all` and `profile lint`. Expected: no `error` lines.
  - If a harness can't read `source.txt`/`source.pdf` under the current preset, fix the prompt (not the preset) and re-run.
- [ ] **Step 6: Interactive preset check (human-in-the-loop).** Interactive TTY sessions can't be driven by an agent.
  - For each of claude, codex and pi, run `resumely interview --harness <h> --focus "test"` in a real terminal.
  - Confirm that the session opens in the workspace, that the agent reads `instructions.md`, and that one `profile add` call succeeds (for codex: inside the sandbox, writing to the inbox through `--add-dir`).
  - If an executor can't open a terminal, list these three commands for the user in the final report instead of claiming them verified.
  - Fix `INTERACTIVE_PRESETS` if a flag is rejected.
- [ ] **Step 7: Update `README.md`:**
  - Quickstart becomes init → `profile import` → `profile review` → `apply`.
  - A new "Building your profile" section covering:
    - supported import sources and their requirements (pdftotext for PDF; textutil/pandoc/unzip for DOCX; URLs fetched by resumely itself, an extension of the "job URLs only" network rule to URLs you pass to import)
    - the inbox and review keys
    - the scripted review flags
    - `profile add` with the heredoc example
    - `interview` and `interactive_command`
    - the truthfulness rule for imports (numbers must be in the source; unsourced names are flagged)
  - `profile lint` codes.
  - `trace`.
  - Move these items from "Coming next" to "Works now".
- [ ] **Step 8: Commit** `feat: profile import/lint/trace CLI, new-user path; docs`

---

## Spec decisions made in this plan

1. **Inbox format.** One JSON proposal per file, `profile/.inbox/<n>-<slug>.json`, with a numeric pid prefix so it is easy to type (`--accept 3`). Decided proposals move to `.inbox/archive/` with a `decision` (an audit trail for a bad import). The live entry Markdown is rendered only on accept.
2. **Updates carry full content.** Accepting an update re-attaches the live file's `## Private` sections verbatim, since the agent never saw them. Same for `about.md`'s `private:` key and private body sections.
3. **Truthfulness split.**
   - Errors (the agent retries): unsourced numbers, start/end years, skills, about email/phone/links/name.
   - Review flags: unsourced proper nouns, because false positives would otherwise exhaust retries.
   - Year-only source dates are omitted (no invented months) and stated in the rationale.
4. **DOCX** is converted to text deterministically (textutil → pandoc → unzip + XML strip), because the validator needs the text. PDFs require `pdftotext`; the original PDF is also given to the agent as a layout reference only.
5. **Ids are assigned by resumely**, never the agent. Deterministic duplicate detection (same type plus same org/title, or overlapping dates at the same org) turns a `new` into a `duplicate`. Non-interactive accept of a duplicate requires `--as update|new`, and `--accept-all` skips duplicates.
6. **`interview` presets live in `src/profile/interview.ts`**, not `adapter.ts` (to avoid P3 conflicts). `{inbox}` is an interview-only placeholder.
   - codex gets `--add-dir {inbox}` because of its sandbox.
   - No harness pre-approves shell commands, so the harness's own permission prompt gates each `profile add`.
   - The add command is resumely's own absolute invocation (`selfCommand`), so it works without `bun link`. `RESUMELY_HOME` is passed to the child.
7. **`lintProfile(root)`** takes the data root, and `file` is relative to it. `unused-entry` is skipped until at least one trace exists. Education `end` in the future is allowed (expected graduation).
8. **`buildTrace`** keeps the given interface and adapts the P2 shapes.
   - Cover rows put `co-N` company-fact ids into `entry_ids`.
   - Flags come from `checks.json` `fabrication_warnings` (non-empty only in stretch mode, since truthful mode rejects them).
   - `gaps` = the writer's gaps plus deterministic `keywords.absent`.
9. **URL import** is resumely's own network use, beyond §2's "job URLs only". It is user-initiated, and the README says so.
10. **`apply` refuses an empty profile** and warns about pending proposals, which closes the new-user path.
