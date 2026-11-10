# resumely

Tailor your resume to a job posting using the coding agent you already have. You keep a profile of markdown files describing your experience. `resumely apply` parses a job description, then drives a headless coding-agent CLI (claude, codex or pi) to select and reword real entries from your profile into a one-page resume, compiled to PDF with LaTeX. Every bullet is traced back to the profile entries it came from, titles, employers, locations and dates are filled in from your entries rather than written by the agent, skills must exist in your profile, and requirements your profile doesn't cover are listed as gaps instead of being invented.

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
resumely init                # creates ~/resumely/ with a starter profile and config.toml
# edit ~/resumely/profile/   (about.md, skills.yaml, experience/, projects/, education/, extras/)
resumely apply --clip        # job description from the clipboard (or pass a file or URL)
resumely ls                  # list applications
resumely open <app>          # open the latest resume PDF (--version N for another)
```

Other options: `apply [input] [--clip] [--harness <name>] [--template <id>] [--no-open]`, `render <app> --template <id>` to re-render with another template, `profile show [id]`. Set `RESUMELY_HOME` to use a different data root.

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

The agent runs with file tools in a workspace inside your data root (`~/resumely/.runs/<run>/`, kept as a debug trail), so it could read other files there, including your raw profile. How far it can reach depends on the harness: `claude` is limited to the tools in `--allowedTools`, `codex` runs in its `workspace-write` sandbox, and `pi` has no sandbox. Job postings are untrusted input; treat job URLs from unknown sources with care.

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

## Status: P1

Works now:

- `init`, `profile show`, `profile context`
- `apply`: job parse, tailored one-page resume, gaps, trace
- `ls`, `open`, `render`
- Private-content withholding
- claude and codex verified end to end; pi verified with a provider override (see [Adapters](#adapters))

Coming next:

- Roadmap beyond P1: see [design.md](design.md)
