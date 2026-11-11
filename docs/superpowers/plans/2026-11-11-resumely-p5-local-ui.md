# resumely P5 — Local UI (`resumely ui`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `resumely ui [--port N] [--no-open]` starts an on-demand, localhost-only web viewer over the data root. It has three views: an applications board (kanban + list), an application view (PDF preview, version switcher, trace, gaps, HR review, checks, template re-render, status/notes, reveal/copy files), and a profile view (entries with where each was used, the agent context dump, lint results). The only writes are status, notes and re-render.

**Architecture:**
- **Server:** one `Bun.serve` bound to `127.0.0.1`, rendering HTML on the server from read models that call the existing modules: `store`/`tracking`, `version`, `rerender`, P3 `listTemplates`, P4 `buildTrace`/`lintProfile`, and `formatProfileContext`.
- **No front-end framework or build step.** Pages are plain HTML forms (POST → 303 redirect). One small vanilla ES module adds the trace hover highlight, copy-to-clipboard and a "Rendering…" state. Every view works without JS.
- **Why this approach:**
  - Escaping lives in one `html` tagged template.
  - Every view is a pure `data → string` function that tests can check with plain string assertions, with no DOM.
  - Nothing has to be compiled, so `npm i -g` and `bunx` work unchanged.
  - Assets resolve relative to the module, like `builtinTemplatesDir()`.
- **Security:**
  - The Host header must be the local server's (DNS-rebinding protection).
  - A foreign `Origin` is refused.
  - Every POST needs a per-launch random token.
  - Files are served only from version dirs under `applications/`, with a realpath containment check.
  - A strict CSP forbids inline script and inline style.

**Tech Stack:** Bun (`Bun.serve`, `bun test`), TypeScript strict. No new dependencies. Tests use `fetch` plus a raw-socket helper (`node:net`) for requests `fetch` would normalise, such as `..` segments and spoofed `Host` headers.

**Spec:** `design.md`. Read §3 (domain), §5 (data root layout), §6 "Inspection", §10 (all, especially "`resumely ui`") and §11 (checks) before starting any task. The P1 and P2 plans in `docs/superpowers/plans/` describe the existing modules.

**Depends on (already merged before P5 starts):**
- **P3** — `src/render/templates.ts`:
  - `interface TemplateInfo { id; name; description; engine; supports: ("resume"|"cover-letter")[]; source: "builtin"|"user"; dir; preview: string|null }`
  - `listTemplates(root: string): TemplateInfo[]`
- **P4** — `src/profile/lint.ts`:
  - `interface LintIssue { entry_id: string|null; file; severity: "error"|"warning"; code; message }`
  - `lintProfile(root: string): LintIssue[]`
- **P4** — `src/application/trace.ts`:
  - `interface TraceRow { section; text; entry_ids: string[]; basis: "direct"|"inferred"; flags: string[] }`
  - `interface TraceReport { app; kind; version; rows: TraceRow[]; gaps: string[]; warnings: string[] }`
  - `buildTrace(appDir, kind, version?): TraceReport`

Use these as they are and don't re-implement them. `renderApplication` (`src/pipeline/rerender.ts`) is used with its current options `{ root, query, template, version, kind, open }`. If P3 changed how it resolves templates, keep calling it the same way.

**Out of scope:**
- profile editing of any kind
- starting applications from the UI (design: post-v1)
- editing or deleting notes (append only, like `resumely note`)
- template preview images, which live in the package outside the data root
- a theme toggle (the theme follows the OS)
- auth beyond the per-launch token
- `bun build --compile` asset embedding (same limitation as `templates/` today)

## Global Constraints

- **Network.**
  - Bind `hostname: "127.0.0.1"` only.
  - Started on demand: no daemon, no PID file. Ctrl-C (SIGINT/SIGTERM) stops the server and exits 0.
  - **No network use:** no web fonts, CDNs or external scripts. This follows design §2: "Resumely's own network use is limited to fetching job URLs".
- **Default port `4317`.** If `--port` is not given and 4317 is busy, fall back to an OS-assigned port and print the actual URL. An explicit `--port N` that is busy is a `UserError` (`Port N is in use`, hint `Pick another with --port, or omit it`). `--port 0` means any free port.
- **Writes.** The UI writes only through:
  - `setStatus` (status; `applied` pins sent versions and refuses not-ready versions unless forced)
  - `addNote` (append)
  - `renderApplication` (always a new version, `open: false`)

  It writes nothing under `profile/`, and no other files.
- **Reveal** spawns the OS file manager (`open -R <file>` on macOS, `xdg-open <dir>` on Linux). It is a POST, so it needs the token.
- **Request guards:**
  - **Host.** Every request's `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive), else **403**.
  - **Origin.** A request with an `Origin` header that isn't `http://127.0.0.1:<port>` or `http://localhost:<port>` gets **403**.
  - **POST.** Every POST also needs:
    - form field `_token` equal to the launch token (constant-time compare)
    - `Origin` absent or local (`"null"` is refused)
    - `Sec-Fetch-Site` not `cross-site`

    Otherwise **403**.
  - **Body size.** `maxRequestBodySize: 65536`.
- **File serving.**
  - Only `/files/<slug>/<resume|cover-letter>/v<N>/<name>.(pdf|tex|json)`, mapped to `<root>/applications/<slug>/<kind>/v<N>/<name>`.
  - The realpath must be inside `realpath(<root>/applications)`.
  - Anything else (traversal, encoded traversal, symlinks out, other kinds or extensions, missing) is **404**.
  - Static assets come from a fixed allowlist of names in `src/ui/assets/`.
- **Escaping.**
  - All data text (application meta, agent-written content, profile text, file paths, error messages) goes through the `html` tag's escaping.
  - `raw()` is only for markup the code builds itself.
  - `href`s built from data use `safeHref` (http/https only); otherwise the text is rendered without a link.
- **CSP on every HTML response:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`. So views use no inline `<script>` bodies, no `style="…"` attributes and no `on*=` handlers. Score bars and other dynamic widths are done with classes (`.score-1`…`.score-5`) or `<meter>`.
- **Headers.**
  - All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`.
  - HTML: `Cache-Control: no-store`.
- **Freshness.** Every request re-reads the disk. No in-memory cache of applications, versions or the profile, because the CLI may change them while the UI is open.
- **Statuses** are exactly `drafted, applied, interviewing, rejected, offer` (design §3), in that order, everywhere.
- **Copy and accessibility.**
  - Copy is in sentence case. No all-caps labels. Buttons say what they do: "Save status", "Add note", "Re-render", "Copy path", "Show in Finder" (macOS) / "Open folder" (Linux), "Mark as applied anyway".
  - Visible `:focus-visible` outlines, honour `prefers-reduced-motion`, and no horizontal scroll at 360 px width.
- **Platforms:** macOS + Linux.
- **Verification.** `bun test` and `bunx tsc --noEmit` stay green after every task. Tests are LLM-free. LaTeX-dependent tests use `skipIf(!Bun.which("latexmk"))`.
- **Commits** end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Hand-edited or corrupt files in a version dir.** Examples: truncated `review.json`, unparsable `meta.json`, missing `trace.json` / `checks.json`. Expected: the application page still renders (200), shows the PDF and states which file couldn't be read, instead of a 500. Test in Task 2 (`problems`) and Task 4 (rendered notice).
2. **An application with no documents yet** (an `apply` whose writer failed: only `application.toml` + `job/`). Expected:
   - The board shows it with "No documents" instead of a crash.
   - Its page is 200 with an empty state that names the `resumely apply --into <slug>` command.

   Test in Task 2 and Task 4.
3. **The CLI changes data while the UI is open:** a new version appears, the status is set from the CLI, or an application dir is deleted. Expected: the next request reflects it, and a deleted app gives 404, not 500. Test in Task 6.
4. **A re-render that cannot succeed.** Examples: an unknown template, or a template without a cover-letter design used on a cover letter. Expected: 400 with the `UserError` message and hint shown on the application page, and no new (partial) version dir. Test in Task 7.
5. **A second `resumely ui` while one is running** (the default port is busy). Expected: the new one falls back to a free port and prints its URL. With an explicit busy `--port`: a one-line error and exit 1. Test in Task 6 (fallback) and Task 8 (CLI error).

---

## Design direction

**Subject and job.** This is a private workbench for one job seeker. It answers two questions:
- "What did I send where, and what state is it in?" (the board)
- "Why does this document say what it says?" (the application view)

