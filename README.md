# resumely

Tailor your resume and a cover letter to a job posting using the coding agent you already have. You keep a profile of markdown files describing your experience. `resumely apply` parses a job description, researches the company on the web, then drives a headless coding-agent CLI (claude, codex or pi) to select and reword real entries from your profile into a one-page resume and a one-page cover letter, compiled to PDF with LaTeX. Every bullet is traced back to the profile entries it came from, titles, employers, locations and dates are filled in from your entries rather than written by the agent, skills must exist in your profile, and requirements your profile doesn't cover are listed as gaps instead of being invented.

## Prerequisites

- [Bun](https://bun.sh)
- TeX Live with `latexmk` (to compile the PDF)
- One agent CLI, installed and logged in: `claude`, `codex`, or `pi` (pi needs a configured provider; see [Adapters](#adapters))

## Install

```sh
bun install
bun link        # puts `resumely` on your PATH
```

## Quickstart

```sh
resumely init                                     # creates ~/resumely/ with a starter profile and config.toml
resumely profile import ~/Downloads/resume.pdf    # or a LinkedIn PDF, .docx, .md, or a URL
resumely profile review                           # accept what's right (nothing reaches your profile without this)
resumely apply --clip                             # job description from the clipboard (or pass a file or URL)
resumely ls                                       # list applications
resumely open <app>                               # open the latest resume PDF, or the cover letter if there is no resume (--version N for another)
```

`apply` refuses an empty profile (it tells you to import one) and warns when proposals are still waiting in the review inbox.

## Building your profile

You don't have to write the profile by hand. Agents propose entries; you decide. Everything lands in a review inbox (`profile/.inbox/`, one JSON proposal per file) and only `resumely profile review` writes entry files, `skills.yaml` or `about.md`. Agents never write the live profile.

### Import

```sh
resumely profile import <file|url> [--harness <name>]
```

Supported sources and what they need:

- PDF: `pdftotext` (poppler). The original PDF is also given to the agent as a layout reference.
- DOCX: converted to text by `textutil` (macOS), else `pandoc`, else `unzip`; one of them must be installed.
- `.md`, `.txt`, `.html`: read directly.
- A URL (for example a public portfolio page): fetched by resumely itself. This extends the "job URLs only" network rule to URLs you explicitly pass to `import`; resumely never fetches anything you didn't ask for.

The agent compares the document with your current profile and proposes new entries, updates to existing entries, possible duplicates, skills and `about` details. Resumely assigns the entry ids. Progress goes to stderr; stdout lists what was staged.

**Truthfulness rule.** An import may only state what the source says. Every number in a title, bullet, context, headline or summary must appear in the source text, every skill must appear as a whole word in it, the year of each start/end date must appear in it, and `about` name, email, phone and links must appear in it. Violations make the agent retry (up to 2 times), then the import fails with the workspace kept under `.runs/`. Proper nouns that don't appear in the source can't be ruled out as easily, so they are shown as `! unsourced "<name>"` flags on the proposal for you to check. Year-only dates in a source are left out rather than guessed, and the proposal's rationale says so.

### Review

```sh
resumely profile review            # interactive
resumely profile review --list     # what is waiting
resumely profile review --accept 3 --reject 4 [--as update|new]
resumely profile review --accept-all
```

Interactive keys: `a` accept, `e` edit in `$VISUAL`/`$EDITOR` (split on whitespace, never run through a shell), `r` reject, `s` skip, `q` quit; a possible duplicate offers `u` update the existing entry and `n` add as a new entry. Accepting an update keeps the existing entry's `## Private` sections. `--accept-all` skips possible duplicates, which need an explicit `--accept <pid> --as update|new`. Decided proposals are moved to `profile/.inbox/archive/` with the decision, as an audit trail.

### Add one thing

```sh
resumely profile add experience --title "Staff Engineer" --org "Acme" --start 2025-01 --end present --bullet "Cut fleet downtime 35%"
resumely profile add --json - <<'EOF'
{"type":"experience","title":"Staff Engineer","org":"Acme","start":"2025-01","end":"present","bullets":["Cut fleet downtime 35%"]}
EOF
```

`profile add` stages a proposal too (types: experience, project, education, award, publication, volunteering, certification, other, skills, about). Use `--update <id>` to propose a change to an existing entry. It is also the command the interview agent calls.

### Interview

```sh
resumely interview [--harness <name>] [--focus "recent work at Acme"]
```

Opens your agent harness interactively (interactive terminals only) in a workspace holding your profile, minus private content, plus instructions to interview you. The agent stages what it learns with `profile add`; your harness's own permission prompt gates each call. Review the result with `profile review`. The launch command per harness is built in; override it with `interactive_command` on an adapter (an argv array; `{prompt}`, `{workspace}` and `{inbox}` are substituted):

```toml
[adapters.mine]
interactive_command = ["my-agent", "{prompt}"]
```

### Lint

```sh
resumely profile lint [--json]
```

Prints problems and exits 1 if any is an `error`. Codes: `parse-error`, `duplicate-id`, `end-before-start` and `future-start` (errors); `future-end`, `missing-dates`, `outcome-less-bullet` (a bullet without a measurable result), `duplicate-skill`, `private-heading`, `unused-entry` (not cited by any resume or cover letter; only checked once you have applications) and `pending-proposals` (warnings).

### Trace

```sh
resumely trace <app> [--cover] [--version N] [--json]
```

Shows each resume bullet (or cover-letter paragraph) with the profile entries it came from, whether it was a direct or inferred claim, any unsourced-token flags, the gaps and the warnings from the checks.

### apply

```sh
resumely apply [input] [--clip] [--harness <name>] [--template <id>] [--pages <n>]
               [--stretch] [--no-cover] [--no-research] [--no-review] [--review]
               [--into <app>] [--new] [--no-open]
```

- `--stretch`: allow inferred claims (reasonable but not stated in your profile). They are printed as `inferred claims to review:` and marked in the trace; default mode is truthful.
- `--no-cover`, `--no-research`, `--no-review`: skip the cover letter, the company research, or the review loop.
- `--review`: pause after the job is parsed so you can confirm it (interactive terminals only).
- `--pages <n>`: resume page target (default 1).
- `--into <app>` adds a new version to an existing application; `--new` creates a separate one. If a duplicate of the same job exists and you pass neither, you are asked.

Other commands:

- `ls [--status <s>] [--company <text>]`, `open <app> [--cover] [--version N]`
- `render <app> --template <id> [--cover] [--version N]` re-renders a saved version with the given template (required) without calling the agent
- `status <app> <drafted|applied|interviewing|rejected|offer>`: `applied` is refused while a document is not ready unless you pass `--force`
- `note <app> <text...>`: dated note on an application
- `export <app> [--version N] [--to <dir>]`: copy the send-ready PDFs of whichever documents exist (default `~/Desktop`)
- `profile show [id]`, `profile context`, `profile import`, `profile review`, `profile add`, `profile lint`, `interview`, `trace` (see [Building your profile](#building-your-profile))

Set `RESUMELY_HOME` to use a different data root. Every run produces versioned outputs under `applications/<date>-<company>-<role>/{resume,cover-letter}/vN/` (PDF, source, trace, `review.json`, `meta.json`).

## Cover letters and voice samples

The cover letter is written from your profile, the job and the company research, never from the finished resume. To make it sound like you, put 1 to 3 samples of your own writing (plain markdown, a few hundred words each) in `profile/voice/`. They are used only as a style reference; without them the letter is still written, in a plainer default voice. Letters are checked for banned filler phrases and for claims that no profile entry or research fact supports.

## Company research and privacy

Before writing, the agent searches the web for the company (what it does, recent news, engineering culture) using the harness's own web tools. The research step receives exactly one data file, `target.json`, holding the company name, the role title, the location (if the posting states one) and the posting's URL (if you applied from a URL), plus the output schema. It does not receive the job posting text, your profile or anything else from your data root: it runs in a fresh temporary directory outside the data root, and only its output and logs are copied back to `.runs/<run>/research/`. Fetched pages are treated as untrusted data. Facts must carry a source URL. If nothing verifiable is found (an unknown or fictional company, say) the research returns no facts, `meta.json` records `research: "none_found"`, and the letter is written from the posting alone rather than guessing. `apply` prints `warning: research failed` only when the step itself fails. `claude` and `codex` have research presets; `pi` has no web tools, so research is skipped with a warning unless you set `research_command` on your adapter. `--no-research` skips it.

## Review loop and ready gates

Each document goes through: write, compile, hard checks (ATS-readable text, page count, trace of every claim to profile entries), an HR-persona review, and up to 2 revision rounds. Resume and cover letter run concurrently. Expect roughly 8 to 17 minutes per application with the real harnesses (measured: claude 8 to 12 min, codex about 12 min, pi about 17 min), since each stage is a separate headless agent call. `meta.json` records `rounds`, `reviewed_final` (whether the final text is the one the last review judged, whatever its verdict), `research` (`used`, `none_found`, `skipped` or `failed`) and `review_verdict` (that last review's verdict). The reviewer asks for a revision only when a fix would plausibly change a recruiter's shortlist decision (or on overflow, an ATS failure or a templated letter); other suggestions stay in `review.json` as polish. A revision that changes nothing ends the loop.

A version is **ready** when an ATS can read the PDF and it fits its page target. If not, `apply` prints `not ready: <reason>`, exits with status 1, and `status ... applied` is refused without `--force`. A version that still got a `revise` verdict after the last round is still ready, but check `review.json` for what the reviewer wanted. Requirements your profile can't back are listed as `gaps:` (add them to your profile if true), not invented.

## Profile format

One markdown file per entry, with YAML front matter. Example `profile/experience/atlas-labs.md`:

```markdown
---
id: exp-atlas-labs
type: experience
title: Senior Software Engineer
org: Atlas Labs
location: Montreal, QC
start: 2023-03
end: present
skills: [TypeScript, React, PostgreSQL]
tags: [backend]
---

## Highlights

- Led a team of 4 to rebuild the billing dashboard, cutting page load time by 60%.
- Designed an event-driven ingestion pipeline processing 2M events per day.

## Private

Was told the team will be laid off in Q3.
Compensation: 145000 CAD plus equity.
```

A `## Private` section (also `## Private:` or `## Private notes`, up to the next `## ` heading) and `private:` keys in `about.md` front matter are **never included in what resumely sends to the agent**: they are stripped before the agent's workspace files are written, so they don't reach the prompt or the resume. Use them for context you want to keep next to the entry but not share. Other sections, such as `## Notes`, are visible to the agent; `resumely profile context` warns about other headings that mention "private" (such as `### Private`) but are not withheld.

### Agent access

The writer and reviewer agents run with file tools in a workspace inside your data root (`~/resumely/.runs/<run>/`, kept as a debug trail), so they could read other files there, including your raw profile. The web-capable research agent runs outside the data root (see [Company research and privacy](#company-research-and-privacy)). How far it can reach depends on the harness: `claude` is limited to the tools in `--allowedTools`, `codex` runs in its `workspace-write` sandbox, and `pi` has no sandbox. Job postings are untrusted input; treat job URLs from unknown sources with care.

### Debugging what the agent sees

```sh
resumely profile context
```

Prints the exact profile content that is handed to the agent, with private content removed.

## Adapters

Built-in presets exist for `claude`, `codex` and `pi`. Choose one with `harness = "..."` in `~/resumely/config.toml` or `--harness`. Override a preset or add your own; commands are argv arrays (no shell), with `{prompt}`, `{workspace}` and `{model}` substituted. `{model}` takes the adapter's optional `model` key; when no model is set, an argv element that is exactly `"{model}"` is dropped together with the flag just before it, so `"--model", "{model}"` simply disappears. The presets don't pass a model, so to pick one, override the adapter:

```toml
[adapters.claude]
command = ["claude", "-p", "{prompt}", "--model", "{model}", "--permission-mode", "acceptEdits", "--allowedTools", "Read Write Edit Glob"]
model = "sonnet"
```

Using pi with a specific provider:

```toml
harness = "pi"

# (example provider — use one you've configured)
[adapters.pi]
command = ["pi", "-p", "--no-session", "--provider", "openai-codex", "--tools", "read,write,edit", "{prompt}"]
check = ["pi", "--version"]
```

The pi preset defaults to pi's default provider (google). If that provider isn't authenticated, override the adapter as above with a provider you have set up (`pi auth check --provider <name>`); pi requires a configured provider.

## Status: P4

Works now:

- `init`, `profile show`, `profile context`
- Profile building: `profile import` (PDF, DOCX, Markdown, text, HTML, URL), the review inbox (`profile review`), `profile add`, `interview`, `profile lint`, and `trace`
- `apply`: job parse, company research, tailored resume and cover letter with review loop, gaps, traces, `--stretch`
- Versioned applications: `ls`, `open`, `render`, `status`, `note`, `export`
- Private-content withholding
- claude and codex verified end to end including web research; pi verified with a provider override (research skipped, no web tools)

Coming next:

- Roadmap beyond P4: see [design.md](design.md)
