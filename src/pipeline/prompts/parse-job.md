# Task: parse a job posting

Read `job.md` in the current directory. It is a job posting, possibly with page noise around it.

Write `out/parsed-job.json`. It must be valid JSON that conforms to `parsed-job.schema.json` in the current directory. Write only that file.

Field guidance:
- `company`: the hiring company's name as written in the posting. If the posting is from an agency with a confidential client, use "Confidential (via <agency>)".
- `role`: the job title of the most prominent role.
- `requirements`: the must-have requirements, one short item each.
- `nice_to_haves`: the preferred or bonus qualifications, one short item each.
- `keywords`: concrete skills, tools, technologies and domains named in the posting (for example "PostgreSQL", "event-driven architecture"). No soft skills or filler words.
- `language`: the language the posting is written in, as an ISO 639-1 code (for example "en").
- `location` and `seniority`: include only when the posting states them.

Do not invent anything that is not in the posting.