The document is the hero, and the UI is a quiet margin around it. The trace reads like proof-reader's marginalia: hovering a claim highlights its source the way a highlighter marks a page. That highlighter is the one memorable element; everything else stays calm.

**Tokens** (defined on `:root` in `base.css`; dark values under `@media (prefers-color-scheme: dark)`):

| token | light | dark | use |
|---|---|---|---|
| `--desk` | `#F3F5F8` | `#14181E` | page background (cool, not cream) |
| `--sheet` | `#FFFFFF` | `#1C222A` | panels, PDF frame |
| `--ink` | `#1D2633` | `#E4E8EE` | text |
| `--pencil` | `#5A6576` | `#98A3B3` | secondary text |
| `--rule` | `#DCE1E8` | `#2B333E` | borders, dividers |
| `--link` | `#24518A` | `#8DB6E6` | links, focus ring, primary button |
| `--mark` | `#FFE97A` | `rgba(255,226,92,.26)` | highlighter (trace ↔ entry) |
| status hues | drafted `#7A8494`, applied `#2F6FB5`, interviewing `#B27A12`, rejected `#A8475A`, offer `#2E8550` (in dark mode, lighten ~15%) | | status dot and column rule only |
| `--danger` / `--ok` | `#B3261E` / `#2E7D4F` | `#F2867E` / `#79C79A` | not ready / ready, failed checks |

**Type.** Use system stacks only, since there is no network.
- **UI text:** `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- **Document text:** quoted text from the user's documents (trace rows, review impression, entry bodies, letter paragraphs) uses `Charter, "Iowan Old Style", "Bitstream Charter", Georgia, serif`. The split encodes something real: serif is words that are in your document, sans is the tool talking.
- **Paths and the context dump:** `ui-monospace, SFMono-Regular, Menlo, monospace`.
- **Scale:** 13 / 15 (base) / 18 / 24 px. Sans line-height is 1.45, serif 1.6. Measure is ≤ 70ch. `font-variant-numeric: tabular-nums` on versions, counts and scores.

**Layout** (left-aligned throughout):

```
Board                                                    Application (≥ 1000px)
┌ resumely  Applications  Profile        ~/resumely ┐     ┌ resumely  Applications  Profile                ~/resumely ┐
│ Applications            [Board|List] [co…][status]│     │ Atlas Freight                     Applied  [Posting]   │
│ ▍Drafted 1  ▍Applied 1  ▍Interviewing 1 ▍Rej 0 ▍Of│     │ Senior Backend Engineer   Sent resume v2, cover v1     │
│ Orbit       Atlas Fr…   Acme <script>…            │     ├───────────────────────────────┬────────────────────────┤
│ Designer    Senior Ba…  R&D Lead                  │     │ [Resume][Cover letter]  v1     │ ▸ Trace (14)           │
│ No documents r v2 ! c v1  r v1                     │     │ v2 Not ready  Sent             │   summary  "Backend…"  │
└───────────────────────────────────────────────────┘     │ ┌───────────────────────────┐ │   exp-atlas-labs ▒▒▒   │
 Columns are plain stacks of two-line rows separated       │ │        PDF iframe         │ │ ▸ Gaps and keywords    │
 by whitespace and a hairline: no shadowed cards. A        │ │ (sticky, viewport height) │ │ ▸ Review               │
 3px status-coloured rule sits on each column heading.     │ └───────────────────────────┘ │ ▸ Checks               │
 Below 900px the columns become a single list grouped      │                               │ ▸ Template  ▸ Status    │
 by status.                                                │                               │ ▸ Files  ▸ Job posting │
                                                           └───────────────────────────────┴────────────────────────┘
```

- **Application view:**
  - The inspector is a 440px column; the PDF takes the rest at `height: calc(100vh - header)`.
  - Below 1000px they stack: PDF first, at 80vh.
  - Inspector sections are `<details>`. Trace, Review and Checks are open by default.
- **Profile view:** a single reading column (≤ 760px).
  - Top: the profile checks summary.
  - Then entries grouped by type, each a `<details>` with the meta line, the "Used in" links and the serif body.
  - Then the agent context in a `<details>` holding a `<pre>`.

**Motion.**
- The only motion is the highlighter: a 140ms `background-color` fade on `.is-marked`, disabled under `prefers-reduced-motion`.
- No entrance animations, no hover lifts.

**Things this design avoids, on purpose:**
- the cream-and-terracotta palette
- the SaaS card grid with soft shadows
- uppercase eyebrows
- middle-dot meta strings (meta pieces are separate elements spaced by CSS gap)
- arrows appended to links

---

## File Structure

```
src/application/store.ts         # + export STATUSES (moved from cli.ts)
src/cli.ts                       # import STATUSES; + `ui` command (Task 8)
src/commands/open.ts             # + revealFile(path)
src/commands/ui.ts               # parsePort, runUi (start server, print URL, open, wait for signal)
src/ui/html.ts                   # escape, html tag, SafeHtml, raw, safeHref, page shell, shared fragments
src/ui/data.ts                   # read models: board rows, application view, entry usage, profile view, fileHref
src/ui/views/board.ts            # boardPage
src/ui/views/application.ts      # applicationPage
src/ui/views/profile.ts          # profilePage
src/ui/security.ts               # token, host/origin/POST guards, file-path parsing, containment
src/ui/server.ts                 # startUiServer: routing, headers, static + file serving, POST actions
src/ui/assets/base.css           # tokens, light/dark, shell, shared components
src/ui/assets/board.css  application.css  profile.css
src/ui/assets/application.js     # progressive enhancement (ES module)
tests/fixtures/ui-root.ts        # builds a temp data root with applications + versions (no LaTeX)
tests/fixtures/raw-http.ts       # raw-socket HTTP helper
tests/ui-html.test.ts  ui-data.test.ts  ui-board.test.ts  ui-application.test.ts
tests/ui-profile.test.ts  ui-security.test.ts  ui-server.test.ts  ui-actions.test.ts
tests/cli.test.ts                # + ui command tests
README.md                        # + "Local UI" section
```

**Parallelism:**

| Phase | Tasks | Notes |
|---|---|---|
| 1 | Task 1 ‖ Task 2 | disjoint files |
| 2 | Task 3 ‖ Task 4 ‖ Task 5 | after 1+2; each owns its view, stylesheet and test file |
| 3 | Task 6 → Task 7 → Task 8 | sequential |

---

### Task 1: HTML primitives, page shell, base stylesheet

**Files:**
- Create: `src/ui/html.ts`, `src/ui/assets/base.css`
- Modify: `src/application/store.ts` (export `STATUSES`), `src/cli.ts` (import it instead of the local const)
- Test: `tests/ui-html.test.ts`

**Interfaces:**
- Consumes: `ApplicationMeta` from `src/application/store.ts`.
- Produces:
  - `store.ts`: `export const STATUSES = ["drafted","applied","interviewing","rejected","offer"] as const;` and `export type Status = (typeof STATUSES)[number]`, with `ApplicationMeta["status"]` defined as `Status`.
  - **Escaping and safe HTML:**
    - `class SafeHtml { constructor(readonly value: string); toString(): string }`
    - `escapeHtml(s: string): string` escapes `& < > " '` as `&amp; &lt; &gt; &quot; &#39;`.
    - `html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml`. How it treats values:
      - `SafeHtml` is inserted as is
      - arrays are flattened recursively and joined with `""`
      - `null`, `undefined` and `false` become `""`
      - everything else becomes `escapeHtml(String(v))`
    - `raw(s: string): SafeHtml`
    - `safeHref(url: string | undefined): string | null` returns the `URL.href` for `http:` / `https:`, else `null`.
  - **Page shell:**
    - `type PageCtx = { token: string; root: string; platform: NodeJS.Platform }`
    - `type Notice = { tone: "error" | "info"; message: string; hint?: string; retryApplied?: boolean }`
    - `page(o: { title: string; active: "applications" | "profile" | null; ctx: PageCtx; styles: string[]; scripts?: string[]; body: SafeHtml }): string`. It returns a full document containing:
      - `<!doctype html>` and `<html lang="en">`
      - `<meta charset="utf-8">` and a viewport meta
      - `<title>{title} | resumely</title>`
      - `<meta name="resumely-token" content="{token}">`
      - `<link rel="stylesheet" href="/assets/base.css">` followed by one `<link>` per `styles` entry (`/assets/<name>`)
      - `<script type="module" src="/assets/<name>">` per entry in `scripts`
      - a header with the wordmark `resumely` linking to `/`, nav links "Applications" (`/`) and "Profile" (`/profile`) with `aria-current="page"` on the active one, and the data root path in a `<span class="root">`
      - `<main>` holding `body`
  - **Shared fragments:**
    - `STATUS_LABEL: Record<Status, string>` (`Drafted`, `Applied`, `Interviewing`, `Rejected`, `Offer`)
    - `statusPill(s: Status): SafeHtml` → `<span class="status status-<s>">Label</span>`
    - `readyMark(ready: boolean | null): SafeHtml` → `Ready` (`.ready`), `Not ready` (`.not-ready`), or empty for `null`
    - `tokenField(token: string): SafeHtml` → `<input type="hidden" name="_token" value="…">`
    - `noticeBox(n: Notice): SafeHtml` → `role="alert"` for errors, with the message and hint
    - `emptyState(title: string, hint: SafeHtml | string): SafeHtml`
    - `errorPage(ctx: PageCtx, status: 400 | 404 | 500, message: string, hint?: string): string`. Titles: 404 "Not found", 400 "Can't do that", 500 "Something went wrong". Each has a link back to Applications.
  - **`base.css`:**
    - the Design direction tokens (light on `:root`, dark under `@media (prefers-color-scheme: dark)`)
    - shell, nav, typography scale, `.status-*` dots, `.ready` / `.not-ready`, buttons, form controls, notice, empty state, `:focus-visible` ring (2px `--link`, 2px offset)
    - `@media (prefers-reduced-motion: reduce)` disabling transitions
    - `.doc-text` (serif stack), `.path` (mono)

