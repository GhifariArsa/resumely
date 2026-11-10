import { extractPdfTextDetailed } from "../render/pdftext";
import { atsCheck, type AtsExpect, type AtsResult } from "./ats";
import { keywordCoverage, type KeywordCoverage } from "./keywords";

export type HardFacts = {
  pages: number;
  target_pages: number;
  fill: number | null;
  overflow: boolean;
  underflow: boolean;
  word_count: number;
  keywords: KeywordCoverage;
  ats: AtsResult;
  fabrication_warnings: string[];
};

/**
 * Deterministic measurements of a compiled resume. The result carries only keyword names, counts
 * and problems; no profile content (it is handed to a reviewer that must not see the profile).
 * `seam.text` (with `seam.reason` when null) overrides PDF extraction, for callers that already extracted it.
 */
export async function buildHardFacts(
  o: {
    pdf: Uint8Array;
    pages: number;
    fill: number | null;
    targetPages: number;
    atsExpect: AtsExpect;
    keywords: string[];
    profileText: string;
    contentText: string;
    fabricationWarnings?: string[];
  },
  seam: { text?: string | null; reason?: "missing" | "failed" } = {},
): Promise<HardFacts> {
  const ex = seam.text !== undefined ? { text: seam.text, reason: seam.reason } : await extractPdfTextDetailed(o.pdf);
  const text = ex.text;
  const doc = text ?? o.contentText;
  return {
    pages: o.pages,
    target_pages: o.targetPages,
    fill: o.fill,
    overflow: o.pages > o.targetPages,
    underflow: o.pages === o.targetPages && o.fill !== null && o.fill < 0.85,
    word_count: doc.split(/\s+/).filter(Boolean).length,
    keywords: keywordCoverage(o.keywords, doc, o.profileText),
    ats: atsCheck(text, o.atsExpect, ex.reason),
    fabrication_warnings: o.fabricationWarnings ?? [],
  };
}
