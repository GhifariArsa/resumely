# resumely P2 — Generation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `resumely apply` produces a reviewed resume **and** cover letter. The pipeline is parse → company research → writer → validate (incl. fabrication scan) → render/compile → hard facts (pages, fill, ATS, keywords) → HR-persona reviewer → revise, up to `max_review_rounds`. The resume and cover-letter loops run concurrently. The CLI gains stretch mode, the duplicate guard, `--review` pause, `status` / `note` / `export`, and sent-version pinning.

**Architecture:** This builds on P1's deterministic core: the agent writes JSON only, item headers resolve from entries, and runs are file-based through `runAgentStep`. New pieces:
- a generic `refine()` loop shared by both document kinds
- a `checks/` module of deterministic PDF and text checks
- a research step with structured, URL-cited company facts
- a cover-letter schema and template rendered from the same header data as the resume

**Tech Stack:** As in P1, with `pdftotext` (poppler) added at runtime for the ATS check; it is optional and degrades to a warning.

**Spec:** `design.md`. Read §2, §7, §8 (all), §10, §11 and §12 before starting any task. The P1 plan (`docs/superpowers/plans/2026-11-10-resumely-p1-vertical-slice.md`) explains the existing modules.

**Out of scope (P3+):** `modern` / `traditional` / `minimal` templates, `doctor`, checkpoint/`resume`, profile import/inbox/interview, `resumely ui`, `$EDITOR` intake, harness fallback.

## Global Constraints

- **Truthful by default.** The agent may select, reorder, rephrase, emphasise and mirror JD keywords. It may not invent skills, employers, titles, dates, metrics or credentials.
- **Stretch mode (`--stretch`).** Allows `basis: "inferred"` bullets and skills evidenced in entry bodies but not listed. It never allows new employers, titles, dates, degrees, certs or numeric metrics. Every inferred claim is listed for review at the end of `apply`.
- **Fabrication scanner.** Every number/metric and capitalised proper noun in generated text must appear in the cited entries, or for the cover letter in the cited company facts. In truthful mode a hit is a validation error, so the writer retries. In stretch mode it is a warning recorded in `checks.json`.
- **Reviewer inputs.** The reviewer sees the PDF, its extracted text, the JD and the hard facts. It never sees the profile. Reviewer requests that can't be met truthfully become gaps, never fabrications: every revision goes through the same validator.
- **Review loop.** `max_review_rounds` defaults to **2** in config. One round is a review followed, on `revise` or `pages > target`, by a revision. The resume worst case is write + 2 × (review + revise) = 5 agent calls. `--no-review` skips the loop.
- **Cover letter.** Always 1 page, ~250–350 words (validator bounds **200–400**), 3–5 paragraphs. No banned phrases: the default list plus config `banned_phrases`. The opening is specific to the company and role. Two evidence paragraphs are built from entry context. Close is short. Use `"Dear Hiring Team"` when no hiring manager is named in the JD, and never guess a name.
- **Voice samples.** `profile/voice/*` (`.md` / `.txt`) are a style reference only, never a content source.
- **Research.** Default on; `--no-research` turns it off. It runs once per Application and is reused across versions. Only company and role go to search. Every fact carries a `source_url`. It is skipped for confidential/agency postings and for harnesses without a research command (with a warning).
- **Gates.**
  - The ATS parse check failing means `ready: false`.
  - `resumely status <app> applied` refuses while the latest version of any document kind is not ready, unless `--force` is given.
  - Keyword coverage is informational.
- **Version pinning.** `resumely status <app> applied` records `sent.resume` / `sent.cover_letter` = the latest version numbers in `application.toml`.
- **Duplicate guard.** On a URL or company+role match, ask: new version in the existing Application, or a new Application. On a non-TTY with neither `--into <app>` nor `--new`, abort with a hint. This is the only interactive prompt besides `--review`.
- **Harness commands** are argv arrays and never pass through a shell. P1 rules still hold:
  - header comes from `about.md`
  - private content stripped
  - max 2 retries per agent step
  - per-call timeout from `timeout_minutes`
  - no version dir until compile succeeds
- **Send-ready names.** `{First}_{Last}_Resume_{Company}.pdf` and `{First}_{Last}_Cover_Letter_{Company}.pdf`.

## Review Focus

1. **Concurrent resume/cover loops and one failing.** The other document must still be saved, the failure must be reported with its workspace, and the exit code is 1. Test in Task 7.
2. **Reviewer asks for something untruthful** (e.g. "add Kubernetes"). The revised content still goes through `validateResume` and an unsupported skill is rejected and retried, never saved. Test in Task 6.
3. **Harness without web tools (pi) or a confidential posting.** Research is skipped with a warning. The cover letter is still produced, with no company-fact citations. Test in Task 4 and Task 7.
4. **`pdftotext` missing.** The ATS check is reported as `skipped` with an install hint, `ready` stays `true`, and nothing crashes. Test in Task 2.
5. **Duplicate apply on a non-TTY with no flag.** A one-line actionable error, exit 1, and no new application folder. Test in Task 8.