- [ ] **Step 1: Write failing tests** in `tests/ui-html.test.ts`:
  - `escapeHtml(`<a href="x" onclick='y'>&</a>`)` equals `&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;`.
  - `` html`<p>${"<b>"}</p>`.toString() `` is `<p>&lt;b&gt;</p>`. A nested `SafeHtml` is not double-escaped. ``html`${["<i>", html`<b>`]}`.toString()`` is `&lt;i&gt;<b>`. `null` / `undefined` / `false` render `""`, and `0` renders `"0"`.
  - `safeHref("javascript:alert(1)")`, `safeHref("ftp://x")`, `safeHref("not a url")` and `safeHref(undefined)` are `null`; `safeHref("https://x.test/a?b=1")` is `"https://x.test/a?b=1"`.
  - `page({ title: "A<b>", active: "profile", ctx: { token: "T0K", root: "/r<x>", platform: "darwin" }, styles: ["board.css"], body: html`<p>hi</p>` })`:
    - contains `<title>A&lt;b&gt; | resumely</title>`
    - contains `content="T0K"`
    - contains `href="/assets/base.css"` before `href="/assets/board.css"`
    - contains `/r&lt;x&gt;`
    - the Profile link carries `aria-current="page"` and the Applications link doesn't
    - contains no `<script` when `scripts` is omitted
  - `statusPill("interviewing")` contains `status-interviewing` and `Interviewing`. `readyMark(false)` contains `Not ready`, and `readyMark(null).toString()` is `""`.
  - `noticeBox({ tone: "error", message: "<x>", hint: "h" })` contains `role="alert"`, `&lt;x&gt;` and `h`.
  - `errorPage(ctx, 404, "No such app")` contains `Not found` and `No such app`.
  - `base.css` (read from `src/ui/assets/base.css`):
    - contains `prefers-color-scheme: dark`, `prefers-reduced-motion`, `:focus-visible` and `--mark`
    - does not match `/https?:\/\//` (no external fonts)
    - contains no `text-transform: uppercase`
  - `STATUSES` deep-equals `["drafted","applied","interviewing","rejected","offer"]`.
- [ ] **Step 2: Run** `bun test tests/ui-html.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/ui/html.ts` and `base.css`, and move `STATUSES` into `store.ts` with `cli.ts` importing it.
- [ ] **Step 4: Run** `bun test tests/ui-html.test.ts && bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): html escaping primitives, page shell, base stylesheet`

---

### Task 2: Read models and the UI fixture root

**Files:**
- Create: `src/ui/data.ts`, `tests/fixtures/ui-root.ts`
- Test: `tests/ui-data.test.ts`

**Interfaces:**
- Consumes:
  - `listApplications`, `latestVersion`, `type Application` (`store.ts`)
  - `readJsonOr`, `pdfIn` (`pipeline/version.ts`)
  - `buildTrace`, `TraceReport` (P4)
  - `lintProfile`, `LintIssue` (P4)
  - `listTemplates`, `TemplateInfo` (P3)
  - `loadProfile`, `formatProfileContext`, `layout`, `HardFacts`, `Review`, `ParsedJob`
- Produces (`src/ui/data.ts`):
  ```ts
  export type Kind = "resume" | "cover-letter";
  export const KINDS: readonly Kind[]; // ["resume", "cover-letter"]
  export type VersionSummary = {
    version: number; ready: boolean | null; template: string | null; mode: "truthful" | "stretch" | null;
    created: string | null; renderedFrom: number | null; sent: boolean; pdfName: string | null;
  };
  export type BoardRow = {
    slug: string; company: string; role: string; status: ApplicationMeta["status"]; created: string;
    resume: VersionSummary | null; cover: VersionSummary | null; // latest of each kind
    sent: ApplicationMeta["sent"]; appliedAt: string | null;
  };
  export function boardRows(root: string, filter?: { status?: string; company?: string }): BoardRow[];
  export function getApplication(appsDir: string, slug: string): Application | null; // exact slug only, never fuzzy
  export function fileHref(slug: string, kind: Kind, version: number, name: string): string;
  // → `/files/${encodeURIComponent(slug)}/${kind}/v${version}/${encodeURIComponent(name)}`
  export type SnapshotEntry = { id: string; type: string; title: string; org?: string; start?: string; end?: string; body?: string; skills: string[]; tags?: string[] };
  export type DocView = {
    kind: Kind; version: number; dir: string; versions: VersionSummary[];
    pdf: { name: string; href: string; path: string } | null;
    trace: TraceReport | null; entries: SnapshotEntry[];
    review: Review | null; checks: (HardFacts & { warnings: string[] }) | null;
    meta: Record<string, unknown>;
    files: { name: string; path: string; href: string | null }[]; // href only for pdf/tex/json
    problems: string[]; // e.g. `review.json couldn't be read`
  };
  export type AppView = {
    app: Application; kinds: Kind[]; doc: DocView | null;
    job: { parsed: ParsedJob | null; raw: string | null };
    templates: TemplateInfo[]; // only those whose `supports` includes doc.kind
    problems: string[];
  };
  export function applicationView(root: string, slug: string, o?: { kind?: Kind; version?: number }): AppView | null;
  export type EntryUsage = { slug: string; company: string; role: string; kind: Kind; versions: number[] };
  export function entryUsage(appsDir: string): Map<string, EntryUsage[]>;
  export type ProfileView = {
    profile: Profile | null; loadError: string | null; context: string | null;
    usage: Map<string, EntryUsage[]>; lint: LintIssue[]; lintError: string | null;
  };
  export function profileView(root: string): ProfileView;
  ```
- Rules:
  - **`boardRows`**
    - Keeps `listApplications` order (newest first).
    - `status` filters by exact match. `company` is a case-insensitive substring match on the company (same as `formatApplicationList`).
  - **`VersionSummary`**
    - `ready`, `template`, `mode`, `created` and `rendered_from` come from `meta.json` via `readJsonOr`. A missing or unreadable file gives `null`.
    - `sent` is `app.meta.sent?.resume === version` (the `cover_letter` key for cover letters).
    - `pdfName` is the version's `.pdf` basename, or `null`.
  - **`applicationView`**
    - Returns `null` when the slug is unknown, or when the requested kind or version doesn't exist.
    - Default kind: `resume` if it has versions, else `cover-letter`.
    - Default version: the latest.
    - `doc` is `null` (and `kinds` is `[]`) when there are no versions.
    - JSON files are read with try/catch. A file that exists but can't be parsed adds `"<name> couldn't be read"` to `doc.problems`.
    - A `buildTrace` throw adds `trace unavailable: <message>`.
    - A `listTemplates` throw adds `templates couldn't be listed: <message>` to `problems` and gives `templates: []`.
    - Missing optional files (`review.json` after `--no-review`, `checks.json`) are `null` and not problems.
    - `files` is the sorted directory listing.
    - `job.raw` is `job/raw.md`.
  - **`entryUsage`** maps entry ids to their uses. For every application, kind and version, it reads the ids in `entries.snapshot.json` (the frozen cited set). It groups the uses per application and kind, with versions ascending. Unreadable snapshots are skipped.
  - **`profileView`**
    - `loadProfile` errors become `loadError` (message plus hint), with `profile` and `context` set to `null`.
    - `lintProfile` errors become `lintError`.
    - Otherwise `context = formatProfileContext(profile)`.
