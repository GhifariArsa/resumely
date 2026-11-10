export type KeywordCoverage = { present: string[]; missed_in_profile: string[]; absent: string[] };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive whole-token match: no letter/digit/#/+ directly on either side. */
function has(text: string, kw: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${esc(kw)}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

export function keywordCoverage(keywords: string[], documentText: string, profileText: string): KeywordCoverage {
  const seen = new Set<string>();
  const out: KeywordCoverage = { present: [], missed_in_profile: [], absent: [] };
  for (const raw of keywords) {
    const kw = raw.trim();
    if (!kw || seen.has(kw.toLowerCase())) continue;
    seen.add(kw.toLowerCase());
    if (has(documentText, kw)) out.present.push(kw);
    else if (has(profileText, kw)) out.missed_in_profile.push(kw);
    else out.absent.push(kw);
  }
  return out;
}
