// The dip-entry rule, in one file on purpose.
//
// Observed pattern: a clear favourite loses the opening part of a fixture -- one map of
// three, an early goal -- and its outright price collapses from 70-80% to 30-40% before it
// turns the match around and wins. The trough is the moment to buy, and it is a moment: it
// lasts minutes, not hours.
//
// So the rule is a pair of bands rather than a single threshold. A candidate is admitted
// only if BOTH hold:
//
//   1. the market OPENED in the high band -- it really was the favourite, not a coin flip
//      that drifted;
//   2. it is trading in the low band NOW -- the collapse has happened and we are buying it.
//
// Everything here is pure and nothing here does I/O, because four runtimes have to agree on
// the answer: the paper bot, the live executor, api.php's execution catalogue and the
// dashboard's candidate list. This module is the reference the tests hold the other copies
// against. If the rule turns out not to be profitable, deleting this file, the `dipEntry`
// config key and the four gates removes it completely -- nothing else depends on it.
//
// What it deliberately does NOT do:
//   - decide WHEN to look. A rule this narrow needs minute-level polling to catch a trough,
//     which is a scheduling problem and lives outside this file.
//   - size, price or place anything. The executor's own liquidity, spread, risk and capital
//     checks all still apply on top; this only decides whether a market is a candidate.
//   - find the market. This is the part that is not obvious, so it is written down here:
//     THE EXISTING SCRAPED CATALOGUE CANNOT SEE A DIPPED FAVOURITE AT ALL.
//     preferredMarketObservation() in paper-trading-bot.mjs retains only the LEADING
//     outcome of each market and returns null below 0.50, and
//     is_active_scraped_market_observation() in api.php independently drops anything under
//     0.50. So when a favourite falls from 78% to 35%, the retained row switches to the
//     other side of the fixture at 65% and the favourite's row -- along with the 78%
//     opening price this rule needs -- is discarded. Feeding this rule therefore needs
//     either a change to what the scan retains, or its own watch list that does not go
//     through the catalogue at all.

export const DIP_ENTRY_RULE_DEFAULTS = Object.freeze({
  enabled: false,
  // "It really was the favourite." The observed pattern starts here.
  openMin: 0.7,
  openMax: 0.8,
  // "The collapse has happened." The trough the rule exists to buy.
  buyMin: 0.3,
  buyMax: 0.4,
});

function probability(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  // Accept percents as well as fractions: a UI that sends 70 means 0.70, and rejecting it
  // silently would leave a rule that looks configured and admits nothing.
  const fraction = numeric > 1 ? numeric / 100 : numeric;
  if (!Number.isFinite(fraction)) return fallback;
  return Math.min(0.99, Math.max(0.01, Math.round(fraction * 10000) / 10000));
}

export function normalizeDipEntryRule(value) {
  const source = value && typeof value === "object" ? value : {};
  const openMin = probability(source.openMin, DIP_ENTRY_RULE_DEFAULTS.openMin);
  const openMax = probability(source.openMax, DIP_ENTRY_RULE_DEFAULTS.openMax);
  const buyMin = probability(source.buyMin, DIP_ENTRY_RULE_DEFAULTS.buyMin);
  const buyMax = probability(source.buyMax, DIP_ENTRY_RULE_DEFAULTS.buyMax);
  return {
    enabled: source.enabled === true || String(source.enabled).toLowerCase() === "true",
    // A band typed the wrong way round is an ordering slip, not an intent, so it is swapped
    // rather than refused. Bands in the WRONG PLACE relative to each other are a different
    // matter and are reported as a fault below, because swapping them would invent an
    // intent the person did not express.
    openMin: Math.min(openMin, openMax),
    openMax: Math.max(openMin, openMax),
    buyMin: Math.min(buyMin, buyMax),
    buyMax: Math.max(buyMin, buyMax),
  };
}

// The rule as a portfolio stores it.
//
// The buy band is NOT a setting of its own: it is the portfolio's ordinary probability
// range. Storing it twice was the first shape of this, and it was wrong in the way that
// matters -- the range is what every filter in the bot, the executor and the catalogue
// actually reads, so a portfolio whose range said 70-80 shortlisted favourites however its
// buy band was set. One number in two places is one number too many.
//
// So a dip portfolio reads: range 30-40 (where it buys), opening band 70-80 (where the
// market must have started). Three keys, not five.
export function dipEntryRuleFromConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  return normalizeDipEntryRule({
    enabled: source.dipEntryEnabled,
    openMin: source.dipEntryOpenMin,
    openMax: source.dipEntryOpenMax,
    buyMin: source.minProbability,
    // No maximum means the buy band has no ceiling, which necessarily reaches into the
    // opening band -- reported below as a fault rather than guessed at.
    buyMax: source.maxProbability == null ? 0.99 : source.maxProbability,
  });
}

// Why this configuration cannot be applied, or "" when it can.
//
// The entry band has to sit strictly below the opening band. Overlapping bands turn the
// rule into an ordinary probability filter that fires the instant a market is discovered
// inside the overlap -- no collapse required -- which is the opposite of what it is for. It
// is reported rather than silently corrected: a rule that quietly trades something other
// than what was asked for is worse than one that says it is not set up.
export function dipEntryRuleFault(rule) {
  const normalized = normalizeDipEntryRule(rule);
  if (normalized.buyMax >= normalized.openMin) {
    return "the probability range must sit below the opening band, or the rule fires without a collapse";
  }
  return "";
}