- Fixture `tests/fixtures/ui-root.ts`:
  - **Signature:** `makeUiRoot(): { root: string; atlas: string; hostile: string; empty: string; coverOnly: string }` (the slugs). It must not need LaTeX.
  - **Setup:**
    - `initDataRoot` + copy `tests/fixtures/profile-jordan`
    - add `profile/extras/award-oss.md` (`id: award-oss`, `type: award`, `title: Open Source Award`), which is cited nowhere
  - **Applications:** create via `createApplication` with fixed dates. Write version dirs via `nextVersionDir`. Each version gets:
    - `resume.json` / `cover-letter.json` from the fixtures
    - `trace.json` from `resumeTrace(resolveResume(content, entries))` / `coverTrace`
    - `entries.snapshot.json` from `snapshotOf(resumeEntryIds(...) | coverEntryIds(...), buildAgentPayload(profile).entries)`
    - `company.snapshot.json` (cover only)
    - `checks.json` (a hand-built `HardFacts` + `warnings`)
    - `meta.json` via `versionMeta(...)`
    - `review.json` from `review-pass.json`
    - a PDF `%PDF-1.4\n%%EOF\n` named by `sendReadyName`
  - The four applications:
    - **`atlas`** — "Atlas Freight" / "Senior Backend Engineer".
      - Resume v1: ready, template `classic`.
      - Resume v2: `ready: false`, `checks.ats = { status: "failed", problems: ["email not extractable"] }`, `rendered_from: 1`, no `review.json`. Its keywords are `{ present: ["Go"], missed_in_profile: ["Kafka"], absent: ["Rust"] }`.
      - Cover v1: ready.
      - Then `setStatus(applied, { force: true })` → `sent = { resume: 2, cover_letter: 1 }`.
    - **`hostile`** — company `Acme <script>alert(1)</script> & "Co"`, role `R&D <b>Lead</b>`, status `interviewing`, note `<img src=x onerror=alert(1)>`.
      - Resume v1: the first bullet text is `Cut p99 <script>x</script> & "quotes"` in both `resume.json` and `trace.json`.
      - `review.json` is truncated (`{"impression":`).
    - **`empty`** — "Orbit" / "Designer". Only `job/` exists (no versions).
    - **`coverOnly`** — "Nimbus" / "Data Engineer". Only cover v1.

  If P4's `buildTrace` needs a file this list lacks, add it here. The fixture must mirror what `apply` writes (`src/pipeline/apply.ts`, `save()`).