---

## File Structure

```
src/config.ts                      # + max_review_rounds, banned_phrases, adapters[].research_command
src/harness/adapter.ts             # + research presets, resolveAdapter(..., { research })
src/render/compile.ts              # + fill ratio from log marker; fixed 120s compile timeout
src/render/pdftext.ts              # pdftotext wrapper (optional dependency)
src/render/render.ts               # + renderCoverLetter
src/checks/ats.ts                  # ATS parse check
src/checks/keywords.ts             # keyword coverage
src/checks/fabrication.ts          # numbers/proper-noun scanner
src/checks/facts.ts                # assemble HardFacts for a compiled document
src/pipeline/schemas.ts            # + CompanyResearch, CoverLetterContent, Review
src/pipeline/validate.ts           # + mode "stretch", warnings, validateCoverLetter, validateResearch, validateReview
src/pipeline/banned.ts             # default banned phrases
src/pipeline/research.ts           # research step + company.md rendering
src/pipeline/refine.ts             # generic write → produce → review → revise loop
src/pipeline/version.ts            # save a finished document version (both kinds) — moved out of apply.ts
src/pipeline/apply.ts              # orchestration only
src/pipeline/prompts/{research-company,write-cover-letter,review-resume,review-cover-letter,revision}.md
src/application/store.ts           # + findDuplicate, saveMeta, setStatus, addNote, export helpers
src/profile/load.ts                # + loadVoiceSamples
templates/classic/cover-letter.tex.njk
src/cli.ts                         # new flags/commands
tests/fixtures/fake-harness.ts     # step-keyed scripts (Task 1)
tests/fixtures/company.json  tests/fixtures/cover-letter.json  tests/fixtures/review-*.json
```

---

### Task 1: Config, research adapters, step-keyed fake harness

**Files:**
- Modify: `src/config.ts`, `src/harness/adapter.ts`, `src/pipeline/workspace.ts`, `tests/fixtures/fake-harness.ts`, `tests/apply.test.ts` (migrate scripts)
- Test: `tests/config.test.ts`, `tests/adapter.test.ts`, `tests/apply.test.ts`

**Interfaces:**
- Produces:
  - `Config` adds:
    - `max_review_rounds: number` (int ≥ 0, default 2)
    - `banned_phrases: string[]` (default `[]`)
    - `AdapterConfig.research_command?: string[]`, with the same placeholders as `command`
  - `PRESETS[...].research_command`:
    - claude: `["claude","-p","{prompt}","--permission-mode","acceptEdits","--allowedTools","Read Write Edit Glob WebSearch WebFetch"]`
    - codex: `["codex","--search","exec","--skip-git-repo-check","-s","workspace-write","-C","{workspace}","{prompt}"]`
    - pi: none
  - `resolveAdapter(name, cfg, opts?: { research?: boolean }): AdapterConfig | null`. With `research: true` it returns `{ ...a, command: a.research_command }`, or `null` when there is no research command. Without it, the behaviour is unchanged (never null). Overload the types so callers without `research` get a non-null `AdapterConfig`.
  - `createRunWorkspace(runsDir, step: string, runId?)`: `step` is now any `/^[a-z0-9-]+$/` name.
  - Fake harness script format, replacing the P1 index format:
    - shape: `{ "<step>": [ { "<relative path>": json | "INVALID" }, ... ] }`
    - `<step>` is `basename(workspace)`
    - array index = attempt number for that workspace, counted in `<workspace>/.fake-count`
    - extra attempts reuse the last element
    - an empty object means "write nothing"
    - `FAKE_HARNESS_EXIT=1` behaviour is kept
    - `FAKE_HARNESS_FAIL_STEP=<step>` exits 1 with "usage limit reached" only for that step
    - the harness also appends `<step>` to `<script>.calls` (one per line) so tests can assert call order and counts

- [ ] **Step 1: Write failing tests.**
  - config defaults: `max_review_rounds === 2` and `banned_phrases` deep-equals `[]`; `max_review_rounds = -1` gives `UserError`.
  - `resolveAdapter("pi", cfg, { research: true }) === null`.
  - `resolveAdapter("claude", cfg, { research: true }).command` includes `"WebSearch WebFetch"` in the `--allowedTools` value.
  - A user `[adapters.claude] research_command = [...]` overrides the preset.
  - Fake harness: step-keyed attempts (the second attempt uses `[1]`); `FAKE_HARNESS_FAIL_STEP`; the `.calls` log.
  - P1 apply tests are migrated to the new format (`parse`, `write` keys) and still pass.
- [ ] **Step 2: Run** `bun test tests/config.test.ts tests/adapter.test.ts tests/apply.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat: research adapters, review config, step-keyed fake harness`

---

### Task 2: Hard facts — fill ratio, PDF text, ATS check, keyword coverage

