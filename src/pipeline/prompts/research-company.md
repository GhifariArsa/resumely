# Task: research the company

Files in this directory:
- `job.md`: the job posting
- `parsed-job.json`: the parsed posting (company, role, keywords)
- `company.schema.json`: the JSON Schema your output must satisfy

Search the web for the company named in `parsed-job.json`. Use the company's own site, its engineering blog and recent news.

Collect 5-12 concise facts useful for opening a cover letter: product, customers, recent launches, engineering stack or culture, and mission.

Rules:
- Every fact must come from a page you actually opened. Put that page's URL in the fact's `source_url`, and list every URL used in `sources`.
- No facts about individuals (founders, employees, candidates).
- Keep each fact to one plain sentence. Use plain ASCII punctuation where possible.
- Fact ids are `co-1`, `co-2`, and so on.
- If you cannot find reliable information, write fewer facts rather than guessing. Never invent a fact or a URL.

Write `out/company.json` matching `company.schema.json`: `company`, `summary` (1-2 sentences), `facts`, `sources`. Write nothing else.