- [ ] **Step 1: Write failing tests** in `tests/ui-data.test.ts` (one `makeUiRoot()` in `beforeAll`):
  - `boardRows(root)`:
    - The rows are in newest-first order.
    - The atlas row has `resume.version === 2`, `resume.ready === false`, `cover.version === 1` and `cover.ready === true`, with sent `{ resume: 2, cover_letter: 1 }`.
    - The empty row has `resume === null && cover === null`.
  - Filters: `boardRows(root, { status: "interviewing" })` gives only the hostile row. `{ company: "ATLAS" }` gives only atlas.
  - `getApplication(apps, "atlas")` is `null` (fuzzy text), while `getApplication(apps, <atlas slug>)` returns the application.
  - `applicationView(root, atlas)`:
    - `doc.kind === "resume"`, `doc.version === 2`.
    - Versions `[1,2]`: v2 has `sent === true` and `renderedFrom === 1`; v1 has `template === "classic"`.
    - `doc.pdf.href === fileHref(atlas, "resume", 2, "Jordan_Example_Resume_AtlasFreight.pdf")`.
    - `doc.review === null` and `doc.problems` deep-equals `[]` (a missing review is not a problem).
    - `doc.trace.rows.length > 0`.
    - `doc.entries` ids include `exp-atlas-labs`, with a non-empty `body`.
  - `applicationView(root, atlas, { kind: "cover-letter" }).doc.version === 1`. `{ version: 9 }` is `null`, and so is an unknown slug.
  - `applicationView(root, coverOnly).doc.kind === "cover-letter"`.
  - **Review Focus 2:** `applicationView(root, empty)` has `doc === null` and `kinds` deep-equals `[]`, and does not throw.
  - **Review Focus 1:** `applicationView(root, hostile).doc.problems` contains `review.json couldn't be read`, and `doc.pdf` is still set. Also, in a fresh `makeUiRoot()` (don't mutate the shared one), after overwriting atlas resume v1 `meta.json` with `{not json`, `versions[0].ready === null` and `doc.problems` mentions `meta.json` when viewing v1.
  - `templates` all `supports` the doc kind and include `classic`.
  - `entryUsage(apps).get("exp-atlas-labs")` contains `{ slug: atlas, kind: "resume", versions: [1,2] }` and `{ slug: atlas, kind: "cover-letter", versions: [1] }`. `.get("award-oss")` is `undefined`.
  - `profileView(root)`: `context === formatProfileContext(loadProfile(layout(root).profile))` and `lint` deep-equals `lintProfile(root)`. After writing invalid YAML into a copy's `about.md`, `loadError` is non-null and `profile === null`.
- [ ] **Step 2: Run** `bun test tests/ui-data.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/ui/data.ts` and the fixture.
- [ ] **Step 4: Run** `bun test tests/ui-data.test.ts && bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): read models for board, application, profile`

---

### Task 3: Applications board view

**Files:**
- Create: `src/ui/views/board.ts`, `src/ui/assets/board.css`
- Test: `tests/ui-board.test.ts`

**Interfaces:**
- Consumes: `page`, `html`, `statusPill`, `readyMark`, `emptyState`, `PageCtx` (Task 1); `BoardRow`, `boardRows` (Task 2); `STATUSES`.
- Produces: `boardPage(rows: BoardRow[], o: { view: "board" | "list"; filter: { status?: string; company?: string }; total: number }, ctx: PageCtx): string`. Here `total` is the unfiltered count. It uses `page({ title: "Applications", active: "applications", styles: ["board.css"] })`.
- Content:
  - **Toolbar:** a `GET` form to `/`. Clearing filters links to `/` (or `/?view=list` in list view). It contains:
    - `<input name="company" type="search">` with its value preserved (escaped)
    - a `<select name="status">` with "Any status" plus the five statuses
    - a hidden `view`
    - a "Filter" button
    - a Board/List switch as two links that preserve the filters
  - **Board view:**
    - Five `<section class="column status-<s>">` in `STATUSES` order, each headed `<h2>` "Label" with a `<span class="count">n</span>`.
    - With a status filter, only that column is shown.
    - Each row is an `<a class="app-row" href="/app/<slug>">` containing:
      - the company (strong) and the role
      - for each kind present: `Resume v2` / `Cover letter v1`, plus a `.not-ready` mark when `ready === false`
      - "No documents" when neither kind exists
      - a `Sent` tag when `sent` is set
  - **List view:** a `<table>` with headers `Date | Company | Role | Status | Resume | Cover letter | Sent`, where:
    - the date is `created.slice(0, 10)`
    - Sent shows `Resume v2, cover letter v1`, or `-` when nothing was sent
    - each company cell links to `/app/<slug>`
  - **Empty states:**
    - When `total === 0`: `emptyState("No applications yet", "Start one with resumely apply --clip")`.
    - When the filter matches nothing: "No applications match these filters" with a "Clear filters" link.
    - An empty column shows nothing; its count is 0.
  - **`board.css`:**
    - five-column CSS grid, with the 3px status rule on each column heading
    - rows separated by a hairline, without cards or shadows
    - under 900px the grid becomes one column

- [ ] **Step 1: Write failing tests** in `tests/ui-board.test.ts` (fixture root from Task 2; `ctx = { token: "t", root, platform: "darwin" }`):
  - Board view of all rows:
    - Five `class="column status-…"` occurrences in status order (check the index order of `status-drafted` < `status-applied` < … < `status-offer`).
    - The `Applied` heading count is 1.
    - `href="/app/<atlas>"` is present.
    - The atlas row contains `Resume v2` and `Not ready`.
    - The empty row contains `No documents`.
  - The hostile row escapes everything: the output contains no `<script>alert`, and contains `Acme &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;` and `R&amp;D &lt;b&gt;Lead&lt;/b&gt;`.
  - The list view contains `<table` and the header cells `Date`, `Company`, `Role`, `Status`, `Resume`, `Cover letter`, `Sent`. The atlas Sent cell reads `Resume v2, cover letter v1`.
  - With filter `{ status: "offer" }` and the filtered rows `[]` with `total: 4`: `No applications match these filters` and `Clear filters`. With `total: 0`: `No applications yet` and `resumely apply --clip`.
  - A company filter value `"><x` round-trips escaped (`value="&quot;&gt;&lt;x"`).
  - A status filter shows only that column: one `class="column`.
- [ ] **Step 2: Run** `bun test tests/ui-board.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test tests/ui-board.test.ts && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): applications board (kanban + list)`

---

### Task 4: Application view

**Files:**
- Create: `src/ui/views/application.ts`, `src/ui/assets/application.css`, `src/ui/assets/application.js`
- Test: `tests/ui-application.test.ts`

**Interfaces:**
- Consumes: Task 1 primitives (`Notice`, `noticeBox`, `tokenField`, `safeHref`, …); `AppView`, `DocView`, `fileHref` (Task 2); `STATUSES`.
- Produces: `applicationPage(view: AppView, ctx: PageCtx, notice?: Notice): string`. It uses `page({ title: company, active: "applications", styles: ["application.css"], scripts: ["application.js"] })`.
- **Content (top to bottom):**
  - **Header:** company `<h1>`, role, `statusPill`, created date, and a "Posting" link when `safeHref(app.meta.source.url)` is non-null (`target="_blank" rel="noopener noreferrer"`). When `meta.sent` is set: `Sent resume v2 and cover letter v1 on <applied_at date>`.
  - **Notices:**
    - `noticeBox(notice)` when given.
    - Each of `view.problems` and `doc.problems` as an info notice.
    - When `notice.retryApplied`: a POST form to `/app/<slug>/status` with `tokenField`, `status=applied`, `force=1`, the current `kind`/`v`, and the button "Mark as applied anyway".
  - **Empty doc** (`doc === null`): `emptyState("No documents yet", "Generate them with resumely apply --into <slug> <posting>")`, followed by the Status and notes section only.
  - **Document pane:**
    - Kind tabs: links `?kind=resume` / `?kind=cover-letter`, only for `view.kinds`, labelled "Resume" / "Cover letter", with `aria-current="page"` on the current one.
    - Version strip: links `?kind=<k>&v=<n>` labelled `v<n>`, each with `readyMark`, a `Sent` tag when `sent`, and `aria-current="page"` on the current one.
    - `<iframe class="pdf" src="<pdf.href>" title="<Kind> v<n> PDF">`, plus a plain "Open the PDF" link to the same href.
    - When `pdf === null`: "This version has no PDF".
  - **Inspector `<details>` sections, in order:**
    1. **"Trace" (open).**
       - One `<li class="trace-row" data-entries="<space-separated ids>">` per `TraceRow`, containing:
         - the section name
         - the text in `.doc-text`
         - an `Inferred` tag when `basis === "inferred"`
         - each flag as `.flag`
         - entry chips `<a class="entry-chip" href="#entry-<id>">id</a>`
       - `trace.warnings` follow as a list.
       - Below the rows comes "Sources": one `<details class="entry" id="entry-<id>">` per `doc.entries` item, with summary `title, org, dates` and a body `.doc-text` with `white-space: pre-wrap`.
       - When `trace === null`: "No trace for this version".
    2. **"Gaps and keywords".**
       - `trace.gaps` as a list headed "Requirements your profile doesn't support".
       - Then `checks.keywords` as three lists: "Covered" (`present`), "In your profile but not used" (`missed_in_profile`), "Not in your profile" (`absent`). An empty list shows "None".
    3. **"Review" (open).**
       - Verdict ("Pass" / "Revise"), impression `.doc-text`, scores as `<meter min="1" max="5" value="n">` with the label and `n/5` text, red flags, requests.
       - `meta.reviewed_final === false` adds "The last revision was not re-reviewed".
       - `meta.rendered_from` adds "Carried over from v<n> (re-rendered)".
       - When `review === null`: "No review for this version".
    4. **"Checks" (open).**
       - A `readyMark(meta.ready)` summary.
       - ATS: `Passed` / `Failed` / `Skipped`, plus the problems and hint.
       - `Pages: <pages> of <target_pages>`.
       - `Fill: <round(fill*100)>%`, or "unknown" when `null`.
       - `Overflow` / `Underflow` when true.
       - `Words: <word_count>`.
       - `fabrication_warnings` under "Unsourced claims".
       - `warnings`.
       - When `checks === null`: "No checks recorded".
    5. **"Template".**
       - A POST form to `/app/<slug>/render` with `tokenField`, hidden `kind`, `v`, a `<select name="template">` of `view.templates` (`name — description`, with `meta.template` selected), and the button "Re-render".
       - The form carries `data-busy-label="Rendering…"`.
       - Help text: "Creates a new version from this one's content. No agent call."
    6. **"Status and notes".**
       - A POST form to `/status` with a `<select name="status">` of all five statuses (current one selected), hidden `kind`/`v`, and the button "Save status".
       - Help text under the select: "Marking as applied records the latest versions as sent."
       - Notes as a `<ul>` (escaped), or "No notes yet".
       - A POST form to `/note` with `<textarea name="text" maxlength="2000" required>` and the button "Add note".
    7. **"Files".**
       - The version dir path in `.path`, with a "Copy path" `<button type="button" data-copy="<dir>">`.
       - A POST form to `/app/<slug>/reveal` (hidden `kind`, `v`), with the button "Show in Finder" when `ctx.platform === "darwin"`, else "Open folder".
       - The file list: names linked to `href` when non-null, each with a `data-copy` button carrying the absolute path.
    8. **"Job posting".** Parsed role, location, requirements, nice-to-haves and keywords, then `job.raw` in a `<pre class="doc-text">`.
- **`application.js`** (ES module, no globals, no external calls):
  - **Trace highlight.** On `mouseenter` / `focusin` of `.trace-row`, add `.is-marked` to the row and to each `#entry-<id>` in `data-entries`; remove it on leave. On a chip click, open the target `<details>` and `scrollIntoView({ block: "nearest" })`, with `behavior: "smooth"` unless reduced motion is preferred.
  - **Copy.** `[data-copy]` click → `navigator.clipboard.writeText`. The label changes to "Copied" for 1.5 s. On failure it selects the path text instead.
  - **Busy state.** On submit of a form with `data-busy-label`: disable its button and set its text to that label.
- **`application.css`:**
  - the two-column grid (inspector 440px) and the stacked layout below 1000px
  - a sticky PDF frame
  - `.is-marked` and `:target` using `--mark` with a 140ms transition
  - `.trace-row` spacing, chips, `meter` styling

- [ ] **Step 1: Write failing tests** in `tests/ui-application.test.ts` (fixture root; `applicationView` from Task 2; `ctx.platform = "darwin"`):
  - **atlas default (resume v2):**
    - `<iframe` with `src="/files/<atlas>/resume/v2/Jordan_Example_Resume_AtlasFreight.pdf"`
    - version links `?kind=resume&amp;v=1` and `?kind=resume&amp;v=2`
    - `Sent` near v2 (the v2 strip item contains `Sent`)
    - `Not ready`
    - tabs `Resume` and `Cover letter`
  - **Trace:**
    - each `trace.rows[i].text` appears escaped
    - `data-entries="exp-atlas-labs"` and `id="entry-exp-atlas-labs"` are present
    - a fixture modified to have `basis: "inferred"` shows `Inferred`
  - **Gaps:**
    - `Covered`, `In your profile but not used`, `Not in your profile`
    - `Kafka` under the middle list (index between the middle and last headings)
  - **Review and checks:**
    - v2 shows `No review for this version` and `Carried over from v1`.
    - v1 (`{ version: 1 }`) shows the fixture's `impression` text, `Pass` and `<meter`.
    - Checks for v2 contain `Failed` and `email not extractable`.
  - **Forms:**
    - The template form posts to `/app/<atlas>/render` and contains `name="_token" value="t"`, `<option value="classic" selected`, `name="kind" value="resume"` and `name="v" value="2"`.
    - The status `<select>` has five options, with `applied` selected. The note form has `maxlength="2000"`.
  - **Files:**
    - The dir path appears with `data-copy`.
    - `Show in Finder` appears for `darwin`, and `Open folder` with `platform: "linux"`.
  - **Notices:**
    - `notice = { tone: "error", message: "resume v2 is not ready: ATS check failed", hint: "Fix and re-run, or pass --force", retryApplied: true }` renders `role="alert"`, a form with `name="force" value="1"` and `Mark as applied anyway`.
  - **Review Focus 1:** the hostile page contains `review.json couldn&#39;t be read` and still has its `<iframe`.
  - **Escaping:** hostile contains no `<script>`, `<img src=x` or `<b>Lead` substrings, but does contain `&lt;img src=x onerror=alert(1)&gt;` and `Cut p99 &lt;script&gt;x&lt;/script&gt; &amp; &quot;quotes&quot;`.
  - **Posting link:** a `source.url` of `javascript:alert(1)` (set on a copied app meta in-test) renders no `href="javascript:`.
  - **Review Focus 2:** empty contains `No documents yet` and `resumely apply --into <empty slug>`, plus the status form, and no `<iframe`.
  - **No inline script or style:** none of the pages match `/<script(?![^>]*\bsrc=)/`, ` style="` or `/\son[a-z]+=/`.
- [ ] **Step 2: Run** `bun test tests/ui-application.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the view, CSS and JS.
- [ ] **Step 4: Run** `bun test tests/ui-application.test.ts && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): application view with PDF, versions, trace, review, checks, actions`

---

### Task 5: Profile view

**Files:**
- Create: `src/ui/views/profile.ts`, `src/ui/assets/profile.css`
- Test: `tests/ui-profile.test.ts`

**Interfaces:**
- Consumes: Task 1 primitives; `ProfileView`, `EntryUsage` (Task 2); `ENTRY_TYPES` (`profile/schema.ts`).
- Produces: `profilePage(view: ProfileView, ctx: PageCtx): string`. It uses `page({ title: "Profile", active: "profile", styles: ["profile.css"] })`.
- **Content:**
  - **Header.** The name `<h1>` and headline. The private-content summary: "N private lines withheld from the agent" across entries, and "N private fields in about.md" when `aboutPrivateKeys > 0`.
  - **In-page nav:** links `#checks`, `#entries`, `#context`.
  - **`<section id="checks">` "Profile checks":**
    - `lintError` as an error notice.
    - Otherwise a summary such as "1 error, 2 warnings", or "No problems found".
    - Then issues whose `entry_id` is `null` or not a loaded entry, each with the severity tag (`Error` / `Warning`), `code`, `message` and file path (`.path`).
  - **`<section id="entries">`:**
    - `loadError` as an error notice with the hint `Fix the file, then reload. Check with: resumely profile show`.
    - Otherwise entries grouped by type in `ENTRY_TYPES` order. Headings: Experience, Projects, Education, Awards, Publications, Volunteering, Certifications, Other. Each entry is a `<details class="entry" id="entry-<id>">` with:
      - summary: title, org and dates
      - the id and file path
      - skills and tags
      - this entry's lint issues
      - `[private: N lines withheld]` when `privateLines > 0`
      - **"Used in":** one link per `EntryUsage`, `<a href="/app/<slug>?kind=<kind>&v=<last version>">Company, Role</a>` followed by `resume v1, v2` / `cover letter v1`. When an entry has no usage: "Not used yet".
      - the body in `.doc-text` with `white-space: pre-wrap` (escaped, not rendered as Markdown)
  - **`<section id="context">` "What the agent sees":** one sentence ("This is the exact profile payload sent to the agent. Private sections are already removed.") and `<pre class="context">` with `view.context`.

