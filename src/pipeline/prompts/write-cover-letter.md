# Task: write a tailored cover letter as structured JSON

Read these files in the current directory:
- `profile.json`: everything known about the candidate. Each entry has a stable `id`.
- `job.md`: the job posting.
- `parsed-job.json`: the structured version of the posting.
- `company.json`: researched facts about the company, each with an id like `co-1`. It may be absent.
- `voice/`: the candidate's own writing samples, if present.
- `banned.json`: phrases you must not use.

Write `out/cover-letter.json`. It must be valid JSON that conforms to `cover-letter.schema.json` in the current directory. Write only that file. Do not write LaTeX.

## Truthfulness rules (strict)
- The agent may select, reorder, rephrase, emphasise and mirror JD keywords.
- It may not invent skills, employers, titles, dates, metrics or credentials.
- Every generated claim traces to a profile entry. Each paragraph lists the `entry_ids` it draws from, and every id must exist in `profile.json`.
- JD requirements not supported by the profile are not claimed. Leave them out of the letter.
- Facts about the company come only from `company.json` (cite the fact ids in `company_fact_ids`) or from `job.md`. Never invent facts about the company.

## Voice
- Files in `voice/` are a style reference only: sentence length, tone, how the writer opens and closes. Never copy their content, employers, projects or numbers.
- Write plainly, like a person. No filler, no flattery, no clichés.
- Do not use any phrase in `banned.json` (matched case-insensitively).

## Structure
- `greeting`: exactly "Dear Hiring Team," unless `job.md` names a specific person to address, in which case use "Dear <Name>," with the name exactly as written there.
- `paragraphs`: 4 paragraphs, 250-350 words in total.
  1. Opening: ties to one specific company fact. Cite its id in `company_fact_ids`. Without `company.json`, tie it to one specific detail of the job posting instead.
  2. Evidence: built from one entry's context and stories. Cite it in `entry_ids`.
  3. Evidence: built from a second entry (or a different part of the first). Cite it in `entry_ids`.
  4. Close: short and concrete. No generic "I look forward to hearing from you" boilerplate.
- `closing`: "Sincerely,".
- Do not output the candidate's name, contact details, date or the company address. The system fills them in.
- Use plain text. Accented letters and the typographic dashes and quotes (– — ‘ ’ “ ”) are fine; avoid emoji and other symbols.
- Every number and every product, company or technology name in your text must appear in the entries and company facts you cite (numbers keep their units). The company name and the role title from the posting are also allowed.
- Any capitalised word mid-sentence (names, products, places, days) must appear in your sources.
