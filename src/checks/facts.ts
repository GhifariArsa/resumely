import { extractPdfText } from "../render/pdftext";
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
 * `seam.text` overrides PDF extraction (tests).
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
  seam: { text?: string | null } = {},
): Promise<HardFacts> {
  const text = seam.text !== undefined ? seam.text : await extractPdfText(o.pdf);
  const doc = text ?? o.contentText;
  return {
    pages: o.pages,
    target_pages: o.targetPages,
    fill: o.fill,
    overflow: o.pages > o.targetPages,
    underflow: o.pages === o.targetPages && o.fill !== null && o.fill < 0.85,
    word_count: doc.split(/\s+/).filter(Boolean).length,
    keywords: keywordCoverage(o.keywords, doc, o.profileText),
    ats: atsCheck(text, o.atsExpect),
    fabrication_warnings: o.fabricationWarnings ?? [],
  };
}