- [ ] **Step 1: Write failing tests** in `tests/ui-profile.test.ts` (fixture root; `profileView(root)` from Task 2, plus hand-built `ProfileView`s):
  - Real view:
    - `<h1>` contains `Jordan Example`.
    - The `Experience` heading appears before `Projects`.
    - `id="entry-exp-atlas-labs"` is present.
    - The atlas-labs entry contains `href="/app/<atlas>?kind=resume&amp;v=2"`, `resume v1, v2` and `cover letter v1`.
    - `id="entry-award-oss"` is followed by `Not used yet` before the next `class="entry"`.
  - The context `<pre>` contains `&quot;name&quot;: &quot;Jordan Example&quot;`.
  - With `lint = [{ entry_id: "exp-northwind", severity: "warning", code: "outcome-less-bullet", message: "bullet has no outcome", file: "x.md" }, { entry_id: null, severity: "error", code: "parse", message: "bad <yaml>", file: "y.md" }]`:
    - The summary reads `1 error, 1 warning`.
    - `bad &lt;yaml&gt;` is in `#checks`.
    - `bullet has no outcome` is inside the northwind entry.
  - `lint: []` gives `No problems found`.
  - `{ profile: null, loadError: "about.md: invalid YAML", context: null, lint: [], … }` renders the error and the hint, and has no `class="entry"`.
  - An entry with `privateLines: 3` shows `[private: 3 lines withheld]`.
  - The body `<script>x</script>` is escaped.
- [ ] **Step 2: Run** `bun test tests/ui-profile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test tests/ui-profile.test.ts && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): profile view with usage, lint and agent context`

---

### Task 6: Server — guards, routing, static and file serving

**Files:**
- Create: `src/ui/security.ts`, `src/ui/server.ts`, `tests/fixtures/raw-http.ts`
- Test: `tests/ui-security.test.ts`, `tests/ui-server.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (`boardRows`, `applicationView`, `profileView`, `boardPage`, `applicationPage`, `profilePage`, `errorPage`), `UserError`.
- Produces:
  - **`src/ui/security.ts`:**
    - `newToken(): string`: 32 bytes from `crypto.getRandomValues`, base64url.
    - `hostAllowed(host: string | null, port: number): boolean`
    - `originAllowed(origin: string | null, port: number): boolean`: `null` (absent) → true; `"null"` → false; otherwise it must equal `http://127.0.0.1:<port>` or `http://localhost:<port>`.
    - `postAllowed(req: Request, port: number): boolean`: `originAllowed(...)` and `Sec-Fetch-Site !== "cross-site"`.
    - `tokenMatches(given: FormDataEntryValue | null, token: string): boolean`: string only, equal length, `crypto.timingSafeEqual`.
    - `parseFilePath(pathname: string): { slug: string; kind: Kind; version: number; name: string } | null`. The pathname must start with `/files/` and have exactly 4 segments after it. Rules:
      - Each segment is `decodeURIComponent`d, and a malformed one gives `null`.
      - A decoded segment must be non-empty, not `.` / `..`, without `/`, `\` or `\0`, and must not start with `.`.
      - slug matches `/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/`
      - kind is in `KINDS`
      - the version segment matches `/^v[1-9]\d*$/`
      - name matches `/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.(pdf|tex|json)$/`
    - `resolveInside(base: string, segments: string[]): string | null`. Joins the segments onto `base`, then `realpathSync`s both. It returns the real path only if it equals `base` or starts with `realBase + sep`, and is an existing regular file. Otherwise, or on any fs error, it returns `null`.
  - **`src/ui/server.ts`:**
    ```ts
    export const DEFAULT_UI_PORT = 4317;
    export type UiServerOptions = {
      root: string;
      port?: number;            // exact; busy → UserError("Port N is in use", "Pick another with --port, or omit it")
      preferredPort?: number;   // used when `port` is undefined (default DEFAULT_UI_PORT); busy → falls back to 0
      token?: string;           // default newToken()
      reveal?: (file: string) => Promise<void>;                                   // default revealFile (Task 7)
      render?: (o: Parameters<typeof renderApplication>[0]) => Promise<{ version: number }>; // default renderApplication (Task 7)
    };
    export type UiServer = { url: string; port: number; token: string; stop(): Promise<void> };
    export function startUiServer(o: UiServerOptions): UiServer;
    ```
    `url` is `http://127.0.0.1:<port>/`. `startUiServer` calls `requireDataRoot(root)` first.
