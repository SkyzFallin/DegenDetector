// ─── Category Classification ────────────────────────────────
// Maps market titles/tags to our detection categories.
// Uses keyword matching — good enough for prediction markets.

export const CATEGORIES = ["Regulatory", "Political", "Financial", "Legal", "Geopolitical", "Corporate", "Sports", "Entertainment", "Science", "Climate"];

export const LEAK_PROBS = {
  Regulatory: 0.8,
  Political: 0.5,
  Financial: 0.6,
  Legal: 0.75,
  Geopolitical: 0.7,
  Corporate: 0.8,
  Sports: 0.2,
  Entertainment: 0.3,
  Science: 0.4,
  Climate: 0.3,
};

const PATTERNS = {
  Sports: /\b(NBA|NFL|MLB|NHL|NCAA|MLS|soccer|football|basketball|baseball|hockey|tennis|golf|boxing|UFC|MMA|Super Bowl|World Cup|Olympics|championship|playoff|game\b|match\b|season\b|team\b|coach|player|score|MVP|draft\b)/i,
  Entertainment: /\b(movie|film|Oscar|Grammy|Emmy|album|song|music|Netflix|Disney|streaming|box office|celebrity|actor|actress|TV show|series|concert|festival|award|Billboard|podcast|YouTube|TikTok|influencer|viral)/i,
  Regulatory: /\b(SEC|CFTC|FDA|FCC|EPA|regulat|approv|ban|enforce|compliance|license|ETF\b|tariff)/i,
  Political: /\b(elect|president|senat|congress|house|governor|democrat|republican|GOP|vote|poll|nomin|inaugur|primary|caucus|party|biden|trump|legislat|bill\b|executive order|student loan|pope|prime minister)/i,
  Financial: /\b(fed\b|rate cut|rate hike|FOMC|IPO|stock split|acqui|merger|M&A|bitcoin|BTC|ethereum|ETH|crypto|gold|oil|S&P|nasdaq|dow\b|treasury|yield|inflation|recession|GDP|earnings|revenue)/i,
  Legal: /\b(convict|trial|lawsuit|sue|indict|verdict|sentenc|appeal|DOJ|FBI|court|judge|antitrust|settlement|guilty|plea)/i,
  Geopolitical: /\b(war|ceasefire|invad|invasion|treaty|NATO|UN\b|sanction|nuclear|diplomati|iran|china|taiwan|russia|ukraine|korea|peace|conflict|military|missile)/i,
  Climate: /\b(climate|warming|temperature|hurricane|tornado|earthquake|wildfire|flood|drought|volcano|weather|carbon|emission|paris agreement|sea level)/i,
  Science: /\b(Mars|space|NASA|SpaceX|rocket|satellite|AI\b|artificial intelligence|quantum|genome|vaccine|disease|pandemic|neuralink|colonize|asteroid)/i,
  Corporate: /\b(CEO|step down|resign|launch|product|acquire|IPO|goes public|shut down|layoff|hire|rebrand|split|spinoff|board|shareholder|dividend|buyback|partnership)/i,
};

/**
 * Classify a market title into a category.
 * Checks Kalshi event category first, then Polymarket event tags, then keyword regex.
 * Falls back to "Financial" if nothing matches.
 */
export function classifyCategory(text, events) {
  // Check event tags if available (Polymarket)
  if (events && Array.isArray(events)) {
    for (const ev of events) {
      const tag = (ev.slug || ev.title || "").toLowerCase();
      if (/politic|elect|trump|biden|pope/.test(tag)) return "Political";
      if (/regulat|sec-|fda|etf/.test(tag)) return "Regulatory";
      if (/crypto|finance|stock|fed-/.test(tag)) return "Financial";
      if (/legal|court|trial/.test(tag)) return "Legal";
      if (/geo|war|ukraine|china/.test(tag)) return "Geopolitical";
      if (/corporate|company|ceo/.test(tag)) return "Corporate";
      if (/sport|nba|nfl|mlb|nhl/.test(tag)) return "Sports";
      if (/entertain|movie|music|oscar|grammy/.test(tag)) return "Entertainment";
      if (/science|space|mars|ai\b/.test(tag)) return "Science";
      if (/climate|weather|warming|hurricane/.test(tag)) return "Climate";
    }
  }

  // Also check raw Kalshi category string if embedded in the text
  const lower = text.toLowerCase();
  if (/\bSports\b/i.test(text)) return "Sports";
  if (/\bEntertainment\b/i.test(text)) return "Entertainment";
  if (/\bClimate and Weather\b/i.test(text)) return "Climate";
  if (/\bScience and Technology\b/i.test(text)) return "Science";
  if (/\bElections\b/i.test(text) || /\bPolitics\b/i.test(text)) return "Political";
  if (/\bFinancials\b/i.test(text) || /\bEconomics\b/i.test(text)) return "Financial";
  if (/\bCompanies\b/i.test(text)) return "Corporate";
  if (/\bHealth\b/i.test(text)) return "Science";
  if (/\bWorld\b/i.test(text)) return "Geopolitical";

  // Keyword match on title — first match wins (order matters: Sports/Entertainment first)
  for (const [cat, regex] of Object.entries(PATTERNS)) {
    if (regex.test(text)) return cat;
  }

  return "Financial";
}