**Files:**
- Create: `src/render/pdftext.ts`, `src/checks/ats.ts`, `src/checks/keywords.ts`, `src/checks/facts.ts`
- Modify: `src/render/compile.ts`, `templates/classic/resume.tex.njk`
- Test: `tests/checks.test.ts`, `tests/compile.test.ts`

**Interfaces:**
- Produces:
  - **Fill marker.** Every template prints `\par\message{RESUMELY-FILL \the\pagetotal\space\the\textheight}` immediately before `\end{document}`. `compileTex` returns `{ pdf, pages, log, fill: number | null }`, where `fill = pagetotal / textheight` (pt values parsed from the log, clamped to 0..1) and `null` if the marker is absent. The default timeout becomes fixed at 120 s, independent of `timeout_minutes`, which settles the P1 minor.
  - `extractPdfText(pdf: Uint8Array): Promise<string | null>`. It runs `pdftotext -enc UTF-8 <tmp.pdf> -` through `spawnWithTimeout` (10 s) and returns `null` if `pdftotext` is not installed (ENOENT).
  - `type AtsResult = { status: "ok" | "failed" | "skipped"; problems: string[]; hint?: string }`
  - `atsCheck(text: string | null, expect: { name: string; email?: string; phone?: string; headings: string[]; snippets: string[] }): AtsResult`
    - `null` text gives `skipped` with hint `"Install poppler for the ATS check (macOS: brew install poppler)"`.
    - It normalises both sides by: replacing ligatures `ﬁ→fi`, `ﬂ→fl`, `ﬀ→ff`, `ﬃ→ffi`, `ﬄ→ffl`; removing soft hyphens; removing line-break hyphenation `-\n` between letters; collapsing all whitespace to single spaces; lowercasing.
    - Problems:
      - `name not extractable` / `email not extractable` / `phone not extractable` (phone digits compared digits-only)
      - `heading "<h>" missing or out of order` (each heading must appear after the previous one)
      - `garbled text (U+FFFD)` if `�` appears
      - `text not continuous: "<first 40 chars>…"` for each snippet not found
  - `type KeywordCoverage = { present: string[]; missed_in_profile: string[]; absent: string[] }`
  - `keywordCoverage(keywords: string[], documentText: string, profileText: string): KeywordCoverage`. Matching is case-insensitive whole-token (escape regex specials, so `C#`, `Node.js` and `C++` work). Keywords are de-duplicated case-insensitively, keeping first-seen order.
  - `type HardFacts = { pages: number; target_pages: number; fill: number | null; overflow: boolean; underflow: boolean; word_count: number; keywords: KeywordCoverage; ats: AtsResult; fabrication_warnings: string[] }`
    - `overflow = pages > target`
    - `underflow = pages === target && fill !== null && fill < 0.85`
    - `word_count` comes from the extracted text, or from the content text when extraction is null
  - `buildHardFacts(o: { pdf: Uint8Array; pages: number; fill: number | null; targetPages: number; atsExpect: …; keywords: string[]; profileText: string; contentText: string; fabricationWarnings?: string[] }): Promise<HardFacts>`

- [ ] **Step 1: Write failing tests.**
  - `keywordCoverage(["TypeScript","C#","Rust","Kafka"], "…typescript and C# …", "…Kafka…")` gives present `[TypeScript, C#]`, missed_in_profile `[Kafka]`, absent `[Rust]`. Also check that `Java` does not match `JavaScript`.
  - `atsCheck` on synthetic text with a broken ligature and hyphenation still finds the snippets. Each problem string fires on a crafted input. `null` text gives `skipped` plus the hint.
  - (latexmk-gated) compiling the fixture resume returns `0 < fill <= 1`.
  - (pdftotext-gated) `extractPdfText` on the compiled fixture contains `Jordan Example`.
  - `atsCheck` on the real compiled fixture text, with the fixture's headings and bullet snippets, gives `ok`.
  - With `PATH` lacking pdftotext (spawn a stub `PATH`), `extractPdfText` resolves `null`.