- **Request pipeline** (in order):
  1. `hostAllowed(req.headers.get("host"), port)`, else 403 `text/plain` "Forbidden: unexpected Host header".
  2. `originAllowed(Origin)`, else 403 "Forbidden: cross-origin request".
  3. For POST: `postAllowed` and `tokenMatches(form.get("_token"))`, else 403 "Forbidden: missing or invalid token". An unparsable form also gets this 403.
  4. Route.
- **GET routes:**
  - `/` → `boardPage`. Query `view` (`list` | default `board`), `status` (ignored unless it is in `STATUSES`), `company`. The rows are filtered and `total` is the unfiltered count.
  - `/app/<slug>` → `applicationPage(applicationView(root, decodedSlug, { kind, version }))`.
    - `kind` must be in `KINDS` and `v` must match `/^[1-9]\d*$/`.
    - An invalid param or a `null` view gives `errorPage(404, "No application or version matches this link.")`.
  - `/profile` → `profilePage(profileView(root))`.
  - `/assets/<name>` → only `base.css`, `board.css`, `application.css`, `profile.css` and `application.js`, read from `join(import.meta.dir, "assets")`. Served as `text/css; charset=utf-8` / `text/javascript; charset=utf-8`, else 404.
  - `/files/...` → `parseFilePath` → `getApplication` (exact) → `resolveInside(layout(root).applications, [slug, kind, "v"+n, name])`. Any `null` → 404 `text/plain` "Not found".
    - Content types: `application/pdf`, `text/plain; charset=utf-8` (`.tex`), `application/json; charset=utf-8`.
    - `Content-Disposition: inline; filename="<name>"` (the name is already `[A-Za-z0-9._-]`).
  - Anything else → `errorPage(404, …)`.
- **Methods.** POST routes are added in Task 7. In this task any POST that passes the guards returns 404. Methods other than GET/HEAD/POST → 405 with `Allow: GET, POST`.
- **Errors.**
  - `UserError` in a handler → `errorPage(400, message, hint)`.
  - Anything else → `errorPage(500, "Something went wrong: " + message)`, with the stack written to stderr. No stack goes into the HTML.
- **Headers** per Global Constraints: CSP on HTML only. Never `Access-Control-Allow-Origin`.

- [ ] **Step 1: Write the raw-socket helper and failing tests.**
  - The helper: `rawRequest(port: number, head: string): Promise<{ status: number; headers: string; body: string }>` (`node:net`, sends `head` + `Connection: close\r\n\r\n`, parses the status line).
  - `tests/ui-security.test.ts` (pure):
    - `hostAllowed("127.0.0.1:5000", 5000)`, `("LOCALHOST:5000", 5000)` are true. `("127.0.0.1:5001", 5000)`, `("evil.test", 5000)`, `(null, 5000)` and `("127.0.0.1", 5000)` are false.
    - `originAllowed(null, p)` true, `("http://localhost:p")` true, `("null")` false, `("http://evil.test")` false, `("https://127.0.0.1:p")` false.
    - `tokenMatches("abc", "abc")` true; `"abd"`, `"ab"`, `null` and a `File` are false.
    - `parseFilePath` returns `null` for each of: `/files/a/resume/v1/../x.pdf`, `/files/a/resume/v1/..%2fx.pdf`, `/files/%2e%2e/resume/v1/x.pdf`, `/files/a/job/v1/raw.md`, `/files/a/resume/v0/x.pdf`, `/files/a/resume/v1/x.toml`, `/files/a/resume/v1/.x.pdf`, `/files/a/resume/v1/x.pdf%00.json`, `/files/a/resume/v1/%E0%A4%A.pdf`, `/files/a/resume/v1`. It parses `/files/2026-01-01-a-b/cover-letter/v12/J_E.pdf` to `{ slug: "2026-01-01-a-b", kind: "cover-letter", version: 12, name: "J_E.pdf" }`.
    - `resolveInside`: inside → path; a symlink inside the base pointing outside → `null`; missing → `null`; a directory → `null`.
  - `tests/ui-server.test.ts` (`makeUiRoot()`, `startUiServer({ root, port: 0, token: "tok" })`, `stop()` in `afterAll`):
    - `GET /`: 200, `content-type` starts with `text/html`, the body contains `Atlas Freight`, and the `content-security-policy` header contains `default-src 'self'` and `frame-ancestors 'self'`. `x-content-type-options` is `nosniff` and `cache-control` is `no-store`.
    - `server.url` starts with `http://127.0.0.1:`.
    - `GET /?view=list&status=applied` contains `<table` and atlas but not `Orbit`. `GET /profile` gives 200 and `Jordan Example`.
    - `GET /app/<atlas>` gives 200 with `<iframe`. `/app/<atlas>?kind=cover-letter&v=1` gives 200. `/app/<atlas>?v=9`, `?kind=nope`, `?v=1x` and `/app/atlas` (fuzzy) give 404. `/app/<empty>` gives 200 with `No documents yet`.
    - `GET /files/<atlas>/resume/v2/Jordan_Example_Resume_AtlasFreight.pdf` gives 200, `application/pdf`, and a body starting with `%PDF`. `.../resume/v2/meta.json` gives 200 JSON.
    - **Traversal:** each of these raw requests (with `Host: 127.0.0.1:<port>`) gets 404 and a body without `harness`:
      - `GET /files/../config.toml`
      - `GET /files/%2e%2e/%2e%2e/config.toml`
      - `GET /files/<atlas>/resume/v1/..%2f..%2f..%2f..%2fconfig.toml`
      - `GET /files/<atlas>/job/v1/raw.md`
      - `GET /assets/..%2f..%2f..%2fpackage.json`
    - A symlink `applications/<atlas>/resume/v1/leak.json` pointing to `<root>/config.toml` gives 404.
    - **Host:** a raw `Host: evil.test` gives 403. `Host: localhost:<port>` gives 200. `Host: 127.0.0.1:<port+1>` gives 403.
    - **Origin:** `GET /` with `Origin: http://evil.test` gives 403.
    - **Token:**
      - `POST /app/<atlas>/note` (form `text=x`) without `_token` gives 403.
      - With `_token=wrong` → 403.
      - With `_token=tok` and `Origin: http://evil.test` → 403.
      - With `_token=tok` and `Sec-Fetch-Site: cross-site` → 403.
      - After all of these, `application.toml` is byte-identical.
      - With `_token=tok` and no Origin → not 403 (404 until Task 7).
    - `PUT /` gives 405 with an `Allow` header. `GET /nope` gives a 404 HTML page.
    - `GET /assets/base.css` gives `text/css`. `/assets/application.js` gives `text/javascript`. `/assets/nope.css` gives 404.
    - **Review Focus 3** (its own `makeUiRoot()` and server, because it mutates data):
      - `setStatus(atlas → "offer")` through the store between two `GET /?view=list` requests: the second shows `Offer` for atlas.
      - Adding `resume/v3` (copy v2) makes `/app/<atlas>` show `v=3`.
      - `rmSync` of the hostile app dir then `GET /app/<hostile>` gives 404, not 500.
    - **Review Focus 5:** with a `Bun.serve` occupying port P, `startUiServer({ root, preferredPort: P })` returns a server whose `port !== P`. `startUiServer({ root, port: P })` throws `UserError` `Port P is in use`.
    - `startUiServer({ root: <dir without config.toml> })` throws `UserError` `No resumely data root`.
