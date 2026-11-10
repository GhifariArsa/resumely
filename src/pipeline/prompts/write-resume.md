# Task: write a tailored resume as structured JSON

Read these files in the current directory:
- `profile.json`: everything known about the candidate. Each entry has a stable `id`.
- `job.md`: the job posting.
- `parsed-job.json`: the structured version of the posting.

Write `out/resume.json`. It must be valid JSON that conforms to `resume.schema.json` in the current directory. Write only that file. Do not write LaTeX.

## Truthfulness rules (strict)
{{mode_rules}}

## Content
- Do not output the candidate's name or contact details. The system fills them in.
- Target {{pages}} page(s). For recent roles write about 3-5 bullets; for older roles, fewer. Cut the least relevant material rather than padding.
- Your job is to pick which profile entries to show, in what order, and to write their bullets. You do not write titles, employers, locations or dates: the system fills each item's heading, organisation, location and dates from the profile entry it cites.
- Order sections and items by relevance to this job. Use `kind` "experience", "projects", "education" or "extras", with a readable `title`. Never output an empty section.
- An item's entry must match its section: `experience` entries go in "experience", `project` entries in "projects", `education` entries in "education", and `award`, `publication`, `volunteering`, `certification` or `other` entries in "extras".
- For each item, `entry_id` is the profile entry it presents. Every bullet in that item must include the item's `entry_id` in its `entry_ids` (it may cite other entries too).
- `skills`: group the candidate's skills into short categories, putting the ones the job asks for first. Every listed skill must appear verbatim in the profile, either in `skills` or in an entry's `skills`.
- Use plain text. Accented letters and the typographic dashes and quotes (– — ‘ ’ “ ”) are fine; avoid emoji and other symbols.
- Bullets start with a strong past-tense verb (present tense for the current role), use no first person, and keep numbers exactly as in the profile.
- Every number and every product, company or technology name in your text must appear in the entries you cite (numbers keep their units).