export function dipEntryRuleIsActive(rule) {
  const normalized = normalizeDipEntryRule(rule);
  return normalized.enabled && !dipEntryRuleFault(normalized);
}

// The band the rule buys in, which is the portfolio's own probability range -- returned here
// so a caller can ask for it by name rather than reaching for minProbability and having to
// know that is what it means. Null when the rule is off.
export function dipEntryProbabilityBand(rule) {
  if (!dipEntryRuleIsActive(rule)) return null;
  const normalized = normalizeDipEntryRule(rule);
  return { min: normalized.buyMin, max: normalized.buyMax };
}

const percent = (value) => `${(Number(value) * 100).toFixed(0)}%`;

// Number(null) is 0 and Number("") is 0, and both are finite -- so reading a missing price
// through Number() alone reports it as a market trading at 0%, which is not the same claim
// at all. A missing value has to stay missing.
function numericOrNull(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// Does this market pass the rule right now, and if not, why not. The reason is printed in
// run logs and in the dashboard's "why not" column, so it names the numbers.
//
// `openProbability` is the price the market was FIRST seen at (firstMarketProbability),
// which for an underway portfolio is its pre-match price -- the scrape finds a fixture well
// before it starts. A market with no opening price on record is refused rather than assumed:
// the whole premise is that it was a favourite, and an unverified premise is not one.
export function dipEntrySignal(observation, rule) {
  const normalized = normalizeDipEntryRule(rule);
  if (!normalized.enabled) return { admit: true, reason: "" };
  const fault = dipEntryRuleFault(normalized);
  if (fault) return { admit: false, reason: `dip entry rule is misconfigured: ${fault}` };

  // Underway only, and enforced here rather than left to the portfolio's own event mode.
  // The pattern is a comeback inside a fixture already in play; before kick-off a 35% price
  // is not a collapse, it is just a different market.
  if (observation?.eventRunning !== true) {
    return { admit: false, reason: "dip entry: the event is not under way" };
  }

  const opened = numericOrNull(observation?.openProbability);
  if (opened == null) {
    return { admit: false, reason: "dip entry: no opening probability on record, so the collapse cannot be verified" };
  }
  if (opened < normalized.openMin || opened > normalized.openMax) {
    return {
      admit: false,
      reason: `dip entry: opened at ${percent(opened)}, outside the ${percent(normalized.openMin)}-${percent(normalized.openMax)} opening band`,
    };
  }

  const now = numericOrNull(observation?.probability);
  if (now == null) {
    return { admit: false, reason: "dip entry: no current probability to compare against the entry band" };
  }
  if (now < normalized.buyMin || now > normalized.buyMax) {
    return {
      admit: false,
      reason: `dip entry: at ${percent(now)}, outside the ${percent(normalized.buyMin)}-${percent(normalized.buyMax)} entry band`,
    };
  }
  return { admit: true, reason: "" };
}

// One line for the parameter summary and the rules card, so the dashboard and a run log
// describe the same setting in the same words.
export function dipEntryRuleSummary(rule) {
  const normalized = normalizeDipEntryRule(rule);
  if (!normalized.enabled) return "Off";
  const fault = dipEntryRuleFault(normalized);
  const bands = `opened ${percent(normalized.openMin)}-${percent(normalized.openMax)}`
    + `, buy at ${percent(normalized.buyMin)}-${percent(normalized.buyMax)}`;
  return fault ? `Not applied - ${fault} (${bands})` : `On: ${bands}, events under way only`;
}

// Which markets are worth polling at minute resolution: the ones that opened inside the
// band and could still fall into the entry band. Kept here rather than in the poller so
// the poller has no rule logic of its own to drift from this file.
// The range to shortlist ON, which is not the range the portfolio buys in. A dipped
// favourite is picked up while it is STILL the favourite -- at 70-80%, where the catalogue
// has it -- and followed down. Applying the portfolio's own 30-40% range to that search
// would reject every market the rule exists to find.
export function dipEntryWatchBand(rule) {
  if (!dipEntryRuleIsActive(rule)) return null;
  const normalized = normalizeDipEntryRule(rule);
  return { min: normalized.openMin, max: normalized.openMax };
}

export function dipEntryWatchlist(observations, rule) {
  if (!dipEntryRuleIsActive(rule)) return [];
  const normalized = normalizeDipEntryRule(rule);
  return (Array.isArray(observations) ? observations : []).filter((item) => {
    const opened = numericOrNull(item?.openProbability ?? item?.firstMarketProbability);
    if (opened == null) return false;
    if (opened < normalized.openMin || opened > normalized.openMax) return false;
    // Already above the opening band, or already below the entry band, and the trough this
    // rule waits for is not ahead of it any more.
    const now = numericOrNull(item?.probability ?? item?.marketProbability ?? item?.marketPrice);
    if (now != null && now < normalized.buyMin) return false;
    return true;
  });
}