- [ ] **Step 2: Run** `bun test tests/ui-security.test.ts tests/ui-server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `security.ts`, then `server.ts`.
- [ ] **Step 4: Run** the same tests, then `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): localhost server with host/origin/token guards and safe file serving`

---

### Task 7: Actions — status, notes, re-render, reveal

**Files:**
- Modify: `src/ui/server.ts`, `src/commands/open.ts`
- Test: `tests/ui-actions.test.ts`

**Interfaces:**
- Consumes: `setStatus` (`application/tracking.ts`), `addNote` (`store.ts`), `renderApplication` (`pipeline/rerender.ts`), `pdfIn` (`pipeline/version.ts`), `getApplication`, `applicationView`, `applicationPage(view, ctx, notice)`.
- Produces:
  - `revealFile(path: string): Promise<void>` in `src/commands/open.ts`.
    - darwin: `["open", "-R", path]`
    - otherwise: `["xdg-open", dirname(path)]`
    - On spawn failure: `console.error("warning: couldn't open the file manager; the file is at <path>")`.
  - **POST routes** (all already token-guarded by Task 6). Every one:
    - looks up the app with `getApplication` (exact), and gives 404 if it is missing;
    - reads the optional form fields `kind` (∈ `KINDS`) and `v` (`/^[1-9]\d*$/`) to build the redirect `Location: /app/<slug>?kind=<kind>&v=<v>`, dropping missing or invalid ones;
    - answers success with **303**.

    An error response re-renders the application page for `kind`/`v` with a `Notice`, at the status given below.

    | Route | Fields | Behaviour |
    |---|---|---|
    | `/app/<slug>/status` | `status`, `force?` | Not in `STATUSES` → 400 notice "Unknown status". Else `setStatus(app, status, { force: form.get("force") === "1" })`. A `UserError` → **409**, notice `{ tone: "error", message, hint, retryApplied: status === "applied" }`. |
    | `/app/<slug>/note` | `text` | Collapse `\s+` to one space and trim. Empty → 400 "Write a note first". Over 2000 chars → 400 "Notes are limited to 2000 characters". Else `addNote(app, text)`. |
    | `/app/<slug>/render` | `template`, `kind`, `v` | `kind` and `v` are required here (missing or invalid → 400). Call `o.render({ root, query: slug, template, kind, version: v, open: false })`. Success → 303 to `?kind=<kind>&v=<returned version>`. A `UserError` → **400** with notice `{ tone: "error", message, hint }`. Renders are serialised through one in-process promise chain, so two clicks never compile concurrently. |
    | `/app/<slug>/reveal` | `kind`, `v` | Resolve `<app.dir>/<kind>/v<v>`; a missing dir or PDF → 404. Else `await o.reveal(pdfIn(dir))` → 303. |

- [ ] **Step 1: Write failing tests** in `tests/ui-actions.test.ts`. Use a fresh `makeUiRoot()` per `describe` and two servers on `port: 0` with `token: "tok"`:
  - `spy`: spies for both `reveal` and `render`, recording their args
  - `real`: a `reveal` spy and the default `renderApplication`

  `post(server, path, fields)` sends `application/x-www-form-urlencoded` with `_token=tok` and `redirect: "manual"`.
  - **status**
    - `status=rejected` on hostile → 303 with `location` `/app/<hostile>`. `application.toml` then has `status = "rejected"`.
    - `status=bogus` → 400 containing `Unknown status`.
    - In a fresh `makeUiRoot()`, set atlas back to `drafted` through the store, then post `status=applied`, `kind=resume`, `v=2`. Expected: 409 containing `resume v2 is not ready`, `Mark as applied anyway` and `name="force" value="1"`; the status stays `drafted`.
    - Posting again with `force=1` → 303 to `/app/<atlas>?kind=resume&v=2`. Re-reading gives `meta.sent` deep-equal `{ resume: 2, cover_letter: 1 }` and `status === "applied"`.
  - **note**
    - `text=" called\n back "` → 303, and the last note ends with `: called back`.
    - `text="  "` → 400 `Write a note first`.
    - 2001 chars → 400. The notes count is unchanged after both.
  - **render (spy)**
    - Posting `template=classic`, `kind=resume`, `v=1` → 303 with location `/app/<atlas>?kind=resume&v=7` (the spy returns `{ version: 7 }`). The spy got `{ root, query: <atlas>, template: "classic", kind: "resume", version: 1, open: false }`.
    - A missing `v` → 400, and the spy is not called.
  - **render (real `renderApplication`, no LaTeX needed)** — Review Focus 4. On `real`; both errors are raised before compiling:
    - `template=nope` → 400 containing `Unknown template &quot;nope&quot;` (the template lookup's message), and `resume/` still has exactly `v1, v2`.
    - Write a user template `<root>/templates/resume-only/` (a `template.toml` with `id = "resume-only"`, `name`, `engine = "pdflatex"`, `supports = ["resume"]`, plus whatever P3's `listTemplates` requires) and an empty `resume.tex.njk`. Posting it with `kind=cover-letter`, `v=1` → 400 containing `does not support cover letters`, and `cover-letter/` still has only `v1`.
  - **render (latexmk-gated)** — `test.skipIf(!Bun.which("latexmk"))`:
    - On `real`, post `template=classic`, `kind=resume`, `v=1` → 303 to `?kind=resume&v=3`.
    - `resume/v3/meta.json` has `rendered_from === 1` and `template === "classic"`.
    - `GET` of that location shows `v3`.
  - **reveal**
    - `kind=resume`, `v=1` → 303. The spy got a path ending in `/resume/v1/Jordan_Example_Resume_AtlasFreight.pdf`.
    - `v=9` → 404.
  - **Unknown app:** `POST /app/nope/note` with the token → 404.
  - `revealFile` is not spawned in tests (the spy replaces it). Unit-test only its argv choice by extracting `revealArgv(path, platform): string[]` and checking it for `darwin` / `linux`.
- [ ] **Step 2: Run** `bun test tests/ui-actions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the POST handlers, `revealArgv`, `revealFile` and the default `reveal`/`render` wiring.
- [ ] **Step 4: Run** `bun test tests/ui-actions.test.ts && bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): status, notes, re-render and reveal actions`

---

### Task 8: `resumely ui` command, README, browser check

**Files:**
- Create: `src/commands/ui.ts`
- Modify: `src/cli.ts`, `README.md`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `startUiServer`, `DEFAULT_UI_PORT` (Task 6), `openFile` (`commands/open.ts`), `resolveDataRoot`.
- Produces:
  - `parsePort(v: string | undefined): number | undefined`. `undefined` passes through. A non-`/^\d+$/` value or one > 65535 → `UserError('Invalid --port "<v>"', "Use a number from 0 to 65535 (0 = any free port)")`.
  - `runUi(o: { root: string; port?: number; open: boolean }): Promise<void>`. It:
    1. starts the server (`port` exact if given, else preferred `DEFAULT_UI_PORT`);
    2. prints `resumely ui running at <url>` and `Press Ctrl-C to stop.` to stdout;
    3. calls `openFile(url)` unless `open` is false;
    4. on SIGINT/SIGTERM, `await stop()` and `process.exit(0)`;
    5. otherwise never resolves.
  - CLI: `program.command("ui").description("Open the local viewer in your browser").option("--port <n>", "port (default 4317; 0 = any free port)").option("--no-open", "don't open the browser")`.
- README "Local UI" section:
  - the command and its flags
  - localhost-only and per-launch token, and that it writes only status, notes and re-renders
  - the three views, and that it stops with Ctrl-C
  - a privacy line: no network requests, no external assets

- [ ] **Step 1: Write failing tests** in `tests/cli.test.ts`:
  - `cli("ui", "--port", "abc")` exits 1 with stderr `Invalid --port "abc"`.
  - **Spawned server:**
    - Spawn `bun src/cli.ts ui --port 0 --no-open` (env `RESUMELY_HOME=root`).
    - Read stdout until a line matches `/running at (http:\/\/127\.0\.0\.1:\d+\/)/`, with a 10 s guard.
    - `fetch` that URL → 200 with a body containing `Applications`.
    - `proc.kill("SIGTERM")` → the exit code is 0.
  - **Review Focus 5:** with `Bun.serve({ hostname: "127.0.0.1", port: 0 })` occupying port P, `cli("ui", "--port", String(P), "--no-open")` exits 1 with stderr `Port P is in use` and `hint: Pick another with --port`.
  - `ui` with `RESUMELY_HOME` pointing at an empty dir exits 1 with `No resumely data root`.
- [ ] **Step 2: Run** `bun test tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/commands/ui.ts` and the CLI wiring.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Browser check.**
  1. Build a root with `makeUiRoot()` (a small `bun -e` script) and run `RESUMELY_HOME=<root> bun src/cli.ts ui --no-open`.
  2. In a real browser (the `chrome-devtools-axi` skill is available), check board, list, application (atlas v1 and v2, cover letter), empty app and profile. Use 1280px and 375px widths, in light and dark (emulate `prefers-color-scheme`).
  3. Confirm:
     - The PDF renders in the iframe.
     - Hovering a trace row marks its source entry.
     - "Copy path" copies.
     - "Show in Finder" reveals the file.
     - The console shows no CSP violations.
     - There is no horizontal scroll at 375px.
     - Focus rings are visible when tabbing.
  4. Fix what you find in the owning view or CSS. Commit any fixes with this task.
- [ ] **Step 6: Update the README.**
- [ ] **Step 7: Commit** `feat: resumely ui command; docs`
