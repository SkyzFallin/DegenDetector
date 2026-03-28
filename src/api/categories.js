// ─── Category Classification ────────────────────────────────
// Maps market titles/tags to our 6 detection categories.
// Uses keyword matching — good enough for prediction markets.

export const CATEGORIES = ["Regulatory", "Political", "Financial", "Legal", "Geopolitical", "Corporate"];

export const LEAK_PROBS = {
  Regulatory: 0.8,
  Political: 0.5,
  Financial: 0.6,
  Legal: 0.75,
  Geopolitical: 0.7,
  Corporate: 0.8,
};

const PATTERNS = {
  Regulatory: /\b(SEC|CFTC|FDA|FCC|EPA|regulat|approv|ban|enforce|compliance|license|ETF\b|tariff)/i,
  Political: /\b(elect|president|senat|congress|house|governor|democrat|republican|GOP|vote|poll|nomin|inaugur|primary|caucus|party|biden|trump|legislat|bill\b|executive order|student loan)/i,
  Financial: /\b(fed\b|rate cut|rate hike|FOMC|IPO|stock split|acqui|merger|M&A|bitcoin|BTC|ethereum|ETH|crypto|gold|oil|S&P|nasdaq|dow\b|treasury|yield|inflation|recession|GDP|earnings|revenue)/i,
  Legal: /\b(convict|trial|lawsuit|sue|indict|verdict|sentenc|appeal|DOJ|FBI|court|judge|antitrust|settlement|guilty|plea)/i,
  Geopolitical: /\b(war|ceasefire|invad|invasion|treaty|NATO|UN\b|sanction|nuclear|diplomati|climate|paris|iran|china|taiwan|russia|ukraine|korea|peace|conflict|military|missile)/i,
  Corporate: /\b(CEO|step down|resign|launch|product|acquire|IPO|goes public|shut down|layoff|hire|rebrand|split|spinoff|board|shareholder|dividend|buyback|partnership)/i,
};

/**
 * Classify a market title into one of our 6 categories.
 * Falls back to "Financial" for prediction market defaults.
 */
export function classifyCategory(text, events) {
  // Check event tags if available (Polymarket)
  if (events && Array.isArray(events)) {
    for (const ev of events) {
      const tag = (ev.slug || ev.title || "").toLowerCase();
      if (/politic|elect|trump|biden/.test(tag)) return "Political";
      if (/regulat|sec-|fda|etf/.test(tag)) return "Regulatory";
      if (/crypto|finance|stock|fed-/.test(tag)) return "Financial";
      if (/legal|court|trial/.test(tag)) return "Legal";
      if (/geo|war|ukraine|china|climate/.test(tag)) return "Geopolitical";
      if (/corporate|company|ceo/.test(tag)) return "Corporate";
    }
  }

  // Keyword match on title — first match wins (order matters)
  for (const [cat, regex] of Object.entries(PATTERNS)) {
    if (regex.test(text)) return cat;
  }

  return "Financial"; // default for prediction markets
}