- [ ] **Step 2: Run** `bun test tests/checks.test.ts tests/compile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run the full suite.
- [ ] **Step 5: Commit** `feat: hard facts — fill ratio, pdf text, ATS check, keyword coverage`

---

### Task 3: Fabrication scanner and stretch mode

**Files:**
- Create: `src/checks/fabrication.ts`
- Modify: `src/pipeline/validate.ts`, `src/pipeline/workspace.ts` (`ValidationResult` warnings plumbing)
- Test: `tests/fabrication.test.ts`, `tests/validate.test.ts`

**Interfaces:**
- Consumes: `Profile` / `Entry` (`body`, `title`, `org`, `skills`, `tags`), `ResumeContent`.
- Produces:
  - `ValidationResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] }`. Update existing validators to return `warnings: []`, and make `runAgentStep` return `{ value, warnings }` instead of `T`. Update all call sites.
  - `scanClaims(text: string, sources: string[]): string[]` returns the unsourced tokens.
    - Numbers: `/\$?\d[\d,.]*\s?(%|k|m|b|x|\+)?/gi`. A number is sourced if its digits-only form (`$5M` → `5`, `1.2k` → `12`, `2,000` → `2000`) equals the digits-only form of some number the same regex finds in the sources.
    - Proper nouns: tokens matching `/\b[A-Z][a-zA-Z0-9+#.]*[A-Za-z0-9+#]\b/` or containing an internal capital/digit/`#`/`.`/`+`. Exclude: the first word of each sentence; a stop list (`I`, `A`, `The`, `We`, months, weekdays); and tokens present in a built-in list of generic capitalised words (`Senior`, `Engineer`, `Team`, `API`, `REST`, `CI`, `CD`, `SQL`, `UI`, `UX`, `RFC`, `B.Sc.`, `M.Sc.`, `PhD`). A proper noun is sourced if it appears case-insensitively as a whole token in the sources.
  - `validateResume(raw, profile, mode: "truthful" | "stretch")`. For each bullet and the summary, `sources` = title, org, body, skills and tags of every cited entry, plus all profile skill values. Behaviour by mode:
    - truthful: each unsourced token is an error `<path>: "<token>" is not supported by the cited entries`
    - stretch: each unsourced token is a warning with the same text
    - stretch also accepts `basis: "inferred"`, and skills items found as whole tokens in any entry body (in addition to listed skills)
    - truthful behaviour is otherwise unchanged

- [ ] **Step 1: Write failing tests.**
  - `scanClaims("Cut load time by 60% for 2M users at Atlas Labs", ["Rebuilt dashboard, 60% faster; 2M events", "Atlas Labs"])` gives `[]`.
  - `scanClaims("Increased revenue 30% at Google", [...same])` gives `["30%","Google"]`.
  - A sentence-initial `Built` is not flagged, and `C#` is sourced when present in the sources.
  - The fixture `resume-content.json` validates clean in truthful mode, so there are no false positives on the fixture.
  - A bullet with `"Scaled Kafka pipelines"` citing `exp-atlas-labs` gives a truthful error mentioning `"Kafka"`; in stretch it gives `ok` with a warning.
  - A stretch `basis: "inferred"` bullet gives `ok`.
  - A stretch skill `"Kubernetes"` is accepted only if some entry body contains it. The fixture `exp-northwind` mentions Kubernetes, so check that `"Kubernetes"` is accepted in stretch and rejected in truthful unless listed. Check `skills.yaml` first and pick a body-only term if Kubernetes is listed.
- [ ] **Step 2: Run** `bun test tests/fabrication.test.ts tests/validate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those tests plus the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fabrication scanner, stretch mode`

---

### Task 4: Company research step

**Files:**
- Create: `src/pipeline/research.ts`, `src/pipeline/prompts/research-company.md`, `tests/fixtures/company.json`
- Modify: `src/pipeline/schemas.ts`, `src/pipeline/validate.ts`
- Test: `tests/research.test.ts`

**Interfaces:**
- Produces:
  - `CompanyResearch = { company: string; summary: string; facts: { id: string /* ^co-\d+$ */; text: string; source_url: string }[] (min 1, max 15); sources: string[] }`
  - `validateResearch(raw): ValidationResult<CompanyResearch>`. Rules:
    - every `source_url` is `http(s)://` and listed in `sources`
    - fact ids are unique
    - all text passes `unsupportedChars`
  - `renderCompanyMd(r: CompanyResearch): string`: `# <company>`, then the summary, `## Facts`, `- <text> [<id>](<url>)` bullets and `## Sources`.
  - `isConfidential(job: ParsedJob): boolean` — `/confidential|undisclosed|stealth|via .+ (recruit|agency)/i` on the company.
  - `runResearch(o: { adapter: AdapterConfig | null; name: string; runsDir: string; runId: string; appDir: string; job: ParsedJob; jobText: string; timeoutMs: number; onProgress? }): Promise<{ research: CompanyResearch | null; warning?: string }>`
    - If `<appDir>/job/company.json` exists and validates, reuse it (no agent call).
    - Else if `isConfidential` → `{ research: null, warning: "research skipped: confidential/agency posting" }`.
    - Else if `adapter === null` → `{ research: null, warning: "research skipped: <name> has no web tools (set adapters.<name>.research_command)" }`.
    - Else run the agent step `research` with `job.md` and `parsed-job.json` only (**never the profile**), and save `job/company.json` and `job/company.md`.
    - A failing research step (exhausted retries or a HarnessError) becomes a warning `research failed: <message> (logs: <ws>)`, never a fatal error.
- Prompt `research-company.md`:
  - search the company's own site, engineering blog and recent news
  - 5–12 concise facts useful for a cover-letter opening (product, customers, recent launches, engineering stack/culture, mission)
  - every fact must come from a page you actually opened, with its URL
  - no facts about individuals
  - write `out/company.json` per `company.schema.json`
  - if you can't find reliable information, write fewer facts rather than guessing

- [ ] **Step 1: Write failing tests** (fake harness):
  - The happy path writes `job/company.json` and `company.md`. The `.calls` log shows `research`, and its workspace has no `profile.json`.
  - A second run reuses the existing file: no `research` call is logged.
  - A confidential company gives a warning and no call.
  - A null adapter gives the warning text above.
  - `FAKE_HARNESS_FAIL_STEP=research` gives `research: null` plus a warning containing `logs:`.
  - The validator rejects a fact with a `source_url` not in `sources`, and an `ftp://` URL.
- [ ] **Step 2: Run** `bun test tests/research.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: company research step with cited facts`

---

### Task 5: Cover letter content, validation, template

**Files:**
- Create: `src/pipeline/banned.ts`, `src/pipeline/prompts/write-cover-letter.md`, `templates/classic/cover-letter.tex.njk`, `tests/fixtures/cover-letter.json`
- Modify: `src/pipeline/schemas.ts`, `src/pipeline/validate.ts`, `src/render/render.ts`, `templates/classic/template.toml` (`supports = ["resume","cover-letter"]`), `src/profile/load.ts`
- Test: `tests/cover-letter.test.ts`

**Interfaces:**
- Produces:
  - `CoverLetterContent = { greeting: string; paragraphs: { text: string; entry_ids: string[]; company_fact_ids: string[] }[] (3..5); closing: string /* e.g. "Sincerely," */ }`
  - `DEFAULT_BANNED: string[]`: "thrilled", "passionate about", "leverage", "leveraging", "I am writing to express", "I am writing to apply", "delve", "fast-paced environment", "team player", "synergy", "excited to apply", "dynamic", "go-getter", "think outside the box", "hit the ground running", "I believe I would be a great fit", "tapestry", "testament to".
  - `validateCoverLetter(raw, o: { profile: Profile; research: CompanyResearch | null; banned: string[]; mode: "truthful" | "stretch" }): ValidationResult<CoverLetterContent>`. Errors:
    - unknown entry ids / company fact ids (`company_fact_ids` must be empty when research is null)
    - word count over all paragraphs outside 200–400 → `word count <n> (must be 200–400)`
    - banned phrase hit (case-insensitive, word-bounded) → `paragraphs[i]: banned phrase "<p>"`
    - unsupported characters
    - fabrication scan per paragraph, with sources = cited entries' text + cited company facts' text + company name (truthful → error, stretch → warning)
    - `greeting` must be `"Dear Hiring Team,"` unless the JD text contains the named person. Implement as: greeting matches `/^Dear (Hiring Team|[A-Z][\w.'-]+( [A-Z][\w.'-]+)*),$/`; any name must appear in `jobText`. Pass `jobText` in `o`.
  - `renderCoverLetter(t: TemplateMeta, data: { about: About; letter: CoverLetterContent; job: { company: string; role: string }; date: string }): string`. Renders `cover-letter.tex.njk`, and throws `UserError` if the template doesn't support `cover-letter`.
  - `templates/classic/cover-letter.tex.njk`:
    - same preamble and header block as `resume.tex.njk` (name, contact line)
    - then date, `Hiring Team` / company line, `Re: <role>`, the greeting, the paragraphs, then the closing and name
    - `\pdfgentounicode=1`, the fill marker, and hypersetup metadata `pdftitle={<name> — Cover Letter}`
    - Extract the shared header into a Nunjucks include `header.tex.njk` used by both files.
  - `loadVoiceSamples(profileDir: string): { name: string; text: string }[]`. Reads `voice/*.md|*.txt`, applies `stripPrivate`, skips empty files and caps at 3 files / 3000 chars each.
- Prompt `write-cover-letter.md`. It reads `profile.json`, `job.md`, `parsed-job.json`, `company.json` (if present), `voice/` and `banned.json`, and writes `out/cover-letter.json`. Rules:
  - voice samples are a style reference only, never content
  - the opening ties to a specific company fact (cite its id) or, without research, to a specific JD detail
  - 2 evidence paragraphs, each built from one entry's context/stories, citing it
  - a short concrete close
  - 250–350 words
  - no banned phrases
  - `"Dear Hiring Team,"` unless the JD names a person
  - the truthfulness rules from design §2 verbatim

- [ ] **Step 1: Write failing tests.**
  - The fixture `cover-letter.json` (citing Jordan entries and `tests/fixtures/company.json` facts) validates.
  - Each error class above fires on crafted variants: 150 words; "thrilled"; unknown `co-9`; a made-up `"Dear Sarah Chen,"`; and `"$10M"` unsourced.
  - `"Dear Hiring Team,"` passes.
  - (latexmk-gated) rendering and compiling the fixture letter gives 1 page; the `.tex` contains `Re:` and the escaped company name.
  - `loadVoiceSamples` strips `## Private` and caps files.
- [ ] **Step 2: Run** `bun test tests/cover-letter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run the full suite: `render.test.ts` must still pass after the header include refactor.
- [ ] **Step 5: Commit** `feat: cover letter schema, validation, classic cover template`

---

### Task 6: Reviewer and the refine loop

**Files:**
- Create: `src/pipeline/refine.ts`, `src/pipeline/prompts/review-resume.md`, `src/pipeline/prompts/review-cover-letter.md`, `src/pipeline/prompts/revision.md`, `tests/fixtures/review-pass.json`, `tests/fixtures/review-revise.json`
- Modify: `src/pipeline/schemas.ts`, `src/pipeline/validate.ts`
- Test: `tests/refine.test.ts`

**Interfaces:**
- Produces:
  - `Review = { impression: string; scores: { relevance: 1..5; keywords: 1..5; impact: 1..5; formatting: 1..5; voice?: 1..5 }; red_flags: string[]; requests: string[]; verdict: "pass" | "revise"; templated?: boolean }`
  - `validateReview(raw, kind: "resume" | "cover-letter")`. `revise` requires ≥ 1 request. Cover-letter reviews require `voice` and `templated`.
  - `type Produced = { tex: string; pdf: Uint8Array; pages: number; fill: number | null; facts: HardFacts; text: string }`
  - `refine<T>(o)` with options:
    ```
    {
      kind: "resume" | "cover-letter";
      runsDir: string;
      runId: string;
      adapter: AdapterConfig;
      name: string;
      timeoutMs: number;
      maxRounds: number;
      write: (ws: string, revision?: { previous: T; review: Review; facts: HardFacts }) => Promise<{ value: T; warnings: string[] }>; // wraps runAgentStep with the kind's prompt/files/validator
      produce: (value: T) => Promise<Produced>;
      reviewFiles: { "job.md": string };
      onProgress?;
    }
    ```
    It returns `Promise<{ value: T; produced: Produced; review: Review | null; reviewedFinal: boolean; rounds: number; warnings: string[] }>`.
    - Workspaces: `<kind>-write`, `<kind>-review-<r>`, `<kind>-revise-<r>`, where `<kind>` is `resume` or `cover`.
    - Algorithm:
      ```
      write → produce
      for r in 1..maxRounds:
        review(r)
        if verdict == pass and !facts.overflow: break
        revise(r) → produce
      ```
      `reviewedFinal` is false when the loop ended on a revision.
    - The review step gets `document.pdf`, `document.txt` (extracted text, or a plain-text rendering of the content when it's null), `job.md`, `hard-facts.json` and `review.schema.json`, and writes `out/review.json`. It **never gets profile.json**.
    - A failed or invalid review (exhausted retries) ends the loop, keeps the current version and adds the warning `review failed: … (logs: …)`.
    - A revision that fails validation after retries ends the loop, keeps the previous version and adds the warning `revision rejected: …`.
  - `revision.md` is appended to the writer instructions on revisions: "Read previous.json, review.json, hard-facts.json. Address every request that can be met truthfully. A request you can't meet truthfully becomes a gap, not a claim. Fix overflow by trimming the weakest bullets; on underflow, add only supported content."
  - Reviewer prompts (HR persona):
    - **Resume:** "You are an experienced technical recruiter doing a 6-second skim, then a careful read." Scores and verdict rules: `revise` when any score ≤ 3, on overflow, or on a red flag that matters; otherwise `pass`. Requests are concrete and point at a section or bullet. Never ask for skills or experience the document doesn't support ("if the role needs X and it's absent, note it as a red flag, not a request").
    - **Cover letter:** adds a `voice` score and `templated: true` if it reads as generic or AI-written. A templated letter must be `revise`.

- [ ] **Step 1: Write failing tests.** Use the fake harness with a stub `produce` that returns canned facts, so there is no LaTeX.
  - `pass` on the first review: the calls are `[write, review-1]`, rounds 1, reviewedFinal true.
  - `revise`, then `pass`: calls `[write, review-1, revise-1, review-2]`.
  - `revise`, `revise` with maxRounds 2: calls `[write, review-1, revise-1, review-2, revise-2]`, reviewedFinal false.
  - `maxRounds: 0`: only `[write]`, review null.
  - `pass` but overflow → a revision still happens.
  - **Review Focus 2:** the reviewer requests Kubernetes. The scripted revise output adds the `"Kubernetes"` skill (not in the profile) on all attempts. The real `validateResume` is wired into `write`. The revision is rejected, the previous value is kept and a warning is emitted, so the unsupported skill is never returned.
  - The review workspace contains no `profile.json`.
- [ ] **Step 2: Run** `bun test tests/refine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: HR reviewer and refine loop`

---

### Task 7: `apply` orchestration — research, concurrent resume + cover loops, versions, duplicate guard

**Files:**
- Create: `src/pipeline/version.ts`
- Modify: `src/pipeline/apply.ts`, `src/application/store.ts`, `src/pipeline/prompts/write-resume.md` (stretch section; revision hook)
- Test: `tests/apply.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `findDuplicate(appsDir, o: { url?: string; company: string; role: string }): Application | null`. Matches on `source.url` equality or a case-insensitive company+role match; most recent first.
  - `saveVersion(o: { app; kind: "resume" | "cover-letter"; about; files: Record<string, string | Uint8Array>; pdf: Uint8Array; filename: string; meta: object }): { dir; version; pdfPath }`. Allocates the version via `nextVersionDir` only when called, so callers call it last. The PDF is named with `sendReadyName(pattern, about, kind === "resume" ? "Resume" : "Cover_Letter", company)`.
  - **Version contents.** Resume: `resume.json`, `.tex`, the PDF, `trace.json`, `entries.snapshot.json`, `review.json` (if any), `checks.json` (`HardFacts` + warnings), `meta.json`. Cover letter: `cover-letter.json`, `.tex`, the PDF, `trace.json` (one row per paragraph with `entry_ids` + `company_fact_ids`), `entries.snapshot.json`, `company.snapshot.json` (cited facts), `review.json`, `checks.json`, `meta.json`.
  - `meta.json` adds `{ mode, ready, reviewed_final, rounds, research: "used" | "skipped" | "failed" }`, where `ready = ats.status !== "failed" && !overflow`.
  - `applyJob(opts)` adds:
    - `mode?: "truthful" | "stretch"`
    - `pages?: number`
    - `cover?: boolean` (default true)
    - `research?: boolean` (default true)
    - `review?: boolean` (default true; false → `maxRounds = 0`)
    - `pause?: (job: ParsedJob, likelyGaps: string[]) => Promise<boolean>` (resolves false → abort with `UserError("Aborted")`, keeping the application)
    - `onDuplicate?: (existing: Application) => Promise<"existing" | "new" | "abort">`. When absent, a duplicate gives `UserError("Already applied: <slug>", "Use --into <slug> to add a version, or --new for a separate application")`.

    It returns:
    ```
    {
      app;
      resume?: DocResult;
      cover?: DocResult;
      failures: { kind; message; hint? }[];
      gaps;
      inferred: { text: string; entry_ids: string[] }[];
      warnings: string[];
    }
    ```
    with `DocResult = { pdfPath; version; pages; ready; review: Review | null }`.
  - **Order:**
    1. checks
    2. parse
    3. duplicate check (URL check before the parse when the input has a URL; company+role after the parse) → `createApplication`, or reuse the existing app (its `job/parsed.json` stays; the new raw text is saved as `job/raw-<n>.md`)
    4. `pause`, with likely gaps = `keywordCoverage(job.requirements ∪ job.keywords, "", profileText).absent`
    5. research (with a research adapter, if enabled)
    6. `Promise.allSettled` over the resume refine and the cover refine
    7. save each successful document
    8. collect failures

    Progress messages are prefixed `[resume]` / `[cover]`. If both documents fail, rethrow the first error. If one fails, return with `failures` populated.
  - `write-resume.md` gains a `{{mode_rules}}` placeholder: the truthful rules, or the truthful rules plus the design §2 stretch rules verbatim, with "Mark every inferred bullet `basis: \"inferred\"`."
  - `renderApplication` keeps working for resumes and now uses `saveVersion` and `buildHardFacts`. Add `kind?: "resume" | "cover-letter"`; cover-letter re-rendering needs `cover-letter.json` + `company.snapshot.json`.

- [ ] **Step 1: Write failing tests** (fake harness, latexmk-gated):
  - The full happy path writes `resume/v1` and `cover-letter/v1` with every file listed above, and both are `ready`. The calls include `parse`, `research`, `resume-write`, `resume-review-1`, `cover-write`, `cover-review-1`. `meta.research === "used"`.
  - `cover: false` → no `cover-letter/`.
  - `research: false` → no research call; the cover letter validates with empty `company_fact_ids`.
  - **Review Focus 1:** `FAKE_HARNESS_FAIL_STEP=cover-write` → the resume is saved, `failures[0].kind === "cover-letter"` with the hint containing `logs:`.
  - Duplicate without `onDuplicate` → `UserError` "Already applied", and no new app dir. `onDuplicate → "existing"` → resume `v2` is created in the same app and research is reused (no second research call).
  - Stretch with a scripted inferred bullet → `inferred` contains it and `meta.mode === "stretch"`.
  - `pause` resolving false → `UserError("Aborted")`, and no writer calls happen.
- [ ] **Step 2: Run** `bun test tests/apply.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `version.ts` and `findDuplicate`.**
- [ ] **Step 4: Implement the `applyJob` orchestration and the prompt changes.**
- [ ] **Step 5: Run** the full suite. Expected: PASS.
- [ ] **Step 6: Commit** `feat: apply orchestration with research, concurrent resume+cover refine, duplicate guard`

---

### Task 8: CLI — flags, prompts, status / note / export, richer `ls` / `open`

**Files:**
- Modify: `src/cli.ts`, `src/application/store.ts`, `src/pipeline/apply.ts` (`formatApplicationList`)
- Create: `src/commands/prompt.ts` (TTY prompts)
- Test: `tests/store.test.ts`, `tests/cli.test.ts` (spawns `bun src/cli.ts` with `RESUMELY_HOME`; non-TTY)

**Interfaces:**
- Produces:
  - `ApplicationMeta` adds `sent?: { resume?: number; cover_letter?: number }` and `applied_at?: string`.
  - `saveMeta(app: Application): void` rewrites `application.toml`.
  - `setStatus(app, status, o?: { force?: boolean; now?: Date }): Application`. For `applied`, it loads the latest version's `meta.json` for each kind present. If any has `ready === false` and `!force`, it throws `UserError("<kind> v<N> is not ready: <reasons>", "Fix and re-run, or pass --force")`. Otherwise it sets `sent` and `applied_at`. Any other status just sets `status`.
  - `addNote(app, text, now?)` appends `"<ISO date>: <text>"`.
  - `exportApplication(app, o: { to: string; version?: number }): string[]` copies the latest (or given) resume PDF and the latest cover PDF into `to`, refusing to overwrite (`UserError` naming the file), and returns the paths.
  - `formatApplicationList` columns: `DATE COMPANY ROLE STATUS RESUME COVER SENT`, where:
    - `RESUME` / `COVER` show `vN`, with `!` appended when not ready
    - `SENT` is `r2/c1` or `-`
    - `ls --status <s>` and `--company <q>` filters are supported
  - CLI:
    - `apply` adds `--stretch`, `--pages <n>`, `--no-cover`, `--no-research`, `--no-review`, `--review` (pause), `--into <app>`, `--new`
    - `onDuplicate`: with `--into` (must match the found duplicate, else `UserError`) → `"existing"`; with `--new` → `"new"`; on a TTY → a prompt `Already applied (<slug>). [v]ersion in existing / [n]ew application / [a]bort:`; on a non-TTY → no callback, which aborts with the hint
    - `pause` only with `--review` on a TTY; with `--review` on a non-TTY it gives `UserError("--review needs an interactive terminal")`
    - After `apply` it prints, in order:
      - `done:` lines per document (ready / not-ready reasons)
      - failures
      - `inferred claims to review:` (stretch)
      - gaps
      - warnings
    - Exit code 1 if any failure or any not-ready document, else 0.
    - `status <app> <status> [--force]`, `note <app> <text...>`, `export <app> [--version N] [--to DIR]` (default `~/Desktop` if it exists, else cwd), `open <app> [--cover] [--version N]`.
    - `render` adds `--cover` to re-render the cover letter.

- [ ] **Step 1: Write failing tests.**
  - store: `setStatus applied` records `sent` from the latest versions; with a version `ready: false` it throws unless `force`; `addNote` format; `exportApplication` copies 2 files and refuses an overwrite; `findDuplicate` on URL and on company+role.
  - `formatApplicationList` shows `!` and `r1/c1`.
  - cli (fake harness configured in a temp root):
    - `apply <file>` exits 0 and stderr contains `done:` twice
    - a second `apply` of the same file exits 1 with `hint: Use --into` and leaves no third app dir
    - `apply --new` succeeds
    - `status <app> applied` then `ls` shows `applied` and `r1/c1`
    - `--review` on a non-TTY exits 1
- [ ] **Step 2: Run** `bun test tests/store.test.ts tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat: CLI flags, duplicate prompt, status/note/export, richer ls/open`

---

### Task 9: Real-harness verification and README

**Files:**
- Modify: `README.md`, and presets/prompts only if verification demands it.

- [ ] **Step 1:** Use a temp data root with the Jordan profile plus one voice sample. Run `apply tests/fixtures/jobs/backend.md --harness claude --no-open`.
  - Expected: exit 0 or 1 (only "not ready" is acceptable), both PDFs present, `meta.research` = `used`, review files present.
  - Render both PDFs to PNG and read them: the cover letter must read as specific, not templated, and within 1 page.
- [ ] **Step 2:** Run the same with `--harness codex`. This verifies `codex --search exec`. If `--search` is rejected in that position, fix the preset, for example by moving it after `exec` or using `-c tools.web_search=true`, then re-run.
- [ ] **Step 3:** Run `--harness pi` with the provider override from P1's README. Expected: the warning `research skipped: pi has no web tools`, and both documents still produced.
- [ ] **Step 4:** Run `--stretch` once with claude and check that an `inferred claims to review:` list appears (it may be empty).
- [ ] **Step 5:** Update the README:
  - the new flags
  - cover letters and voice samples
  - research and its privacy note (only company and role go to search)
  - the review loop and its typical duration
  - `status` / `note` / `export`
  - not-ready / gates
  - the "Works now / Coming next" lists
- [ ] **Step 6: Commit** `docs: P2 README; verify research/review presets`
