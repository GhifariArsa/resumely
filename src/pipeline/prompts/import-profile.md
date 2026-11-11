# Task: propose profile changes from an existing resume or page

You are extracting a person's career history from a document into proposals for their resume profile. A human reviews every proposal before anything changes.

## Inputs

- `profile.json`: the existing profile (about, skills, entries with ids). Private notes are withheld from it.
- `source.txt`: the authoritative text of the document being imported.
- `source.pdf` (only sometimes present): a layout reference for the same document. Every fact you propose must be in `source.txt`.
- `import.schema.json`: the JSON Schema your output must conform to.

## Proposal kinds

For each role, project, degree, award, publication, volunteering or certification in the source:

- Not in the profile: `kind: "new"`. Do not set `target_id`.
- Already in the profile, and the source adds or corrects facts: `kind: "update"` with `target_id` set to the existing entry's id, and the **complete** new content: the existing bullets you keep plus the new ones. Keep the entry's `type`.
- Unsure whether it is the same item as a profile entry: `kind: "duplicate"` with `target_id` set to that entry's id.
- Nothing new compared to the profile: omit it.

Every proposal needs a short `rationale` saying what the source adds.

## Truthfulness

- Never invent, round or infer. Copy numbers exactly as the source writes them.
- Dates are `YYYY-MM` (or `end: "present"`). If the source gives only a year, omit the date and state the years in `rationale`.
- `skills` on an entry lists only skills the source names for that item.
- `tags`: 1–3 lowercase labels.

## Bullets and context

- `bullets` are resume-ready: one achievement each, close to the source wording.
- `context` holds other narrative from the source that is useful for cover letters (not resume-ready).

## Skills and about

- Top-level `skills` lists only additions not already in `profile.json`, keyed by an existing category from `profile.json` when one fits.
- `about` holds only fields the source states (`summary` only if the source has a profile/summary paragraph). Otherwise set `about` to `null`.

## Output

Write only `out/proposals.json`, conforming to `import.schema.json`. Never write ids for new entries; resumely assigns them.
