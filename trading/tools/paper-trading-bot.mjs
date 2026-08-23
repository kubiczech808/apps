#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function envNumber(name, fallback = null) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function normalizeStopLossRiskMultiplier(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(3, Number(numeric.toFixed(2))));
}

function envStopLossRiskMultiplier(prefix, fallback = 0) {
  const explicit = envNumber(`${prefix}_STOP_LOSS_RISK_MULTIPLIER`, null);
  if (Number.isFinite(explicit)) return normalizeStopLossRiskMultiplier(explicit, fallback);
  return envBool(`${prefix}_STOP_LOSS_ENABLED`, fallback > 0)
    ? (fallback > 0 ? fallback : 1)
    : 0;
}

function rowStopLossRiskMultiplier(row = {}, fallback = 0) {
  if (row && Object.prototype.hasOwnProperty.call(row, "stopLossRiskMultiplier")) {
    return normalizeStopLossRiskMultiplier(row.stopLossRiskMultiplier, fallback);
  }
  return row?.stopLossEnabled === true ? (fallback > 0 ? fallback : 1) : 0;
}

function envText(name, fallback = "") {
  const value = String(process.env[name] || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return value || fallback;
}

function envSelectionOrder(name, fallback = "highest_ev_pa_first") {
  return process.env[name] === "highest_reward_risk_first" ? "highest_reward_risk_first" : fallback;
}

function normalizePortfolioMarketType(value, legacyMultichoice = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["all", "binary", "multi"].includes(normalized)) return normalized;
  return legacyMultichoice ? "multi" : "all";
}

function envPortfolioMarketType(name, legacyName, fallback = "all") {
  return normalizePortfolioMarketType(
    process.env[name],
    envBool(legacyName, fallback === "multi"),
  );
}

function envProbabilitySource(name, fallback = "polymarket") {
  // With no model consulted there is no AI probability to rank on, so an "ai" setting --
  // whether from the workflow or the stored portfolio config on the hosting -- would
  // leave every candidate with a NaN probability and nothing executable.
  if (!AI_ANALYSIS_ENABLED) return "polymarket";
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (value === "polymarket") return "polymarket";
  if (value === "ai") return "ai";
  return fallback;
}

function envTokenIdSet(name) {
  return new Set(String(process.env[name] || "")
    .split(",")
    .map((tokenId) => tokenId.trim())
    .filter((tokenId) => /^\d{8,100}$/.test(tokenId)));
}

// Whole Polymarket tags a portfolio refuses. Slugged the way the dashboard and the live
// executor slug them, or a tag saved as "E-Sports" would never match the `esports` a
// market carries. Empty excludes nothing, which is what an unset variable means too.
function envTagSet(name) {
  return new Set(String(process.env[name] || "")
    .split(/[,\s]+/)
    .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean));
}

const OUTPUT_PATH = process.env.PAPER_STATE_PATH || "data/paper-state.json";
const SCAN_HISTORY_ENTRY_PATH = process.env.PAPER_SCAN_HISTORY_ENTRY_PATH || "data/market-scan-history-entry.ndjson";
// Every portfolio's runLog is capped to PORTFOLIO_RUN_LOG_LIMIT in the published state, so
// older entries are gone the moment a new one pushes them out. Mirrors the scan-history
// journal: this run's newest entries are written here, and the workflow appends them to a
// per-portfolio, per-month archive the dashboard can page back through indefinitely.
const PORTFOLIO_RUN_LOG_ENTRY_PATH = process.env.PAPER_PORTFOLIO_RUN_LOG_ENTRY_PATH || "data/portfolio-run-log-entry.ndjson";
// Written only when a scan attempt failed. The scan workflow publishes the state first and
// then reads this file, so a failed scan still lands in the dashboard's log and the run
// itself turns red instead of reporting success over a scan that fetched nothing.
const SCAN_ERROR_MARKER_PATH = process.env.PAPER_SCAN_ERROR_PATH || "data/market-scan-error.txt";
const REMOTE_STATE_URL = process.env.PAPER_STATE_URL || "";
// The PHP summary endpoint is preferred because it is small and validated by
// the app. The static file is a recovery path for a state that is temporarily
// too large for PHP to parse during a migration.
const STATIC_STATE_URL = process.env.PAPER_STATIC_STATE_URL || "";
// Heavy state segments are fetched straight from the hosting directory. Default
// to the directory that holds the static state file so a single configured URL
// keeps covering both.
const STATE_SEGMENT_BASE_URL = (process.env.PAPER_STATE_SEGMENT_BASE_URL
  || (STATIC_STATE_URL ? STATIC_STATE_URL.replace(/\/[^/?#]*(?:[?#].*)?$/, "/") : "")).trim();
const PORTFOLIO_USDC = envNumber("PAPER_PORTFOLIO_USDC", 100);
const MAX_FRACTION = envNumber("PAPER_MAX_FRACTION", 0.05);
const STAKE_USDC = Math.max(0.01, envNumber("PAPER_STAKE_USDC", PORTFOLIO_USDC * MAX_FRACTION));
const MIN_PROBABILITY = envNumber("PAPER_MIN_PROBABILITY", 0.95);
const CONSERVATIVE_MIN_PROBABILITY = envNumber("PAPER_CONSERVATIVE_MIN_PROBABILITY", MIN_PROBABILITY);
const HIGH_REWARD_MIN_PROBABILITY = envNumber("PAPER_HIGH_REWARD_MIN_PROBABILITY", 0.6);
const MORE_PROBABLE_STRATEGY_MIN_PROBABILITY = envNumber("PAPER_MORE_PROBABLE_MIN_PROBABILITY", 0.6);
const MIN_ANNUAL_RETURN = envNumber("PAPER_MIN_ANNUAL_RETURN", 0.05);
const OPPORTUNITY_MIN_PROBABILITY = envNumber("PAPER_OPPORTUNITY_MIN_PROBABILITY", 0.6);
const OPPORTUNITY_MIN_EDGE = envNumber("PAPER_OPPORTUNITY_MIN_EDGE", 0.04);
const OPPORTUNITY_MIN_ANNUAL_RETURN = envNumber("PAPER_OPPORTUNITY_MIN_ANNUAL_RETURN", 0.3);
const MAX_EVALUATIONS_PER_RUN = envNumber("PAPER_MAX_EVALUATIONS_PER_RUN", 80);
const MAX_SPREAD = envNumber("PAPER_MAX_SPREAD", 0.08);
const MIN_VOLUME_24H = envNumber("PAPER_MIN_VOLUME_24H", 100);
const MAX_HISTORY = envNumber("PAPER_MAX_HISTORY", 5000);
const PAPER_CLOSED_TRADE_HISTORY_LIMIT = Math.max(50, envNumber("PAPER_CLOSED_TRADE_HISTORY_LIMIT", 300));
const EVALUATION_RUN_LOG_LIMIT = Math.max(12, envNumber("PAPER_EVALUATION_RUN_LOG_LIMIT", 24));
const CALCULATION_REPORT_HISTORY_LIMIT = Math.max(2, envNumber("PAPER_CALCULATION_REPORT_HISTORY_LIMIT", 6));
// Every scan persists a Gamma keyset cursor. A single run processes one
// bounded page, while later runs continue exactly where the prior one ended.
// This makes the catalogue exhaustive over time without producing a huge
// state file or repeatedly re-reading the same API pages.
const MARKET_SCAN_PAGE_SIZE = Math.max(1, Math.min(500, envNumber("PAPER_MARKET_SCAN_PAGE_SIZE", 500)));
const MARKET_SCAN_EVENT_BATCH_LIMIT = Math.max(1, Math.min(500, envNumber("PAPER_MARKET_SCAN_EVENT_BATCH_LIMIT", MARKET_SCAN_PAGE_SIZE)));
// These are retention limits for the local, UI-facing quote cache. They do
// not limit Gamma intake: keyset cursors keep advancing through every result.
const MARKET_OBSERVATION_RETAIN_LIMIT = Math.max(500, envNumber("PAPER_MARKET_OBSERVATION_RETAIN_LIMIT", 5000));
// Resolved observations are published in their own segment file, so retaining more
// of them no longer costs the active catalogue anything and no longer inflates the
// requests that never read them. The old 1000 cap is why the resolved count stopped
// growing and started churning.
//
// This is bounded by what one scraped response can carry, not by storage: measured on
// a 5000-row active catalogue, the scraped summary peaks around 35 MB at 1000 resolved
// rows and 111 MB at 8000, and a shared host will answer 500 well before that. Serving
// the archive in pages is what removes the ceiling; until then 3000 is the largest
// value that keeps every endpoint comfortably inside a 128 MB limit.
const MARKET_SCAN_AUDIT_ROW_LIMIT = Math.max(100, envNumber("PAPER_MARKET_SCAN_AUDIT_ROW_LIMIT", 750));
// The public state keeps a short working cache; the workflow appends every
// compact scan summary to the separate scan-history journal.
// A quote of 0.9996 is displayed as 100.0% and has no executable upside left, but a
// bare `>= 1` test lets it through, which is how resolved rows ended up showing 100%
// market probability. Anything that rounds to 100.0% counts as settled at scrape time
// and is not stored. Mirrors EFFECTIVELY_CERTAIN_MARKET_PROBABILITY in the executor.
const EFFECTIVELY_CERTAIN_MARKET_PROBABILITY = Math.min(
  1,
  envNumber("PAPER_EFFECTIVELY_CERTAIN_MARKET_PROBABILITY", 0.9995),
);
const MARKET_SCAN_HISTORY_LIMIT = Math.max(5, Math.floor(envNumber("PAPER_MARKET_SCAN_HISTORY_LIMIT", 20)));
const MARKET_SCAN_AUDIT_HISTORY_LIMIT = envNumber("PAPER_MARKET_SCAN_AUDIT_HISTORY_LIMIT", 3);
const PORTFOLIO_RUN_LOG_LIMIT = Math.max(20, envNumber("PAPER_PORTFOLIO_RUN_LOG_LIMIT", 24));
const TRADE_BATCH_CANDIDATE_LOG_LIMIT = Math.max(4, envNumber("PAPER_TRADE_BATCH_CANDIDATE_LOG_LIMIT", 12));
const TRADE_BATCH_REASON_LOG_LIMIT = Math.max(5, envNumber("PAPER_TRADE_BATCH_REASON_LOG_LIMIT", 24));
const MARKET_SCAN_DIVERSITY_LIQUIDITY_USDC = envNumber("PAPER_MARKET_SCAN_DIVERSITY_LIQUIDITY_USDC", 40000);
// This is the user's last saved scraped-opportunities liquidity filter. It is
// passed to Gamma before response data is transferred or stored.
const MARKET_SCAN_LIQUIDITY_MIN = Math.max(0, envNumber("PAPER_MARKET_SCAN_LIQUIDITY_MIN", 0));
// Events shown on polymarket.com/sports/live and /esports/live. Measured against the
// Gamma API (see tools/gamma-live-probe.mjs), not assumed:
//
//   * `live=true` is a real server-side filter. The same sports query returned 100
//     events unfiltered with 1 live among them, and exactly 2 events with the filter,
//     both live and both tradable. The live set is therefore tiny and cheap to fetch
//     in full on every run, instead of waiting for the round-robin to reach sports
//     roughly once every twenty runs while a match lasts two hours.
//   * `end_date_min` is honoured. Without it, ordering by endDate ascending puts
//     months-old closed events at the head of every page: the first samples came back
//     `closed=true` with prices 1/0, which the retention filter then discards, so the
//     page budget was spent learning nothing. With it, every event on the page had a
//     tradable market (sports 100/100, esports 44/44, none fully closed).
//   * `start_date_max` is silently ignored, so "has it started" is still derived from
//     gameStartTime/eventStartTime as sportsScheduledEventDate already does.
const MARKET_SCAN_LIVE_ENABLED = envBool("PAPER_MARKET_SCAN_LIVE", true);
const MARKET_SCAN_LIVE_TAG_SLUGS = ["sports", "esports"];
const MARKET_SCAN_LIVE_WINDOW_HOURS = Math.max(1, envNumber("PAPER_MARKET_SCAN_LIVE_WINDOW_HOURS", 12));
// A market whose end date has just passed can still be trading and is exactly the kind
// the rotation rules care about, so the lower bound sits a little in the past.
const MARKET_SCAN_END_DATE_GRACE_HOURS = Math.max(0, envNumber("PAPER_MARKET_SCAN_END_DATE_GRACE_HOURS", 6));
const MARKET_SCAN_MAX_DAYS_RAW = envNumber("PAPER_MARKET_SCAN_MAX_DAYS", 7);
const MARKET_SCAN_MAX_DAYS = Number.isFinite(MARKET_SCAN_MAX_DAYS_RAW) && MARKET_SCAN_MAX_DAYS_RAW >= 0
  ? Math.min(3650, MARKET_SCAN_MAX_DAYS_RAW)
  : null;
const MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS = envNumber("PAPER_MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS", envNumber("PAPER_MAX_RESOLUTION_DAYS", 7));
// Keep a small operational buffer for fetching the quote and submitting an
// order. A full hour would discard exactly the short-lived opportunities the
// scanner is meant to find.
const MARKET_SCAN_MIN_RESOLUTION_MINUTES = envNumber(
  "PAPER_MARKET_SCAN_MIN_RESOLUTION_MINUTES",
  0,
);
const MARKET_SCAN_MIN_RESOLUTION_HOURS = MARKET_SCAN_MIN_RESOLUTION_MINUTES / 60;
// A market expiring in a few minutes is real, but multiplying that outcome by
// hundreds of hypothetical intraday repeats makes p.a. unusable for ranking.
// One hour, not one day. The strategy deliberately targets markets resolving the
// same day or already running, so a one-day floor made every one of them report an
// identical potential p.a. and the ranking could not tell a live event from one
// twelve hours out. Annualizing to the hour keeps that ordering precise instead of
// idling capital for a day. Sub-hour horizons still share the floor, which is what
// stops a 0.0 day denominator from running away.
const ONE_HOUR_IN_DAYS = 1 / 24;
const MIN_ANNUALIZATION_DAYS = Math.max(ONE_HOUR_IN_DAYS, envNumber("PAPER_MIN_ANNUALIZATION_DAYS", ONE_HOUR_IN_DAYS));
const MARKET_SCAN_TAG = String(process.env.PAPER_MARKET_SCAN_TAG || "").trim().toLowerCase();
// These are Polymarket's broad navigation tags plus active geopolitical
// subcategories. Every scheduled catalogue scan walks every page of every
// listed scope. The untagged request covers general/unclassified events.
const MARKET_SCAN_CATEGORY_TAGS = [
  { id: "1", slug: "sports" },
  { id: "2", slug: "politics" },
  { id: "21", slug: "crypto" },
  { id: "120", slug: "finance" },
  { id: "107", slug: "business" },
  { id: "22", slug: "technology" },
  { id: "74", slug: "science" },
  { id: "64", slug: "esports" },
  { id: "3", slug: "video-games" },
  { id: "100", slug: "music" },
  { id: "53", slug: "movies" },
  { id: "84", slug: "weather" },
  { id: "38", slug: "news" },
  { id: "93", slug: "prediction-markets" },
  { id: "78", slug: "iran" },
  { id: "1396", slug: "international-affairs" },
  { id: "100265", slug: "geopolitics" },
  { id: "96", slug: "ukraine" },
  { id: "102486", slug: "ukraine-map" },
  { id: "154", slug: "middle-east" },
  { id: "61", slug: "gaza" },
  { id: "180", slug: "israel" },
  { id: "303", slug: "china" },
];
// The portfolios run on Polymarket's own quoted probability; no external model is
// consulted. This is the single switch that keeps it that way, and it is off unless
// explicitly turned on: it forces every probability source to polymarket, stops any
// request being sent to a model provider, and drops the requirement for a stored memo --
// so a candidate can never sit unexecutable "awaiting grounded AI analysis" again.
const AI_ANALYSIS_ENABLED = envBool("PAPER_AI_ANALYSIS_ENABLED", false);
const GEMINI_API_KEY = AI_ANALYSIS_ENABLED ? (process.env.GEMINI_API_KEY || "") : "";
// Gemini 3.5 Flash is the stable API model. Keeping the model name in one
// constant also lets a stale quota backoff be scoped correctly.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_SEARCH_GROUNDING = String(process.env.GEMINI_SEARCH_GROUNDING ?? "true").toLowerCase() !== "false";
const REQUIRE_GEMINI = AI_ANALYSIS_ENABLED && envBool("PAPER_REQUIRE_GEMINI", false);
const OPENAI_API_KEY = AI_ANALYSIS_ENABLED ? (process.env.OPENAI_API_KEY || "") : "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const PRIMARY_AI_PROVIDER = (process.env.PAPER_PRIMARY_AI_PROVIDER || "gemini").toLowerCase();
const AI_ANALYSIS_LIMIT = AI_ANALYSIS_ENABLED ? envNumber("PAPER_AI_ANALYSIS_LIMIT", 2) : 0;
const AI_REQUEST_DELAY_MS = envNumber("PAPER_AI_REQUEST_DELAY_MS", 7000);
const AI_MIN_INTERVAL_SECONDS = envNumber("PAPER_AI_MIN_INTERVAL_SECONDS", 7);
const AI_MAX_REQUESTS_PER_MINUTE = envNumber("PAPER_AI_MAX_REQUESTS_PER_MINUTE", 10);
const AI_MAX_INPUT_TOKENS_PER_MINUTE = envNumber("PAPER_AI_MAX_INPUT_TOKENS_PER_MINUTE", 250000);
const AI_MAX_REQUESTS_PER_HOUR = envNumber("PAPER_AI_MAX_REQUESTS_PER_HOUR", 600);
const AI_MAX_REQUESTS_PER_DAY = envNumber("PAPER_AI_MAX_REQUESTS_PER_DAY", 1500);
const AI_EXECUTION_RESERVE_REQUESTS = envNumber("PAPER_AI_EXECUTION_RESERVE_REQUESTS", 100);
const AI_USAGE_HISTORY_LIMIT = envNumber("PAPER_AI_USAGE_HISTORY_LIMIT", 500);
const AI_POSTMORTEM_LIMIT = envNumber("PAPER_AI_POSTMORTEM_LIMIT", 8);
const AI_STOP_ON_QUOTA_ERROR = String(process.env.PAPER_AI_STOP_ON_QUOTA_ERROR ?? "true").toLowerCase() !== "false";
const AI_CRITIC_ENABLED = envBool("PAPER_AI_CRITIC_ENABLED", false);
const GROUNDED_AI_ANALYSIS_VERSION = "grounded-public-memo-v1";
const DEFAULT_MAX_RESOLUTION_DAYS = envNumber("PAPER_MAX_RESOLUTION_DAYS", envNumber("PAPER_SHORT_HORIZON_DAYS", 7));
const MORE_PROBABLE_MIN_LIQUIDITY_USDC = envNumber("PAPER_MORE_PROBABLE_MIN_LIQUIDITY_USDC", 500000);
const ROTATION_MIN_SCORE_IMPROVEMENT = envNumber("PAPER_ROTATION_MIN_SCORE_IMPROVEMENT", 0.15);
const ROTATION_MIN_EV_USDC_IMPROVEMENT = envNumber("PAPER_ROTATION_MIN_EV_USDC_IMPROVEMENT", 0.02);
const ROTATION_MIN_HOLD_HOURS = envNumber("PAPER_ROTATION_MIN_HOLD_HOURS", 6);
const REFRESH_ONLY = String(process.env.PAPER_REFRESH_ONLY || "").toLowerCase() === "true";
const REFRESH_TOKEN_ID = String(process.env.PAPER_REFRESH_TOKEN_ID || "").trim();
const REFRESH_MARKET_SLUG = String(process.env.PAPER_REFRESH_MARKET_SLUG || "").trim();
const REPORT_ONLY = String(process.env.PAPER_REPORT_ONLY || "").toLowerCase() === "true";
const SCAN_ONLY = envBool("PAPER_SCAN_ONLY", false);
const EXECUTION_ONLY = envBool("PAPER_EXECUTION_ONLY", false);
const COMPACT_ONLY = envBool("PAPER_COMPACT_ONLY", false);
// GitHub Actions drops most scheduled ticks under load, so binding a mode to one
// cron expression starves whatever that expression owns. Portfolio execution used
// to run only on the hourly `7 * * * *` tick, which is a single tick out of eight
// per hour; the surviving `*/10` scans kept refreshing the catalogue while the
// portfolios stood still. Scheduled runs now resolve their own mode from the
// cadence stored in state, so whichever tick arrives performs the overdue work.
// Restoring production from the repository snapshot is an explicit, deliberate act.
// Left off, a missing hosted state fails the run instead of silently republishing
// a historical seed over the live portfolios.
const ALLOW_SEED_BOOTSTRAP = envBool("PAPER_ALLOW_SEED_BOOTSTRAP", false);
const SCHEDULED_CADENCE = envBool("PAPER_SCHEDULED_CADENCE", false);
const FULL_CADENCE_MINUTES = envNumber("PAPER_FULL_CADENCE_MINUTES", 55);
// How soon after the last full pass a portfolio holding deployable capital may force the
// next one. Scheduled ticks arrive every ten minutes, so this brings execution forward to
// the next tick while still preventing every tick from becoming a full pass.
const IDLE_CAPITAL_FULL_PASS_MIN_MINUTES = Math.max(
  0,
  envNumber("PAPER_IDLE_CAPITAL_FULL_PASS_MIN_MINUTES", 10),
);
const REPORT_CADENCE_MINUTES = envNumber("PAPER_REPORT_CADENCE_MINUTES", 55);
// Effective modes. A scheduled run overrides these from the stored cadence; a
// manual dispatch keeps exactly the mode it asked for.
let scanOnly = SCAN_ONLY;
let reportOnly = REPORT_ONLY;
const MANUAL_RUN_ONCE = envBool("PAPER_MANUAL_RUN_ONCE", false);
// A pass whose whole job is to place an order from candidates that were already found:
// the after-scrape execution the scan dispatches, and the run behind the dashboard's
// "run this portfolio" button. Both end in executeManualPaperRunFromStoredCandidates.
//
// It is named because the housekeeping around it is what made a single order take minutes.
// Syncing the resolution status of 120 stored evaluations and 300 stored observations,
// rescraping the market catalogue and re-reviewing closed trades with Gemini are all
// maintenance of the record, not inputs to the decision -- the decision reads the stored
// catalogue and then revalidates its own shortlist against live quotes before ordering.
// The scheduled full pass does that maintenance; an execution pass does not need to
// repeat it, and doing so put minutes between choosing a candidate and buying it.
//
// Everything the decision actually depends on still runs: open positions are marked to
// market, capital and equity are recalculated, and every shortlisted candidate is
// requoted immediately before the order.
const EXECUTION_PASS = EXECUTION_ONLY || MANUAL_RUN_ONCE;
const EVALUATION_ONLY = envBool("PAPER_EVALUATION_ONLY", false);
const EVALUATION_TOKEN_ID = String(process.env.PAPER_EVALUATION_TOKEN_ID || "").trim();
const EVALUATION_MARKET_SLUG = String(process.env.PAPER_EVALUATION_MARKET_SLUG || "").trim();
const EXECUTION_TRIGGER = String(process.env.PAPER_EXECUTION_TRIGGER || "manual").trim().toLowerCase();
const CONTINUOUS_EVALUATION = envBool("PAPER_CONTINUOUS_EVALUATION", false);
const EVALUATION_RESOLUTION_SYNC_LIMIT = envNumber("PAPER_EVALUATION_RESOLUTION_SYNC_LIMIT", 120);
const SCRAPED_SIMULATION_RESOLUTION_SYNC_LIMIT = envNumber("PAPER_SCRAPED_SIMULATION_RESOLUTION_SYNC_LIMIT", 300);
const SCRAPED_SIMULATION_STAKE_USDC = envNumber("PAPER_SCRAPED_SIMULATION_STAKE_USDC", 5);
// Validated by shape rather than against a fixed list: the user can create portfolios,
// so the set of valid ids is not known when this file is written. Every use site looks
// the id up in PAPER_STRATEGIES, which is what rejects one that does not exist.
const PAPER_STRATEGY_ID = /^[a-z][a-zA-Z0-9]{1,30}$/.test(String(process.env.PAPER_STRATEGY_ID || ""))
  ? process.env.PAPER_STRATEGY_ID
  : "";
const PAPER_RESET_PORTFOLIO = envBool("PAPER_RESET_PORTFOLIO", false);
// One-off undo for a reset dispatched by mistake. No UI surfaces this; it exists so a
// wrong reset can be reversed the same way it was made, by workflow dispatch.
const PAPER_RESTORE_PORTFOLIO = envBool("PAPER_RESTORE_PORTFOLIO", false);
// One-off capital rebase: a portfolio's true equity stays exactly what its trades
// compute, but its displayed baseline gets a manual top-up. No UI surfaces this either.
const PAPER_ADJUST_CAPITAL = envBool("PAPER_ADJUST_CAPITAL", false);
const PAPER_TARGET_EQUITY_USDC = envNumber("PAPER_TARGET_EQUITY_USDC", 100);
// One-off backfill for a rebase that happened before capitalAdjustmentAt existed to
// record it: stamps only the moment the "since rebase" stats should start counting from,
// never the adjustment amount itself or a trade. No UI surfaces this either.
const PAPER_SET_CAPITAL_ADJUSTMENT_AT = envBool("PAPER_SET_CAPITAL_ADJUSTMENT_AT", false);
const PAPER_CAPITAL_ADJUSTMENT_AT_ISO = String(process.env.PAPER_CAPITAL_ADJUSTMENT_AT_ISO || "").trim();
const TZ = "Europe/Prague";
// Legacy STOP_BREACH rows remain refreshable so the next pass can close them at
// the actually executable bid. The old behaviour kept them open after a gap and
// allowed a small intended loss to grow into almost the whole stake.
const OPEN_STATUSES = new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND", "STOP_BREACH", "LIMIT_ORDER_WAITING"]);
// Keep the original broad thresholds and add the intermediate 5-point steps so
// the parameter report can distinguish, for example, a 75% rule from 70%/80%.
const REPORT_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
// Every selected outcome is normalized to at least 50% before it reaches the
// report, so 0-40% would only duplicate the corresponding inverted outcomes.
const TAG_PERFORMANCE_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];
const SCRAPED_SIMULATION_MAX_DAYS = [1, 3, 7, 14, 30];
// Each scraped market contributes to every real Polymarket category and tag it
// carries. The two taxonomies stay separate; risk groups and inferred question tags
// are execution metadata, not Polymarket categories. Both bounds keep the calculation
// report proportionate because it is stored in the core state file.
const SCRAPED_SIMULATION_TAGS_PER_TRADE = Math.max(1, envNumber("PAPER_SCRAPED_SIMULATION_TAGS_PER_TRADE", 8));
const SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT = Math.max(
  20,
  envNumber("PAPER_SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT", 300),
);
const PAPER_STRATEGIES = {
  conservative: {
    id: "conservative",
    label: envText("PAPER_CONSERVATIVE_DISPLAY_NAME", "Conservative"),
    selectionMetric: "EV p.a.",
    minProbability: CONSERVATIVE_MIN_PROBABILITY,
    stakeUsdc: Math.max(0.01, envNumber("PAPER_CONSERVATIVE_STAKE_USDC", STAKE_USDC)),
    maxFraction: envNumber("PAPER_CONSERVATIVE_MAX_FRACTION", MAX_FRACTION),
    maxResolutionDays: envNumber("PAPER_CONSERVATIVE_MAX_RESOLUTION_DAYS", DEFAULT_MAX_RESOLUTION_DAYS),
    minLiquidityUsdc: envNumber("PAPER_CONSERVATIVE_MIN_LIQUIDITY_USDC", null),
    minNetYield: envNumber("PAPER_CONSERVATIVE_MIN_NET_YIELD", 0),
    executionTrigger: normalizeExecutionTrigger(process.env.PAPER_CONSERVATIVE_EXECUTION_TRIGGER),
    executionCronMinutes: Math.max(30, envNumber("PAPER_CONSERVATIVE_EXECUTION_CRON_MINUTES", 60) || 60),
    automationEnabled: envBool("PAPER_CONSERVATIVE_AUTOMATION_ENABLED", true),
    archived: envBool("PAPER_CONSERVATIVE_ARCHIVED", false),
    allowRotation: envBool("PAPER_CONSERVATIVE_AUTO_ROTATE", true),
    // The mechanism Equal is named for, now a parameter every paper portfolio can
    // turn on. Default preserves each portfolio's established behavior.
    equalRiskMultiplier: envStopLossRiskMultiplier("PAPER_CONSERVATIVE", 0),
    equalRiskProtection: envStopLossRiskMultiplier("PAPER_CONSERVATIVE", 0) > 0,
    // A resting limit buy at the current best bid instead of a market buy at the
    // ask. Default off, unchanged behavior absent a saved value.
    useLimitOrders: envBool("PAPER_CONSERVATIVE_USE_LIMIT_ORDERS", false),
    marketType: envPortfolioMarketType("PAPER_CONSERVATIVE_MARKET_TYPE", "PAPER_CONSERVATIVE_REQUIRE_MOST_PROBABLE", "all"),
    requireMostProbableOutcome: envPortfolioMarketType("PAPER_CONSERVATIVE_MARKET_TYPE", "PAPER_CONSERVATIVE_REQUIRE_MOST_PROBABLE", "all") === "multi",
    probabilitySource: envProbabilitySource("PAPER_CONSERVATIVE_PROBABILITY_SOURCE"),
    excludedCandidateTokenIds: envTokenIdSet("PAPER_CONSERVATIVE_EXCLUDED_CANDIDATE_TOKEN_IDS"),
    includeOnlyMarketTags: envTagSet("PAPER_CONSERVATIVE_INCLUDE_ONLY_MARKET_TAGS"),
    excludedMarketTags: envTagSet("PAPER_CONSERVATIVE_EXCLUDED_MARKET_TAGS"),
    selectionOrder: envSelectionOrder("PAPER_CONSERVATIVE_SELECTION_ORDER", "highest_ev_pa_first"),
    description: `Requires the configured probability source to meet ${(CONSERVATIVE_MIN_PROBABILITY * 100).toFixed(0)}% and resolution within ${DEFAULT_MAX_RESOLUTION_DAYS} days, then selects the highest EV p.a.`,
  },
  highReward: {
    id: "highReward",
    label: envText("PAPER_HIGH_REWARD_DISPLAY_NAME", "High reward"),
    selectionMetric: "Reward / risk",
    minProbability: HIGH_REWARD_MIN_PROBABILITY,
    stakeUsdc: Math.max(0.01, envNumber("PAPER_HIGH_REWARD_STAKE_USDC", STAKE_USDC)),
    maxFraction: envNumber("PAPER_HIGH_REWARD_MAX_FRACTION", MAX_FRACTION),
    maxResolutionDays: envNumber("PAPER_HIGH_REWARD_MAX_RESOLUTION_DAYS", DEFAULT_MAX_RESOLUTION_DAYS),
    minLiquidityUsdc: envNumber("PAPER_HIGH_REWARD_MIN_LIQUIDITY_USDC", null),
    minNetYield: envNumber("PAPER_HIGH_REWARD_MIN_NET_YIELD", 0),
    executionTrigger: normalizeExecutionTrigger(process.env.PAPER_HIGH_REWARD_EXECUTION_TRIGGER),
    executionCronMinutes: Math.max(30, envNumber("PAPER_HIGH_REWARD_EXECUTION_CRON_MINUTES", 60) || 60),
    automationEnabled: envBool("PAPER_HIGH_REWARD_AUTOMATION_ENABLED", true),
    archived: envBool("PAPER_HIGH_REWARD_ARCHIVED", false),
    allowRotation: envBool("PAPER_HIGH_REWARD_AUTO_ROTATE", true),
    // The mechanism Equal is named for, now a parameter every paper portfolio can
    // turn on. Default preserves each portfolio's established behavior.
    equalRiskMultiplier: envStopLossRiskMultiplier("PAPER_HIGH_REWARD", 0),
    equalRiskProtection: envStopLossRiskMultiplier("PAPER_HIGH_REWARD", 0) > 0,
    useLimitOrders: envBool("PAPER_HIGH_REWARD_USE_LIMIT_ORDERS", false),
    marketType: envPortfolioMarketType("PAPER_HIGH_REWARD_MARKET_TYPE", "PAPER_HIGH_REWARD_REQUIRE_MOST_PROBABLE", "all"),
    requireMostProbableOutcome: envPortfolioMarketType("PAPER_HIGH_REWARD_MARKET_TYPE", "PAPER_HIGH_REWARD_REQUIRE_MOST_PROBABLE", "all") === "multi",
    probabilitySource: envProbabilitySource("PAPER_HIGH_REWARD_PROBABILITY_SOURCE"),
    excludedCandidateTokenIds: envTokenIdSet("PAPER_HIGH_REWARD_EXCLUDED_CANDIDATE_TOKEN_IDS"),
    includeOnlyMarketTags: envTagSet("PAPER_HIGH_REWARD_INCLUDE_ONLY_MARKET_TAGS"),
    excludedMarketTags: envTagSet("PAPER_HIGH_REWARD_EXCLUDED_MARKET_TAGS"),
    selectionOrder: envSelectionOrder("PAPER_HIGH_REWARD_SELECTION_ORDER", "highest_reward_risk_first"),
    description: `Requires the configured probability source to meet ${(HIGH_REWARD_MIN_PROBABILITY * 100).toFixed(0)}% and resolution within ${DEFAULT_MAX_RESOLUTION_DAYS} days, then prioritizes eligible opportunities by highest reward against risk.`,
  },
  moreProbable: {
    id: "moreProbable",
    label: envText("PAPER_MORE_PROBABLE_DISPLAY_NAME", "More probable"),
    selectionMetric: "Reward / risk",
    minProbability: MORE_PROBABLE_STRATEGY_MIN_PROBABILITY,
    stakeUsdc: Math.max(0.01, envNumber("PAPER_MORE_PROBABLE_STAKE_USDC", STAKE_USDC)),
    maxFraction: envNumber("PAPER_MORE_PROBABLE_MAX_FRACTION", MAX_FRACTION),
    maxResolutionDays: envNumber("PAPER_MORE_PROBABLE_MAX_RESOLUTION_DAYS", DEFAULT_MAX_RESOLUTION_DAYS),
    minLiquidityUsdc: envNumber("PAPER_MORE_PROBABLE_MIN_LIQUIDITY_USDC", MORE_PROBABLE_MIN_LIQUIDITY_USDC),
    minNetYield: envNumber("PAPER_MORE_PROBABLE_MIN_NET_YIELD", 0),
    executionTrigger: normalizeExecutionTrigger(process.env.PAPER_MORE_PROBABLE_EXECUTION_TRIGGER),
    executionCronMinutes: Math.max(30, envNumber("PAPER_MORE_PROBABLE_EXECUTION_CRON_MINUTES", 60) || 60),
    automationEnabled: envBool("PAPER_MORE_PROBABLE_AUTOMATION_ENABLED", true),
    archived: envBool("PAPER_MORE_PROBABLE_ARCHIVED", false),
    allowRotation: envBool("PAPER_MORE_PROBABLE_AUTO_ROTATE", true),
    // The mechanism Equal is named for, now a parameter every paper portfolio can
    // turn on. Default preserves each portfolio's established behavior.
    equalRiskMultiplier: envStopLossRiskMultiplier("PAPER_MORE_PROBABLE", 0),
    equalRiskProtection: envStopLossRiskMultiplier("PAPER_MORE_PROBABLE", 0) > 0,
    useLimitOrders: envBool("PAPER_MORE_PROBABLE_USE_LIMIT_ORDERS", false),
    marketType: envPortfolioMarketType("PAPER_MORE_PROBABLE_MARKET_TYPE", "PAPER_MORE_PROBABLE_REQUIRE_MOST_PROBABLE", "multi"),
    requireMostProbableOutcome: envPortfolioMarketType("PAPER_MORE_PROBABLE_MARKET_TYPE", "PAPER_MORE_PROBABLE_REQUIRE_MOST_PROBABLE", "multi") === "multi",
    probabilitySource: envProbabilitySource("PAPER_MORE_PROBABLE_PROBABILITY_SOURCE"),
    excludedCandidateTokenIds: envTokenIdSet("PAPER_MORE_PROBABLE_EXCLUDED_CANDIDATE_TOKEN_IDS"),
    includeOnlyMarketTags: envTagSet("PAPER_MORE_PROBABLE_INCLUDE_ONLY_MARKET_TAGS"),
    excludedMarketTags: envTagSet("PAPER_MORE_PROBABLE_EXCLUDED_MARKET_TAGS"),
    selectionOrder: envSelectionOrder("PAPER_MORE_PROBABLE_SELECTION_ORDER", "highest_reward_risk_first"),
    description: `Requires the configured probability source to meet ${(MORE_PROBABLE_STRATEGY_MIN_PROBABILITY * 100).toFixed(0)}%, resolution within ${DEFAULT_MAX_RESOLUTION_DAYS} days, and deep liquidity.`,
  },
  equal: {
    id: "equal",
    label: envText("PAPER_EQUAL_DISPLAY_NAME", "Equal"),
    selectionMetric: "Potential p.a.",
    minProbability: envNumber("PAPER_EQUAL_MIN_PROBABILITY", 0.75),
    stakeUsdc: Math.max(0.01, envNumber("PAPER_EQUAL_STAKE_USDC", STAKE_USDC)),
    maxFraction: envNumber("PAPER_EQUAL_MAX_FRACTION", MAX_FRACTION),
    maxResolutionDays: envNumber("PAPER_EQUAL_MAX_RESOLUTION_DAYS", DEFAULT_MAX_RESOLUTION_DAYS),
    // This is traded volume, despite the legacy internal property name. Equal
    // depends on a usable secondary market for its synthetic protective exit.
    minLiquidityUsdc: envNumber("PAPER_EQUAL_MIN_LIQUIDITY_USDC", 20000),
    minNetYield: envNumber("PAPER_EQUAL_MIN_NET_YIELD", 0),
    // The default checks the synthetic stop after each completed market scan. The
    // portfolio setting may deliberately choose a concrete scheduled cadence instead.
    executionTrigger: normalizeExecutionTrigger(process.env.PAPER_EQUAL_EXECUTION_TRIGGER || "after_scrape"),
    executionCronMinutes: Math.max(30, envNumber("PAPER_EQUAL_EXECUTION_CRON_MINUTES", 60) || 60),
    automationEnabled: envBool("PAPER_EQUAL_AUTOMATION_ENABLED", true),
    archived: envBool("PAPER_EQUAL_ARCHIVED", false),
    allowRotation: envBool("PAPER_EQUAL_AUTO_ROTATE", false),
    // The mechanism Equal is named for, now a parameter every paper portfolio can
    // turn on. Default preserves each portfolio's established behavior.
    equalRiskMultiplier: envStopLossRiskMultiplier("PAPER_EQUAL", 1.5),
    equalRiskProtection: envStopLossRiskMultiplier("PAPER_EQUAL", 1.5) > 0,
    useLimitOrders: envBool("PAPER_EQUAL_USE_LIMIT_ORDERS", false),
    marketType: envPortfolioMarketType("PAPER_EQUAL_MARKET_TYPE", "PAPER_EQUAL_REQUIRE_MOST_PROBABLE", "all"),
    requireMostProbableOutcome: envPortfolioMarketType("PAPER_EQUAL_MARKET_TYPE", "PAPER_EQUAL_REQUIRE_MOST_PROBABLE", "all") === "multi",
    probabilitySource: envProbabilitySource("PAPER_EQUAL_PROBABILITY_SOURCE"),
    excludedCandidateTokenIds: envTokenIdSet("PAPER_EQUAL_EXCLUDED_CANDIDATE_TOKEN_IDS"),
    includeOnlyMarketTags: envTagSet("PAPER_EQUAL_INCLUDE_ONLY_MARKET_TAGS"),
    excludedMarketTags: envTagSet("PAPER_EQUAL_EXCLUDED_MARKET_TAGS"),
    selectionOrder: envSelectionOrder("PAPER_EQUAL_SELECTION_ORDER", "highest_ev_pa_first"),
    // Paper-only proof of concept. Polymarket's current API offers no conditional
    // stop order, so this portfolio records a synthetic exit from a refreshed book.
    description: "Paper-only equal-risk strategy: planned maximum loss is configurable against the net potential win. A synthetic protective exit follows the selected execution trigger.",
  },
};

// Portfolios the user created in the browser. They arrive as one JSON variable rather
// than as a per-portfolio set of environment names, because their ids are not known when
// the workflow is written -- which is exactly what stopped them from existing before.
function customPaperStrategies(raw = process.env.PAPER_CUSTOM_PORTFOLIOS) {
  const text = String(raw || "").trim();
  if (!text) return {};
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A malformed variable must not take the shipped portfolios down with it.
    console.warn("PAPER_CUSTOM_PORTFOLIOS is not valid JSON; no created portfolios are loaded.");
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const strategies = {};
  for (const [id, row] of Object.entries(parsed)) {
    // The same shape the API enforces. A created portfolio must never be able to
    // introduce a strategy id that cannot be a state key or a workflow input.
    if (!/^[a-z][a-zA-Z0-9]{1,30}$/.test(id) || PAPER_STRATEGIES[id] || !row || typeof row !== "object") continue;
    const marketType = ["all", "binary", "multi"].includes(row.marketType) ? row.marketType : "all";
    strategies[id] = {
      id,
      custom: true,
      label: String(row.displayName || id).slice(0, 80),
      selectionMetric: row.selectionOrder === "highest_reward_risk_first" ? "Reward / risk" : "EV p.a.",
      minProbability: Number.isFinite(Number(row.minProbability)) ? Number(row.minProbability) : 0.5,
      stakeUsdc: Number.isFinite(Number(row.stakeUsdc)) && Number(row.stakeUsdc) > 0
        ? Number(row.stakeUsdc)
        : (Number.isFinite(Number(row.maxOrderFraction)) && Number(row.maxOrderFraction) > 0
          ? Math.max(0.01, Number(row.maxOrderFraction) * PORTFOLIO_USDC)
          : STAKE_USDC),
      maxFraction: Number.isFinite(Number(row.maxOrderFraction)) ? Number(row.maxOrderFraction) : MAX_FRACTION,
      maxResolutionDays: Number.isFinite(Number(row.maxResolutionDays))
        ? Number(row.maxResolutionDays)
        : DEFAULT_MAX_RESOLUTION_DAYS,
      minLiquidityUsdc: Number.isFinite(Number(row.minLiquidityUsdc)) ? Number(row.minLiquidityUsdc) : null,
      minNetYield: Number.isFinite(Number(row.minNetYield)) ? Number(row.minNetYield) : 0,
      executionTrigger: normalizeExecutionTrigger(row.executionTrigger),
      executionCronMinutes: Math.max(30, Number(row.executionCronMinutes) || 60),
      // Absent means on, matching shipped paper portfolios and the API normalizer. A
      // created portfolio that was saved before this field existed must not silently
      // stop trading just because its config JSON lacks the key.
      automationEnabled: row.automationEnabled !== false,
      allowRotation: row.autoRotatePositions === true,
      equalRiskMultiplier: rowStopLossRiskMultiplier(row, 0),
      equalRiskProtection: rowStopLossRiskMultiplier(row, 0) > 0,
      useLimitOrders: row.useLimitOrders === true,
      archived: row.archived === true,
      marketType,
      requireMostProbableOutcome: marketType === "multi",
      probabilitySource: row.probabilitySource === "ai" ? "ai" : "polymarket",
      excludedCandidateTokenIds: new Set((Array.isArray(row.excludedCandidateTokenIds) ? row.excludedCandidateTokenIds : [])
        .map((token) => String(token)).filter((token) => /^\d+$/.test(token))),
      includeOnlyMarketTags: new Set((Array.isArray(row.includeOnlyMarketTags) ? row.includeOnlyMarketTags : [])
        .map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)),
      excludedMarketTags: new Set((Array.isArray(row.excludedMarketTags) ? row.excludedMarketTags : [])
        .map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)),
      selectionOrder: row.selectionOrder === "highest_reward_risk_first"
        ? "highest_reward_risk_first"
        : "highest_ev_pa_first",
      description: `Created paper portfolio: ${String(row.displayName || id).slice(0, 80)}.`,
    };
  }
  return strategies;
}

Object.assign(PAPER_STRATEGIES, customPaperStrategies());
// Archiving is stronger than switching automation off: the portfolio leaves the
// dashboard and stops being run at all, while every row it traded is kept.
const ARCHIVED_PAPER_STRATEGY_IDS = new Set(
  Object.values(PAPER_STRATEGIES).filter((strategy) => strategy.archived === true).map((strategy) => strategy.id),
);

function paperStrategyIsArchived(strategy) {
  return Boolean(strategy) && ARCHIVED_PAPER_STRATEGY_IDS.has(strategy.id);
}

function executionStrategies() {
  if (MANUAL_RUN_ONCE && PAPER_STRATEGY_ID && PAPER_STRATEGIES[PAPER_STRATEGY_ID]) {
    // A manual run reaches a portfolio whose automation is off, but not one that has
    // been archived: archiving is the statement that it is finished.
    return paperStrategyIsArchived(PAPER_STRATEGIES[PAPER_STRATEGY_ID]) ? [] : [PAPER_STRATEGIES[PAPER_STRATEGY_ID]];
  }
  return Object.values(PAPER_STRATEGIES).filter((strategy) => !paperStrategyIsArchived(strategy));
}

// A manual run always overrides the portfolio's own automation settings: switching
// automatic execution off must not also take away the ability to run it by hand.
// The flag is a parameter rather than a module read so the rule can be exercised for
// both answers, not just whichever one the test process happens to import with.
function strategyMatchesExecutionTrigger(strategy, { manual = MANUAL_RUN_ONCE || EVALUATION_ONLY } = {}) {
  if (manual) return true;
  // Absent means on: a portfolio saved before this switch existed must keep trading
  // rather than silently stop because a field it never had reads as false.
  if (strategy?.automationEnabled === false) return false;
  // An after-scrape pass runs every portfolio whose cadence is due, not only the ones
  // whose trigger is literally "after_scrape".
  //
  // Reported: portfolios created in the browser never ran. Both were saved with the
  // "cron" trigger, and this returned false for them on every after-scrape pass -- which
  // is nearly every execution pass there is. A scheduled tick normally resolves to a
  // catalogue scan and then chains an after_scan run to do the trading, so the only
  // passes that carried EXECUTION_TRIGGER=cron were the occasional scheduled full ones.
  // A created portfolio was left with no run log, no positions and equity still at its
  // opening balance, while the four shipped portfolios (all "after_scrape") traded on.
  //
  // "cron" is a statement about how often to check, not about which pass may check. The
  // interval is enforced by strategyCadenceIsDue, which every caller here applies right
  // after this, so letting a cron portfolio through an after-scrape pass cannot make it
  // trade more often than its own executionCronMinutes allows.
  if (EXECUTION_TRIGGER === "after_scrape") return true;
  // The reverse stays exclusive: "after_scrape" means "only on freshly scanned data",
  // so those portfolios are still not run by a plain cron pass.
  if (EXECUTION_TRIGGER === "cron") return strategy.executionTrigger !== "after_scrape";
  return true;
}

// A cron-triggered portfolio always has an explicit cadence. After-scrape
// portfolios intentionally run after every completed scrape instead.
function strategyCadenceIsDue(strategy, lastRunAt, now = Date.now(), { manual = MANUAL_RUN_ONCE || EVALUATION_ONLY } = {}) {
  if (manual) return true;
  if (normalizeExecutionTrigger(strategy?.executionTrigger) === "after_scrape") return true;
  const minutes = Math.max(30, Number(strategy?.executionCronMinutes) || 60);
  const previous = Date.parse(lastRunAt || "");
  // No previous run is not a reason to wait.
  if (!Number.isFinite(previous)) return true;
  return (now - previous) / 60000 >= minutes;
}

const LEDGER_RECOVERY_ANCHORS = [
  {
    reason: "Recovered after static deploy overwrote bot-generated paper-state.json",
    id: "paper-2026-07-17-77899117691320282255084926855068126399522814425967645821251701722727475314950",
    sourceEvaluationId: "2941983-1-1784239888264",
    openedAt: "2026-07-16T22:11:30.509Z",
    date: "2026-07-17",
    tokenId: "77899117691320282255084926855068126399522814425967645821251701722727475314950",
    question: "Exact Score: France 0 - 0 England?",
    slug: "fifwc-fra-eng-2026-07-18-exact-score-0-0",
    eventSlug: "fifwc-fra-eng-2026-07-18-exact-score",
    outcome: "No",
    entryPrice: 0.964,
    shares: 5.1867,
    takerFeeUsdc: 0.009,
    totalCostUsdc: 5.009,
    netGainIfWinUsdc: 0.1777,
    maxLossUsdc: 5.009,
  },
  {
    reason: "Recovered after static deploy overwrote bot-generated paper-state.json",
    id: "paper-2026-07-18-46234664383113214034787313853742859435218314985155582830237659971348787896010",
    sourceEvaluationId: "2507607-1-1784325742533",
    openedAt: "2026-07-17T22:02:25.422Z",
    date: "2026-07-18",
    tokenId: "46234664383113214034787313853742859435218314985155582830237659971348787896010",
    question: "Kharg Island no longer under Iranian control by July 31?",
    slug: "kharg-island-no-longer-under-iranian-control-by-july-31",
    eventSlug: "kharg-island-no-longer-under-iranian-control-by-march-31",
    outcome: "No",
    entryPrice: 0.973,
    shares: 5.1387,
    takerFeeUsdc: 0,
    totalCostUsdc: 5,
    netGainIfWinUsdc: 0.1387,
    maxLossUsdc: 5,
  },
];

function pctText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : "-";
}

function pointText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${(numeric * 100).toFixed(1)} pts`;
}

function compactSentence(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildMarketComparisonSummary({ probability, marketProbability, rationale }) {
  const ai = Number(probability);
  const market = Number(marketProbability);
  const reason = compactSentence(rationale);
  if (!Number.isFinite(ai) || !Number.isFinite(market)) {
    return reason || "No Polymarket entry price was available for a percentage-point comparison.";
  }
  const difference = ai - market;
  const direction = difference >= 0 ? "above" : "below";
  const reasonText = reason ? ` because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : ".";
  return `AI probability ${pctText(ai)} is ${(Math.abs(difference) * 100).toFixed(1)} pts ${direction} the Polymarket entry ${pctText(market)}${reasonText}`;
}

function nowIso() {
  return new Date().toISOString();
}

function pragueDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function pragueHourKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// How many of a batch of independent HTTP requests may be in flight at once.
//
// Every network loop in this file used to be `for (const x of xs) await f(x)`, which
// spends its whole life waiting: one round trip to Polymarket is ~0.3s of latency and
// ~0 of work, and a single pass makes hundreds of them. Refreshing stored resolution
// statuses alone is up to 420 slug lookups, each of which is up to two requests. At one
// at a time that is minutes of pure waiting, and it was the bulk of a run's duration.
//
// A modest cap rather than none: the point is to stop idling, not to flood a public API
// that would start rate-limiting and make the run slower and less reliable than before.
const REQUEST_CONCURRENCY = Math.max(1, envNumber("PAPER_REQUEST_CONCURRENCY", 8));

// Runs `worker` over `items` with at most `limit` in flight, and returns the results in
// the order of `items` -- never completion order. Callers depend on that: several of them
// zip the results back against the input array by index, and one builds the list every
// later stage ranks. Overlapping the waiting must not reorder anything.
async function mapWithConcurrency(items, worker, limit = REQUEST_CONCURRENCY) {
  const list = Array.isArray(items) ? items : [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  let next = 0;
  const runner = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: width }, runner));
  return results;
}

// Where a pass actually spent its time, printed once when it ends.
//
// "Run paper bot" is a single workflow step, so an 8-minute execution reported exactly one
// number and every account of which part cost what was a guess. The budget for an
// execution pass is a minute; a run that misses it should say which phase took it.
const phaseDurationsMs = {};

function recordPhase(name, startedAt) {
  const elapsed = performance.now() - startedAt;
  phaseDurationsMs[name] = Number(((phaseDurationsMs[name] || 0) + elapsed).toFixed(1));
}

async function timed(name, work) {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    recordPhase(name, startedAt);
  }
}

// For phases that are pure computation. Deliberately not the async version: wrapping
// synchronous work in a promise would introduce an await point where the code has none,
// and the point of this helper is to measure the pass, not to change its shape.
function timedSync(name, work) {
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    recordPhase(name, startedAt);
  }
}

function phaseTimingSummary() {
  const entries = Object.entries(phaseDurationsMs).sort((a, b) => b[1] - a[1]);
  return {
    totalMs: Number(entries.reduce((sum, [, ms]) => sum + ms, 0).toFixed(1)),
    phasesMs: Object.fromEntries(entries),
    marketLookupsCached: marketBySlugCache.size,
    requestConcurrency: REQUEST_CONCURRENCY,
  };
}

// Carried in the state as well as printed.
//
// The printed line sits at the end of a step whose log is followed by several environment
// dumps, so reading it back after the fact means paging through thousands of lines of
// PAPER_* variables to reach it. In the state, the run digest can state it in three lines
// at the bottom of the job, which is where anyone asking "why did that take so long" looks.
//
// Stamped from inside writeState, so it covers every phase up to that write -- the one
// phase whose own duration cannot be inside the file it produces.
function recordPassTimingOnState(state) {
  if (!state || typeof state !== "object") return;
  state.lastPassTiming = {
    at: state.generatedAt || nowIso(),
    executionPass: EXECUTION_PASS,
    ...phaseTimingSummary(),
  };
}

// One market lookup per slug per process.
//
// The same slug is asked for by several phases of a single pass -- stored evaluations and
// stored observations sync resolution status, open trades are marked to market, and
// shortlisted candidates are revalidated -- and within each phase the same market can
// back more than one row. Every one of those was a fresh pair of HTTP requests to the
// same URL. Caching the promise (not the result) also collapses concurrent callers into
// one request, which matters now that the loops above run in parallel.
//
// A single pass therefore sees one consistent snapshot of any given market instead of
// several taken seconds apart, which is a property this file wants anyway: two phases
// disagreeing about the same market's price was never meaningful.
const marketBySlugCache = new Map();

function resetMarketBySlugCache() {
  marketBySlugCache.clear();
}

function parseJsonField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value !== "") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "PolymarketPaperBot/1.0" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

// The retained catalogue is two orders of magnitude larger than the numbers the
// dashboard shows. Keeping it in one file made every read decode all of it, and
// PHP answered 500 once json_decode of the whole document exceeded memory_limit
// — which took the bot's own state read down with it. The heavy collections are
// therefore published as sibling files so each reader pays only for what it
// needs: the dashboard decodes the core alone, and the scraped views decode the
// observations alone.
const STATE_SEGMENT_FIELDS = {
  observations: ["marketObservations", "marketScan"],
  evaluations: ["evaluations"],
  archives: ["paperPortfolioArchives"],
  // latestCalculationReport deliberately stays in the core. It is the one object every
  // statistics tab renders, and segmenting it emptied all of them: the dashboard summary
  // loads no segments, so the page had nothing to draw and said "No category statistics
  // are available yet" while the data sat in a file nobody fetched. The historical array
  // beside it is what actually grows, so that is what stays segmented.
  reports: ["evaluationRunLog", "calculationReports"],
  // Scan history is short but carries per-run audits, and the audit endpoints
  // read nothing else. A separate file lets them skip the market catalogue.
  scanHistory: ["marketScanHistory"],
};

// Resolved observations are history: they never change again and only the Resolved
// and All views read them. Splitting them out of the active catalogue means the two
// stop competing for one retention budget — which is why the counts in the scraped
// tabs were falling instead of accumulating — and lets the execution view skip them
// entirely. They travel under their own field name and are merged back into
// marketObservations on read, so the in-memory schema is unchanged everywhere else.
const RESOLVED_OBSERVATION_SEGMENT = "resolvedObservations";
const RESOLVED_OBSERVATION_TRANSPORT_FIELD = "resolvedMarketObservations";

// The newest slice of the archive, published beside it as its own file.
//
// The archive is kept whole and grows without limit, which is right -- it is the record
// of everything ever mined. What is not right is having to decode all of it to show the
// most recent page. Measured at the 23,561 rows production had reached, decoding it alone
// peaks at 138 MB, and the host answers 500 above 128 MB: the opportunities page and every
// trading run reading that summary failed together, with nothing between the growing
// archive and the failure. A capped file changes the cost of reading from "however much
// history exists" to a constant.
const RESOLVED_RECENT_SEGMENT = "resolvedRecent";
const RESOLVED_RECENT_LIMIT = Math.max(0, envNumber("PAPER_RESOLVED_RECENT_LIMIT", 3000));

// Every segment a reader must reassemble to rebuild the state, so it can never quietly
// skip one that a writer produces.
//
// The recent page is deliberately not here. It carries the same transport field as the
// archive, and mergeStateSegment replaces the resolved half rather than appending to it,
// so reading both would leave whichever landed last -- and if that were the page, the
// bot would write its own archive back truncated to 3,000 rows. It is published for
// readers that only display recent history; the state is rebuilt from the archive.
const STATE_SEGMENT_NAMES = [...Object.keys(STATE_SEGMENT_FIELDS), RESOLVED_OBSERVATION_SEGMENT];
const PUBLISHED_STATE_SEGMENT_NAMES = [...STATE_SEGMENT_NAMES, RESOLVED_RECENT_SEGMENT];
// Published, never merged back. Named once here so every reader -- the local one that
// walks names and the hosted one that walks the manifest -- excludes the same set.
const DERIVED_STATE_SEGMENTS = new Set([RESOLVED_RECENT_SEGMENT]);

// Segments an execution pass has no reason to touch.
//
// The resolved archive is the largest thing this bot stores by a wide margin -- around
// 143 MB against roughly 100 MB for everything else together -- and it is history: rows
// only enter it when a market settles, which is the resolution sync's job, and an
// execution pass does not run that. Nor can it read them: portfolioFilterResult rejects
// every resolved row, so executionCandidateObservations filters them out before the scan.
//
// Downloading it and uploading it back unchanged was therefore most of a run's transfer
// budget spent to reproduce a file byte for byte. A carried-over segment is not fetched,
// not rewritten, and keeps its manifest entry from the state that was read, so the hosted
// file simply stays where it is and every reader still finds it.
//
// The recent page travels with it: it is derived from the archive at write time, so
// rebuilding it without the archive in memory would publish an empty page over a full one.
const EXECUTION_PASS_CARRIED_SEGMENTS = new Set([RESOLVED_OBSERVATION_SEGMENT]);

function segmentIsCarriedOnThisPass(name) {
  if (!EXECUTION_PASS) return false;
  if (EXECUTION_PASS_CARRIED_SEGMENTS.has(name)) return true;
  return name === RESOLVED_RECENT_SEGMENT && EXECUTION_PASS_CARRIED_SEGMENTS.has(RESOLVED_OBSERVATION_SEGMENT);
}

// The manifest of the state this process read, so a pass that skipped a segment can hand
// its entry back unchanged instead of describing a file it never produced.
let previousStateSegmentManifest = null;

function rememberStateSegmentManifest(manifest) {
  previousStateSegmentManifest = manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? manifest
    : null;
}

// A carried-over entry has to be a complete description of a file that already exists, and
// it is only honest if this process really is holding nothing for that segment. Both
// conditions are checked at write time rather than assumed from the pass mode, so a state
// that somehow arrives with resolved rows in it -- a merged local snapshot, a mode
// combination added later -- publishes them normally instead of silently dropping them.
function carriedStateSegmentEntry(name) {
  if (!segmentIsCarriedOnThisPass(name)) return null;
  const entry = previousStateSegmentManifest?.[name];
  if (!entry || typeof entry !== "object") return null;
  if (!/^[A-Za-z0-9._-]+\.json$/.test(String(entry.file || ""))) return null;
  return { ...entry, carriedOver: true };
}

// Newest first, by whichever date the row actually carries.
function resolvedObservationTime(item) {
  const value = Date.parse(item?.resolvedAt || item?.endDate || item?.resolutionEndDate || "");
  return Number.isFinite(value) ? value : 0;
}

function observationIsResolved(item) {
  return String(item?.status || item?.selectionStatus || "").toUpperCase() === "RESOLVED";
}

function stateSegmentFileName(name) {
  const base = basename(OUTPUT_PATH).replace(/\.json$/i, "");
  const safeName = String(name).replace(/[^A-Za-z0-9_-]+/g, "-");
  return `${base}.${safeName}.json`;
}

function stateSegmentPath(name) {
  return join(dirname(OUTPUT_PATH), stateSegmentFileName(name));
}

function compactPaperPortfolioForCore(portfolio) {
  if (!portfolio || typeof portfolio !== "object") return portfolio;
  const compact = {};
  for (const field of [
    "id",
    "label",
    "displayName",
    "description",
    "selectionMetric",
    "selectionOrder",
    "minProbability",
    "stakeUsdc",
    "maxFraction",
    "maxResolutionDays",
    "minLiquidityUsdc",
    "minNetYield",
    "executionTrigger",
    "marketType",
    "requireMostProbableOutcome",
    "probabilitySource",
    "equalRiskMultiplier",
    "equalRiskProtection",
    "allowRotation",
    "useLimitOrders",
    "resetAt",
    "resetArchiveId",
    "capitalAdjustmentUsdc",
    "capitalAdjustmentAt",
    "capitalAdjustmentEquityUsdc",
    "capitalAdjustmentOpenPnlUsdc",
    "portfolio",
    "lastTradeDate",
    "lastTradeHour",
    "lastDecision",
    "archived",
  ]) {
    if (Object.prototype.hasOwnProperty.call(portfolio, field)) compact[field] = portfolio[field];
  }
  compact.trades = [];
  compact.runLog = [];
  return compact;
}

function portfolioSegmentName(id) {
  return `portfolio:${id}`;
}

// An absent field and an empty field are not the same thing here: a reader that
// finds `marketObservations: []` in the core file must be able to tell "this
// state has no markets" from "the markets live in a segment". The manifest is
// that signal, and it carries counts so a truncated upload is detectable.
function splitStateIntoSegments(state) {
  const core = { ...state };
  const segments = {};
  const manifest = {};
  const allObservations = Array.isArray(state.marketObservations) ? state.marketObservations : [];
  const activeObservations = allObservations.filter((item) => !observationIsResolved(item));
  const resolvedObservations = allObservations.filter(observationIsResolved);
  const paperPortfolios = state.paperPortfolios && typeof state.paperPortfolios === "object" && !Array.isArray(state.paperPortfolios)
    ? state.paperPortfolios
    : {};

  core.paperPortfolios = {};
  for (const [id, portfolio] of Object.entries(paperPortfolios)) {
    if (!portfolio || typeof portfolio !== "object") continue;
    const name = portfolioSegmentName(id);
    segments[name] = {
      strategyId: id,
      paperPortfolio: portfolio,
    };
    manifest[name] = {
      file: stateSegmentFileName(name),
      fields: ["paperPortfolio"],
      strategyId: id,
      counts: { trades: Array.isArray(portfolio.trades) ? portfolio.trades.length : 0 },
    };
    core.paperPortfolios[id] = compactPaperPortfolioForCore(portfolio);
  }

  // These are legacy aliases or rarely opened historical views. The full data remains
  // recoverable from the portfolio segments above, while the core has to stay small
  // enough for the hosting's PHP memory limit.
  core.trades = [];
  core.runLog = [];

  for (const [name, fields] of Object.entries(STATE_SEGMENT_FIELDS)) {
    const payload = {};
    const counts = {};
    for (const field of fields) {
      // The active catalogue is what the observations segment carries; the resolved
      // archive is published separately below.
      const value = field === "marketObservations" ? activeObservations : state[field];
      payload[field] = value === undefined ? null : value;
      if (Array.isArray(value)) counts[field] = value.length;
      core[field] = Array.isArray(value) ? [] : (value && typeof value === "object" ? {} : value);
    }
    segments[name] = payload;
    manifest[name] = { file: stateSegmentFileName(name), fields, counts };
  }

  // A pass that never read the archive and holds no resolved rows publishes neither the
  // archive nor the page derived from it: both entries come back from the manifest that
  // was read, pointing at the files already on the hosting. Writing them instead would
  // replace tens of thousands of settled markets with an empty array.
  //
  // The `resolvedObservations.length === 0` half of the condition is the safety catch. If
  // anything did put resolved rows into this state, they are worth more than the saved
  // transfer, so the segments are written the ordinary way.
  const carriedArchive = resolvedObservations.length === 0
    ? carriedStateSegmentEntry(RESOLVED_OBSERVATION_SEGMENT)
    : null;
  const carriedRecent = carriedArchive ? carriedStateSegmentEntry(RESOLVED_RECENT_SEGMENT) : null;
  if (carriedArchive && carriedRecent) {
    manifest[RESOLVED_OBSERVATION_SEGMENT] = carriedArchive;
    manifest[RESOLVED_RECENT_SEGMENT] = carriedRecent;
    core.stateSegments = manifest;
    return { core, segments };
  }

  segments[RESOLVED_OBSERVATION_SEGMENT] = {
    [RESOLVED_OBSERVATION_TRANSPORT_FIELD]: resolvedObservations,
  };
  manifest[RESOLVED_OBSERVATION_SEGMENT] = {
    file: stateSegmentFileName(RESOLVED_OBSERVATION_SEGMENT),
    fields: [RESOLVED_OBSERVATION_TRANSPORT_FIELD],
    counts: { [RESOLVED_OBSERVATION_TRANSPORT_FIELD]: resolvedObservations.length },
    // The tabs count observations, not transport fields, so the totals they need
    // are stated here rather than left to be recomputed from truncated rows.
    mergesInto: "marketObservations",
  };

  // The same rows, newest first and capped, so a reader that only shows the recent page
  // never has to decode the whole archive to find it. The count above stays the true one,
  // so the tab labels keep reporting everything that was mined.
  const recentResolved = [...resolvedObservations]
    .sort((a, b) => resolvedObservationTime(b) - resolvedObservationTime(a))
    .slice(0, RESOLVED_RECENT_LIMIT);
  segments[RESOLVED_RECENT_SEGMENT] = {
    [RESOLVED_OBSERVATION_TRANSPORT_FIELD]: recentResolved,
  };
  manifest[RESOLVED_RECENT_SEGMENT] = {
    file: stateSegmentFileName(RESOLVED_RECENT_SEGMENT),
    fields: [RESOLVED_OBSERVATION_TRANSPORT_FIELD],
    counts: { [RESOLVED_OBSERVATION_TRANSPORT_FIELD]: recentResolved.length },
    mergesInto: "marketObservations",
    // Stated so a reader can tell a capped page from the whole archive without
    // comparing counts against another segment's manifest entry.
    truncatedFrom: resolvedObservations.length,
  };
  core.stateSegments = manifest;
  return { core, segments };
}

function mergeStateSegment(state, segment) {
  if (!segment || typeof segment !== "object") return state;
  const merged = { ...state };
  if (segment.paperPortfolio && typeof segment.paperPortfolio === "object") {
    const id = String(segment.strategyId || segment.paperPortfolio.id || "").trim();
    if (id) {
      merged.paperPortfolios = {
        ...(merged.paperPortfolios && typeof merged.paperPortfolios === "object" ? merged.paperPortfolios : {}),
        [id]: segment.paperPortfolio,
      };
    }
  }
  for (const fields of Object.values(STATE_SEGMENT_FIELDS)) {
    for (const field of fields) {
      if (!(field in segment)) continue;
      const value = segment[field];
      if (value === null || value === undefined) continue;
      // The active catalogue and the resolved archive arrive in different files and
      // land in the same array. Each replaces only its own half, so segments can be
      // merged in any order without one discarding the other.
      if (field === "marketObservations") {
        const existing = Array.isArray(merged.marketObservations) ? merged.marketObservations : [];
        merged.marketObservations = [
          ...(Array.isArray(value) ? value : []),
          ...existing.filter(observationIsResolved),
        ];
        continue;
      }
      merged[field] = value;
    }
  }
  const resolved = segment[RESOLVED_OBSERVATION_TRANSPORT_FIELD];
  if (Array.isArray(resolved)) {
    const existing = Array.isArray(merged.marketObservations) ? merged.marketObservations : [];
    merged.marketObservations = [...existing.filter((item) => !observationIsResolved(item)), ...resolved];
  }
  return merged;
}

function stateSegmentUrls(manifest) {
  if (!manifest || typeof manifest !== "object") return [];
  const base = STATE_SEGMENT_BASE_URL;
  if (!base) return [];
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return Object.entries(manifest)
    // A derived segment is a view of another one, published for readers that show only
    // part of it. Rebuilding the state from it replaces what it was derived from: the
    // recent page carries the archive's own transport field, the merge replaces the
    // resolved half rather than appending, and the page is listed last -- so the next
    // write would put a 3,000-row page back as the whole archive. The local reader was
    // already restricted by name; this one walks the manifest, and was not.
    .filter(([name]) => !DERIVED_STATE_SEGMENTS.has(name))
    // Not fetched because this pass will hand the entry straight back; see
    // EXECUTION_PASS_CARRIED_SEGMENTS.
    .filter(([name]) => !segmentIsCarriedOnThisPass(name))
    .map(([name, entry]) => ({ name, file: String(entry?.file || "").trim() }))
    .filter(({ file }) => /^[A-Za-z0-9._-]+\.json$/.test(file))
    .map(({ name, file }) => ({ name, url: `${prefix}${file}` }));
}

// Whether a segment's contents can be regenerated if it is genuinely gone. The market
// catalogue, the stored evaluations and the scan history are all rebuilt by later scans,
// so continuing without them costs nothing that will not come back. A portfolio's trades
// and run log, the portfolio archives and the calculation reports are the opposite: they
// are the only copy, nothing regenerates them, and continuing would publish a state that
// has silently dropped them.
function stateSegmentIsRebuildable(name) {
  return Object.prototype.hasOwnProperty.call(STATE_SEGMENT_FIELDS, name)
    || name === RESOLVED_OBSERVATION_SEGMENT
    || name === RESOLVED_RECENT_SEGMENT;
}

function stateSegmentNamesFromManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return [];
  return Object.keys(manifest)
    .filter((name) => !DERIVED_STATE_SEGMENTS.has(name))
    .filter((name) => !segmentIsCarriedOnThisPass(name));
}

// A checked-out or previously written state on disk is segmented the same way,
// so local reads have to reassemble it before the shape checks run.
async function readLocalStateFile(path) {
  const raw = await readFile(path, "utf8");
  let parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !parsed.stateSegments) return parsed;
  for (const name of stateSegmentNamesFromManifest(parsed.stateSegments)) {
    try {
      parsed = mergeStateSegment(parsed, JSON.parse(await readFile(stateSegmentPath(name), "utf8")));
    } catch {
      // A missing sibling leaves the core's empty collections in place, which is
      // the correct reading of a partially written state.
    }
  }
  return parsed;
}

// Segments are fetched as static files rather than through the PHP endpoint on
// purpose: bypassing json_decode is the whole point of splitting them out.
async function readStateWithSegments(payload) {
  const manifest = payload?.stateSegments;
  // Kept so the write can reuse the entries for segments this pass skipped rather than
  // describing files it never produced.
  rememberStateSegmentManifest(manifest);
  // Only the segments this reader has to reassemble. A derived segment is published for
  // readers that display part of another one and is deliberately not fetched here, so
  // counting it as missing below would refuse to run on a perfectly complete state. Nor
  // is a carried-over one, for the same reason.
  const declared = manifest && typeof manifest === "object"
    ? stateSegmentNamesFromManifest(manifest)
    : [];
  if (declared.length === 0) return payload;

  const urls = stateSegmentUrls(manifest);
  // The core file's collections are empty by construction once segments exist.
  // Continuing without them would normalize an empty catalogue and publish it
  // over the hosting, so an unfetchable segment has to stop the run instead.
  if (urls.length !== declared.length) {
    throw new Error(
      `Published paper state declares ${declared.length} heavy segment(s) but only ${urls.length} could be addressed. `
      + "Set PAPER_STATE_SEGMENT_BASE_URL (or PAPER_STATIC_STATE_URL) to the hosted data directory; "
      + "refusing to continue with an incomplete state.",
    );
  }

  // Fetched a few at a time rather than one after another. These files total a few
  // hundred megabytes over a shared host, and downloading them strictly in sequence was
  // the single largest cost of a run -- the wait is network latency, not work, so it
  // overlaps for free. The cap keeps peak memory bounded: each batch holds only its own
  // parsed segments beyond the ones already merged.
  //
  // Merging stays strictly in manifest order regardless of which download finishes first.
  // That matters: mergeStateSegment replaces the resolved half of marketObservations and
  // appends the active half, so a different order would reassemble a different catalogue.
  const SEGMENT_FETCH_CONCURRENCY = 4;
  const fetchOne = async ({ name, url }) => {
    try {
      return { name, url, segment: await fetchJson(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`) };
    } catch (error) {
      return { name, url, error };
    }
  };

  let merged = payload;
  for (let index = 0; index < urls.length; index += SEGMENT_FETCH_CONCURRENCY) {
    const batch = await Promise.all(urls.slice(index, index + SEGMENT_FETCH_CONCURRENCY).map(fetchOne));
    for (const { name, url, segment, error } of batch) {
      if (!error) {
        merged = mergeStateSegment(merged, segment);
        continue;
      }
      const message = String(error?.message || error);
      // A genuinely absent catalogue segment cannot be recovered by refusing to run, and
      // the next scans rebuild it, so warn loudly and continue. This used to apply to
      // every segment on the grounds that the core still held every portfolio and trade
      // -- which stopped being true once each portfolio's trades and run log moved into
      // a segment of its own. Continuing past one of those 404s would publish a state
      // with that portfolio's whole history silently emptied, so it has to fail closed.
      if (/HTTP 404\b/.test(message)) {
        if (!stateSegmentIsRebuildable(name)) {
          throw new Error(
            `Published state segment "${name}" is missing (${url}) and nothing regenerates it. `
            + "Refusing to continue: publishing now would drop the history it holds.",
          );
        }
        console.warn(
          `Published state segment is missing: ${url}. Continuing with the core state; `
          + "the affected catalogue will be rebuilt by the next scans.",
        );
        continue;
      }
      // Anything else (500, 502, timeout) probably means the data is still there, so
      // this must not become a rewrite with empty collections.
      throw new Error(`Published state segment could not be read (${url}): ${message}`);
    }
  }
  return merged;
}

async function readState() {
  if (String(process.env.PAPER_RESET_STATE || "").toLowerCase() === "true") {
    return normalizeState({});
  }

  const focusedRefresh = REFRESH_TOKEN_ID !== "" || REFRESH_MARKET_SLUG !== "";
  const remoteStateUrl = focusedRefresh && process.env.PAPER_REFRESH_STATE_URL
    ? process.env.PAPER_REFRESH_STATE_URL
    : REMOTE_STATE_URL;
  let remoteError = null;
  if (remoteStateUrl) {
    try {
      const core = await fetchJson(`${remoteStateUrl}${remoteStateUrl.includes("?") ? "&" : "?"}t=${Date.now()}`);
      const remote = await readStateWithSegments(core);
      if (remote && typeof remote === "object" && (Array.isArray(remote.trades) || remote.paperPortfolios)) {
        const remoteState = normalizeState(remote);
        try {
          return mergeStates(remoteState, normalizeState(await readLocalStateFile(OUTPUT_PATH)));
        } catch {
          return remoteState;
        }
      }
      remoteError = new Error("Remote state did not contain a trades array");
    } catch (error) {
      remoteError = error;
    }
  }

  // A malformed or oversized historical state can make PHP return 500 before
  // it reaches the lightweight summary response. In that one case recover
  // from the static JSON, compact it on the next write, and keep the full
  // scraped catalogue intact rather than falling back to an old repository
  // snapshot.
  if (remoteError && STATIC_STATE_URL) {
    try {
      const separator = STATIC_STATE_URL.includes("?") ? "&" : "?";
      const remote = await readStateWithSegments(
        await fetchJson(`${STATIC_STATE_URL}${separator}t=${Date.now()}`),
      );
      if (remote && typeof remote === "object" && (Array.isArray(remote.trades) || remote.paperPortfolios)) {
        console.warn(`Primary paper state endpoint failed (${remoteError.message}); recovering from static state file.`);
        return normalizeState(remote);
      }
      remoteError = new Error("Static paper state did not contain a trades array");
    } catch (error) {
      remoteError = new Error(`Primary state failed and static recovery failed: ${remoteError.message}; ${error?.message || error}`);
    }
  }

  const remoteStateIsMissing = remoteError && /HTTP 404\b/.test(String(remoteError.message || remoteError));
  // Any remote failure other than a clean 404 stays fail-closed: a transient 500
  // or 502 must never let this run publish a substitute over valid hosted data.
  if (remoteStateUrl && remoteError && !remoteStateIsMissing) {
    throw new Error(`Refusing to continue because the published paper state is unavailable: ${remoteError.message}`);
  }

  let parsedLocal = null;
  try {
    parsedLocal = await readLocalStateFile(OUTPUT_PATH);
  } catch {
    parsedLocal = null;
  }

  // Without a remote endpoint this is a local run (tests, manual inspection), so
  // the checked-out file is the intended input.
  if (!remoteStateUrl) {
    if (parsedLocal === null) return normalizeState({});
    return normalizeState(parsedLocal);
  }

  if (!remoteError) {
    // The remote read succeeded but the payload failed the shape check above.
    // That is handled by the fail-closed branch, so this is unreachable in
    // practice; keep it explicit rather than silently publishing something.
    throw new Error("Published paper state could not be interpreted and no recovery source is available.");
  }

  // The published state is genuinely gone. A historical repository snapshot must
  // never become production state by accident: it is a test fixture, not a
  // backup. Recovering from it requires the current schema AND an explicit
  // opt-in, otherwise this run fails loudly and leaves the hosting untouched.
  if (parsedLocal === null) {
    throw new Error(
      "Published paper state is missing (HTTP 404) and no readable local snapshot exists. "
      + "Refusing to publish an empty state over the hosting; restore data/paper-state.json on the hosting first.",
    );
  }
  if (!stateHasCurrentSchema(parsedLocal)) {
    throw new Error(
      "Published paper state is missing (HTTP 404) and the repository snapshot uses an obsolete schema "
      + "without paperPortfolios. Refusing to publish it as production state; restore the hosted state file, "
      + "or replace the snapshot with a current-schema one and set PAPER_ALLOW_SEED_BOOTSTRAP=true.",
    );
  }
  if (!ALLOW_SEED_BOOTSTRAP) {
    throw new Error(
      "Published paper state is missing (HTTP 404). Refusing to auto-restore production from the repository "
      + "snapshot; re-run with PAPER_ALLOW_SEED_BOOTSTRAP=true to allow that explicitly.",
    );
  }
  console.warn("Published paper state is missing; restoring from the explicitly allowed current-schema snapshot.");
  return normalizeState(parsedLocal);
}

// The multi-portfolio schema is the only shape the dashboard can render. A
// snapshot without it would blank all three paper portfolios.
function stateHasCurrentSchema(input) {
  return Boolean(
    input
    && typeof input === "object"
    && input.paperPortfolios
    && typeof input.paperPortfolios === "object"
    && !Array.isArray(input.paperPortfolios),
  );
}

function normalizeState(input) {
  const conservativeInput = input.paperPortfolios?.conservative || {
    portfolio: input.portfolio,
    trades: input.trades,
    lastTradeDate: input.lastTradeDate,
    lastTradeHour: input.lastTradeHour,
    lastDecision: input.lastDecision,
    runLog: input.runLog,
  };
  // Reported: a portfolio created (and started) in the browser never opened a single
  // trade. This object literal only ever named the four shipped portfolios, so on
  // every reload it silently dropped every other key in input.paperPortfolios --
  // a created portfolio's trades, run log and capital adjustment included, however
  // many cycles they had accumulated over. Looping every currently-known strategy
  // (built-in and created) is what updatePortfolio() already does after a run; doing
  // the same here on the way in is what keeps a created portfolio's history from
  // being wiped back to blank before this run's decisions are even made.
  const paperPortfolios = {};
  const persisted = input.paperPortfolios && typeof input.paperPortfolios === "object" && !Array.isArray(input.paperPortfolios)
    ? input.paperPortfolios
    : {};
  // A persisted portfolio this process has no strategy for is carried through
  // untouched. Not every workflow that writes paper state loads the saved portfolio
  // config first: the market scan runs this same module with PAPER_CUSTOM_PORTFOLIOS
  // unset, so PAPER_STRATEGIES there is only the four shipped ones. Rebuilding the map
  // from PAPER_STRATEGIES alone therefore deleted every created portfolio's trades and
  // run log on each scan and published the truncated state -- which is how a portfolio
  // came to show OPENED rows in its archived run log (those are appended to their own
  // NDJSON files and survive) and nothing at all in its positions. Missing from this
  // process's strategy list means "not configured here", never "delete it". It is kept
  // verbatim rather than normalized because there is no strategy definition to
  // normalize it against, and normalizing against the wrong one is what previously
  // made created portfolios inherit Conservative's settings.
  for (const [id, portfolio] of Object.entries(persisted)) {
    if (PAPER_STRATEGIES[id] || !portfolio || typeof portfolio !== "object") continue;
    paperPortfolios[id] = portfolio;
  }
  for (const strategy of Object.values(PAPER_STRATEGIES)) {
    const strategyInput = strategy.id === "conservative"
      ? conservativeInput
      : persisted[strategy.id] || {};
    paperPortfolios[strategy.id] = normalizePaperPortfolio(strategy, strategyInput);
  }
  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt || null,
    cadence: normalizeCadence(input.cadence),
    paperPortfolios,
    paperPortfolioArchives: normalizePaperPortfolioArchives(input.paperPortfolioArchives),
    portfolio: paperPortfolios.conservative.portfolio,
    trades: paperPortfolios.conservative.trades,
    evaluations: mergeEvaluationLists(Array.isArray(input.evaluations) ? input.evaluations : []),
    marketObservations: retainMarketObservations(
      mergeMarketObservationLists(Array.isArray(input.marketObservations) ? input.marketObservations : []),
    ),
    marketScan: normalizeMarketScan(input.marketScan),
    marketScanHistory: normalizeMarketScanHistory(input.marketScanHistory),
    evaluationRunLog: Array.isArray(input.evaluationRunLog)
      ? input.evaluationRunLog.slice(0, EVALUATION_RUN_LOG_LIMIT).map(compactEvaluationRunRecord).filter(Boolean)
      : [],
    evaluationStats: input.evaluationStats && typeof input.evaluationStats === "object" ? input.evaluationStats : null,
    aiEvaluation: input.aiEvaluation && typeof input.aiEvaluation === "object" ? input.aiEvaluation : null,
    calculationReports: Array.isArray(input.calculationReports) ? input.calculationReports.slice(0, CALCULATION_REPORT_HISTORY_LIMIT) : [],
    latestCalculationReport: input.latestCalculationReport || (Array.isArray(input.calculationReports) ? input.calculationReports[0] || null : null),
    learningProfile: normalizeLearningProfile(input.learningProfile),
    aiUsageLog: Array.isArray(input.aiUsageLog) ? input.aiUsageLog.slice(-Math.max(20, AI_USAGE_HISTORY_LIMIT)) : [],
    aiUsage: input.aiUsage && typeof input.aiUsage === "object" ? input.aiUsage : null,
    lastTradeDate: paperPortfolios.conservative.lastTradeDate,
    lastTradeHour: paperPortfolios.conservative.lastTradeHour,
    lastDecision: paperPortfolios.conservative.lastDecision,
    runLog: paperPortfolios.conservative.runLog,
    // Where the last run's time went. This object is rebuilt field by field, so a phase
    // breakdown stamped on the state just before the write would be dropped here without
    // being named.
    lastPassTiming: input.lastPassTiming && typeof input.lastPassTiming === "object" ? input.lastPassTiming : null,
  };
}

function normalizePaperPortfolio(strategy, input = {}) {
  const normalized = {
    id: strategy.id,
    label: strategy.label,
    selectionMetric: strategy.selectionMetric,
    selectionOrder: strategy.selectionOrder,
    minProbability: strategy.minProbability,
    stakeUsdc: Number(strategy.stakeUsdc ?? input.stakeUsdc ?? input.portfolio?.stakeUsdc ?? STAKE_USDC),
    maxFraction: strategy.maxFraction,
    maxResolutionDays: strategyMaxResolutionDays(strategy),
    minLiquidityUsdc: strategy.minLiquidityUsdc,
    minNetYield: Math.max(0, Number(strategy.minNetYield) || 0),
    executionTrigger: normalizeExecutionTrigger(strategy.executionTrigger),
    marketType: normalizePortfolioMarketType(strategy.marketType, strategy.requireMostProbableOutcome),
    requireMostProbableOutcome: Boolean(strategy.requireMostProbableOutcome),
    probabilitySource: strategy.probabilitySource,
    equalRiskMultiplier: normalizeStopLossRiskMultiplier(strategy.equalRiskMultiplier, strategy.equalRiskProtection ? 1 : 0),
    equalRiskProtection: Boolean(strategy.equalRiskProtection),
    allowRotation: strategy.allowRotation !== false,
    // Carried like the other per-portfolio execution switches, because how the next order
    // is sized depends on it: a resting limit order holds capital without being exposure,
    // so it does not block the order after it. updatePaperPortfolio reads this to publish
    // both the allocated and the deployable figure.
    useLimitOrders: Boolean(strategy.useLimitOrders),
    description: strategy.description,
    resetAt: input.resetAt || null,
    resetArchiveId: input.resetArchiveId || null,
    // Carried at this level, like resetAt, rather than inside .portfolio -- that object
    // is fully recomputed by updatePaperPortfolio() every pass, so anything meant to
    // persist across passes has to live outside it.
    capitalAdjustmentUsdc: Number(input.capitalAdjustmentUsdc) || 0,
    // When this was last rebased. This only marks where "performance since" starts
    // counting from; no trade and no closed-position history is ever dropped by it.
    capitalAdjustmentAt: input.capitalAdjustmentAt || null,
    // The equity the reset handed the account, and the open P/L it inherited. "Since the
    // reset" is measured against these two rather than by re-summing resolved trades,
    // which charged a position that was already under water at the reset a second time
    // once it resolved. Absent on a portfolio rebased before they were recorded, and
    // updatePaperPortfolio() falls back to the documented target for those.
    // numericOrNaN, not Number(): this normalizer both reads and writes these fields, so a
    // pass that stored null would have the next pass read Number(null) === 0 and store 0 --
    // and a recorded reset equity of zero makes "since the reset" the whole account value.
    // Reported as High reward showing Total P/L +$110.05 against equity $110.05 at +0.0%.
    capitalAdjustmentEquityUsdc: Number.isFinite(numericOrNaN(input.capitalAdjustmentEquityUsdc))
      ? Number(input.capitalAdjustmentEquityUsdc)
      : null,
    capitalAdjustmentOpenPnlUsdc: Number.isFinite(numericOrNaN(input.capitalAdjustmentOpenPnlUsdc))
      ? Number(input.capitalAdjustmentOpenPnlUsdc)
      : null,
    portfolio: {
      initialUsdc: Number(input.portfolio?.initialUsdc || PORTFOLIO_USDC),
      stakeUsdc: Number(strategy.stakeUsdc ?? input.portfolio?.stakeUsdc ?? input.stakeUsdc ?? STAKE_USDC),
      maxFraction: Number(strategy.maxFraction ?? input.portfolio?.maxFraction ?? MAX_FRACTION),
      minProbability: Number(strategy.minProbability ?? input.portfolio?.minProbability ?? MIN_PROBABILITY),
      minAnnualReturn: Number(input.portfolio?.minAnnualReturn || MIN_ANNUAL_RETURN),
      opportunityMinProbability: Number(input.portfolio?.opportunityMinProbability || OPPORTUNITY_MIN_PROBABILITY),
      opportunityMinEdge: Number(input.portfolio?.opportunityMinEdge || OPPORTUNITY_MIN_EDGE),
      opportunityMinAnnualReturn: Number(input.portfolio?.opportunityMinAnnualReturn || OPPORTUNITY_MIN_ANNUAL_RETURN),
      maxResolutionDays: strategyMaxResolutionDays(strategy),
      minLiquidityUsdc: strategy.minLiquidityUsdc == null ? null : Number(strategy.minLiquidityUsdc),
      minNetYield: Math.max(0, Number(strategy.minNetYield) || 0),
      executionTrigger: normalizeExecutionTrigger(strategy.executionTrigger),
      marketType: normalizePortfolioMarketType(strategy.marketType, strategy.requireMostProbableOutcome),
      requireMostProbableOutcome: Boolean(strategy.requireMostProbableOutcome),
      probabilitySource: strategy.probabilitySource,
      equalRiskMultiplier: normalizeStopLossRiskMultiplier(strategy.equalRiskMultiplier, strategy.equalRiskProtection ? 1 : 0),
      equalRiskProtection: Boolean(strategy.equalRiskProtection),
      allowRotation: strategy.allowRotation !== false,
    },
    trades: retainPaperTrades(Array.isArray(input.trades)
      ? input.trades.map((trade) => normalizeTrade({ ...trade, strategyId: trade.strategyId || strategy.id, strategyLabel: trade.strategyLabel || strategy.label }))
      : []),
    lastTradeDate: input.lastTradeDate || null,
    lastTradeHour: input.lastTradeHour || null,
    lastDecision: compactPortfolioRunRecord(input.lastDecision),
    runLog: Array.isArray(input.runLog)
      ? input.runLog.slice(0, PORTFOLIO_RUN_LOG_LIMIT).map(compactPortfolioRunRecord).filter(Boolean)
      : [],
  };
  // The block above is a configuration whitelist, so it silently dropped every
  // computed aggregate. Because writeState() normalizes immediately before
  // persisting, equityUsdc / realizedPnlUsdc / openPnlUsdc / openRiskUsdc /
  // freeCapitalUsdc never reached the published state, and the dashboard fell
  // back to "$100.00 equity, $0.00 P/L, $0.00 risk" no matter what the trades
  // said. Deriving them from the normalized trades here keeps a persisted state
  // internally consistent and impossible to strip.
  updatePaperPortfolio(normalized);
  return normalized;
}

function normalizePaperPortfolioArchives(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === "object" && item.id && item.strategyId && item.archivedAt)
    .map((item) => ({
      id: String(item.id),
      strategyId: String(item.strategyId),
      label: String(item.label || item.strategyId),
      archivedAt: String(item.archivedAt),
      reason: String(item.reason || "manual paper portfolio reset"),
      snapshot: item.snapshot && typeof item.snapshot === "object" ? item.snapshot : {},
    }))
    .sort((a, b) => (Date.parse(b.archivedAt) || 0) - (Date.parse(a.archivedAt) || 0))
    .slice(0, 20);
}

function cloneForArchive(value) {
  return JSON.parse(JSON.stringify(value));
}

function archiveAndResetPaperPortfolio(state, strategyId, reason = "manual paper portfolio reset") {
  const strategy = PAPER_STRATEGIES[strategyId];
  if (!strategy) throw new Error(`Unknown paper portfolio strategy: ${strategyId}`);

  state.paperPortfolios ||= {};
  const current = normalizePaperPortfolio(strategy, state.paperPortfolios[strategyId] || {});
  const archivedAt = nowIso();
  const archive = {
    id: `paper-archive-${strategyId}-${archivedAt.replace(/[^0-9]/g, "")}`,
    strategyId,
    label: current.label || strategy.label,
    archivedAt,
    reason,
    snapshot: cloneForArchive({
      portfolio: current.portfolio,
      trades: current.trades,
      lastTradeDate: current.lastTradeDate,
      lastTradeHour: current.lastTradeHour,
      lastDecision: current.lastDecision,
      runLog: current.runLog,
    }),
  };
  state.paperPortfolioArchives = normalizePaperPortfolioArchives([
    archive,
    ...(state.paperPortfolioArchives || []),
  ]);

  // Keep saved strategy parameters: the workflow has already loaded them from
  // portfolio-config.json. Only the account history and capital baseline reset.
  state.paperPortfolios[strategyId] = normalizePaperPortfolio(strategy, {
    resetAt: archivedAt,
    resetArchiveId: archive.id,
  });
  syncLegacyPaperAliases(state);
  return archive;
}

/**
 * Undoes a reset: restores a portfolio's trades, run log and last-decision record from
 * its own archive snapshot, keeping this exact undo one-off rather than a repeatable
 * feature -- there is no UI for it, only a bot mode a workflow dispatch can reach.
 *
 * A trade opened after the reset can share its id with an archived one: the id is
 * built as strategyId+day+tokenId, which collides on purpose within one portfolio on
 * one day. Restoring must not let that collision silently drop either side, so a
 * colliding pair is kept as two rows unless they are identical, and every collision is
 * named in the return value so the operator can see exactly what happened.
 */
function restoreArchivedPaperPortfolio(state, strategyId, { archiveId } = {}) {
  const strategy = PAPER_STRATEGIES[strategyId];
  if (!strategy) throw new Error(`Unknown paper portfolio strategy: ${strategyId}`);

  state.paperPortfolios ||= {};
  const current = normalizePaperPortfolio(strategy, state.paperPortfolios[strategyId] || {});
  const archives = normalizePaperPortfolioArchives(state.paperPortfolioArchives || []);
  const targetId = archiveId || current.resetArchiveId;
  const archive = (targetId && archives.find((entry) => entry.id === targetId))
    || archives.find((entry) => entry.strategyId === strategyId);
  if (!archive) throw new Error(`No archive found to restore ${strategyId} from.`);

  const snapshot = archive.snapshot || {};
  const archivedTrades = Array.isArray(snapshot.trades) ? snapshot.trades : [];
  const archivedById = new Map(archivedTrades.map((trade) => [trade.id, trade]));
  const collisions = [];
  const additional = [];
  for (const trade of current.trades) {
    const archived = archivedById.get(trade.id);
    if (!archived) {
      additional.push(trade);
      continue;
    }
    if (JSON.stringify(archived) === JSON.stringify(trade)) continue;
    // Real progress since the reset -- the reopened position was closed out -- is kept
    // over the archived, still-open row for the same id. Anything else is a collision
    // this function will not guess at, so both rows are kept, one under a disambiguated
    // id, and the collision is reported rather than silently resolved either way.
    if (!OPEN_STATUSES.has(String(archived.status || "").toUpperCase())
      || OPEN_STATUSES.has(String(trade.status || "").toUpperCase())) {
      collisions.push({ id: trade.id, resolution: "kept-both" });
      additional.push({ ...trade, id: `${trade.id}-post-reset` });
    } else {
      collisions.push({ id: trade.id, resolution: "kept-post-reset-close" });
    }
  }
  const restoredTrades = archivedTrades.map((trade) => {
    const collidedClose = current.trades.find((row) => row.id === trade.id
      && !OPEN_STATUSES.has(String(row.status || "").toUpperCase())
      && OPEN_STATUSES.has(String(trade.status || "").toUpperCase()));
    return collidedClose || trade;
  });

  const restored = normalizePaperPortfolio(strategy, {
    ...snapshot,
    trades: [...restoredTrades, ...additional],
    // The reset's own markers no longer describe this portfolio's history.
    resetAt: null,
    resetArchiveId: null,
  });
  // normalizePaperPortfolio() already recomputes portfolio.* (equity, free capital,
  // realized/open PnL) from `restored.trades` before returning, so it reflects whatever
  // ended up in the restored set, including any trade kept from after the reset.
  state.paperPortfolios[strategyId] = restored;
  syncLegacyPaperAliases(state);
  return { archiveId: archive.id, restoredTrades: restored.trades.length, collisions };
}

/**
 * A one-time manual top-up of a portfolio's capital baseline so its displayed equity
 * reads `targetEquity`, without touching a single trade. Reported: after a mistaken
 * reset was undone, the account's true equity reflects its full, real historical PnL --
 * which is exactly what should not be erased -- but the request was only ever to rebase
 * the number, never to lose the history behind it.
 *
 * `capitalAdjustmentUsdc` is not a hidden fudge: updatePaperPortfolio() folds it into
 * PORTFOLIO_USDC to form this portfolio's baseline, so it is published on every row and
 * moves equity, free capital and percentage returns together, consistently, from here on.
 */
function adjustPaperPortfolioCapital(state, strategyId, targetEquity = 100) {
  const strategy = PAPER_STRATEGIES[strategyId];
  if (!strategy) throw new Error(`Unknown paper portfolio strategy: ${strategyId}`);

  state.paperPortfolios ||= {};
  // normalizePaperPortfolio() recomputes portfolio.* before returning, so this reads the
  // account's genuine current equity under whatever adjustment it already carries.
  const current = normalizePaperPortfolio(strategy, state.paperPortfolios[strategyId] || {});
  const priorEquity = Number(current.portfolio.equityUsdc);
  const priorAdjustment = Number(current.capitalAdjustmentUsdc) || 0;
  const newAdjustment = Number((priorAdjustment + (Number(targetEquity) - priorEquity)).toFixed(4));
  const adjustedAt = nowIso();
  const adjusted = normalizePaperPortfolio(strategy, {
    ...current,
    capitalAdjustmentUsdc: newAdjustment,
    capitalAdjustmentAt: adjustedAt,
    // The two numbers "since the reset" has to be measured against. Recorded here rather
    // than reconstructed later: the equity a reset hands the account is a stock, and the
    // open book it inherits is what stops the same loss being charged twice once those
    // positions resolve. Without them the stats had to re-sum resolved trades, which
    // counted a position that was already under water at the reset all over again.
    capitalAdjustmentEquityUsdc: Number(Number(targetEquity).toFixed(4)),
    capitalAdjustmentOpenPnlUsdc: Number((Number(current.portfolio?.openPnlUsdc) || 0).toFixed(4)),
  });
  state.paperPortfolios[strategyId] = adjusted;
  syncLegacyPaperAliases(state);
  return {
    priorEquity,
    priorAdjustment,
    newAdjustment,
    newEquity: adjusted.portfolio.equityUsdc,
    adjustedAt,
  };
}

/**
 * A rebase dispatched before capitalAdjustmentAt existed has the right
 * capitalAdjustmentUsdc already, just no recorded moment for "since the rebase" stats to
 * start counting from. This backfills only that timestamp -- never the adjustment amount,
 * a trade, or anything else -- for a portfolio the user identifies by when they actually
 * did it.
 */
function backfillCapitalAdjustmentAt(state, strategyId, isoTimestamp) {
  const strategy = PAPER_STRATEGIES[strategyId];
  if (!strategy) throw new Error(`Unknown paper portfolio strategy: ${strategyId}`);
  if (!Number.isFinite(Date.parse(isoTimestamp))) {
    throw new Error(`Invalid capitalAdjustmentAt timestamp: ${isoTimestamp}`);
  }
  state.paperPortfolios ||= {};
  const current = normalizePaperPortfolio(strategy, state.paperPortfolios[strategyId] || {});
  const adjusted = normalizePaperPortfolio(strategy, { ...current, capitalAdjustmentAt: isoTimestamp });
  state.paperPortfolios[strategyId] = adjusted;
  syncLegacyPaperAliases(state);
  return {
    capitalAdjustmentUsdc: adjusted.capitalAdjustmentUsdc,
    capitalAdjustmentAt: adjusted.capitalAdjustmentAt,
  };
}

function compactReasonCounts(reasonCounts) {
  if (!reasonCounts || typeof reasonCounts !== "object") return {};
  return Object.fromEntries(Object.entries(reasonCounts)
    .map(([reason, count]) => [String(reason || "Unknown reason").slice(0, 220), Number(count || 0)])
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TRADE_BATCH_REASON_LOG_LIMIT));
}

function compactCandidateLogRows(rows, limit = TRADE_BATCH_CANDIDATE_LOG_LIMIT) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const summary = tradeBatchCandidateSummary(item) || {};
      return {
        ...summary,
        selectionDecision: item.selectionDecision || null,
        portfolioRejectReasons: Array.isArray(item.portfolioRejectReasons)
          ? item.portfolioRejectReasons.slice(0, 4).map((reason) => String(reason).slice(0, 220))
          : [],
      };
    })
    .filter(Boolean);
}

function compactPortfolioFilterDiagnostics(input) {
  if (!input || typeof input !== "object") return null;
  return {
    totalEvaluated: Number(input.totalEvaluated || 0),
    baseEligible: Number(input.baseEligible || 0),
    portfolioEligible: Number(input.portfolioEligible || 0),
    excludedCount: Number(input.excludedCount || 0),
    reasonCounts: compactReasonCounts(input.reasonCounts),
    excludedSample: compactCandidateLogRows(input.excludedSample, 8),
  };
}

function compactPrevalidationFilter(input) {
  if (!input || typeof input !== "object") return null;
  return {
    source: input.source || null,
    storedEvaluations: Number(input.storedEvaluations || 0),
    storedMarketObservations: Number(input.storedMarketObservations || 0),
    uniqueEvaluations: Number(input.uniqueEvaluations || 0),
    prefilterPassed: Number(input.prefilterPassed || 0),
    prefilterRejected: Number(input.prefilterRejected || 0),
    selectedForRevalidation: Number(input.selectedForRevalidation || 0),
    revalidatedCount: Number(input.revalidatedCount || 0),
    revalidatedPortfolioEligible: Number(input.revalidatedPortfolioEligible || 0),
    revalidatedRejected: Number(input.revalidatedRejected || 0),
    skippedByScanLimit: Number(input.skippedByScanLimit || 0),
    reasonCounts: compactReasonCounts(input.reasonCounts),
    executionShortlist: compactCandidateLogRows(input.executionShortlist, 8),
    rejectedSample: compactCandidateLogRows(input.rejectedSample, 8),
    revalidatedCandidates: compactCandidateLogRows(input.revalidatedCandidates, 8),
    revalidatedRejectedSample: compactCandidateLogRows(input.revalidatedRejectedSample, 8),
  };
}

function compactTradeBatchLog(input) {
  if (!input || typeof input !== "object") return null;
  return {
    id: input.id || null,
    runAt: input.runAt || null,
    strategyId: input.strategyId || null,
    strategyLabel: input.strategyLabel || null,
    selectionMetric: input.selectionMetric || null,
    action: input.action || null,
    reason: String(input.reason || "").slice(0, 1000),
    explanation: String(input.explanation || "").slice(0, 1600),
    settings: input.settings && typeof input.settings === "object" ? input.settings : null,
    capital: input.capital && typeof input.capital === "object" ? input.capital : null,
    counts: input.counts && typeof input.counts === "object" ? input.counts : null,
    portfolioFilter: compactPortfolioFilterDiagnostics(input.portfolioFilter),
    selected: compactCandidateLogRows([input.selected], 1)[0] || null,
    eligibleCandidates: compactCandidateLogRows(input.eligibleCandidates),
    topCandidates: compactCandidateLogRows(input.topCandidates, 8),
    revalidatedCandidates: compactCandidateLogRows(input.revalidatedCandidates, 8),
    topRejected: compactCandidateLogRows(input.topRejected, 8),
    riskBlocked: compactCandidateLogRows(input.riskBlocked, 8),
    rotationReview: input.rotationReview && typeof input.rotationReview === "object" ? input.rotationReview : null,
    diversificationDiagnostics: input.diversificationDiagnostics && typeof input.diversificationDiagnostics === "object"
      ? input.diversificationDiagnostics
      : null,
    prevalidationFilter: compactPrevalidationFilter(input.prevalidationFilter),
  };
}

function compactPortfolioRunRecord(input) {
  if (!input || typeof input !== "object") return null;
  return {
    runAt: input.runAt || null,
    runSource: input.runSource || null,
    strategyId: input.strategyId || null,
    strategyLabel: input.strategyLabel || null,
    selectionMetric: input.selectionMetric || null,
    evaluatedCount: Number(input.evaluatedCount || 0),
    eligibleCount: Number(input.eligibleCount || 0),
    action: input.action || null,
    reason: String(input.reason || "").slice(0, 1000),
    tradeId: input.tradeId || null,
    closedTradeId: input.closedTradeId || null,
    rotationReview: input.rotationReview && typeof input.rotationReview === "object" ? input.rotationReview : null,
    batchLog: compactTradeBatchLog(input.batchLog),
    availableCapitalUsdc: input.availableCapitalUsdc ?? null,
    requiredStakeUsdc: input.requiredStakeUsdc ?? null,
    insufficientCapital: Boolean(input.insufficientCapital),
    selectedHorizonDays: input.selectedHorizonDays ?? null,
    riskSkippedCount: Number(input.riskSkippedCount || 0),
    refreshOnly: Boolean(input.refreshOnly),
    reportOnly: Boolean(input.reportOnly),
    learningSampleSize: Number(input.learningSampleSize || 0),
    brierScore: input.brierScore ?? null,
    calibrationBias: input.calibrationBias ?? null,
  };
}

function compactEvaluationRunRecord(input) {
  if (!input || typeof input !== "object") return null;
  return {
    id: input.id || null,
    runAt: input.runAt || null,
    refreshOnly: Boolean(input.refreshOnly),
    reportOnly: Boolean(input.reportOnly),
    evaluatedCount: Number(input.evaluatedCount || 0),
    eligibleCount: Number(input.eligibleCount || 0),
    rejectedCount: Number(input.rejectedCount || 0),
    errorCount: Number(input.errorCount || 0),
    statusCounts: input.statusCounts && typeof input.statusCounts === "object" ? input.statusCounts : {},
    decisions: (Array.isArray(input.decisions) ? input.decisions : []).slice(0, 4).map((decision) => ({
      strategyId: decision.strategyId || null,
      action: decision.action || null,
      reason: String(decision.reason || "").slice(0, 1000),
      tradeId: decision.tradeId || null,
      closedTradeId: decision.closedTradeId || null,
      rotationReview: decision.rotationReview && typeof decision.rotationReview === "object" ? decision.rotationReview : null,
      batchLog: compactTradeBatchLog(decision.batchLog),
      availableCapitalUsdc: decision.availableCapitalUsdc ?? null,
      requiredStakeUsdc: decision.requiredStakeUsdc ?? null,
      insufficientCapital: Boolean(decision.insufficientCapital),
    })),
    // This run-level log points to examples; the full opportunity catalogue
    // remains in state.evaluations/state.marketObservations.
    events: (Array.isArray(input.events) ? input.events : []).slice(0, 30).map((event) => ({
      id: event.id || null,
      evaluatedAt: event.evaluatedAt || null,
      evaluationResult: event.evaluationResult || null,
      portfolioFilterStatus: event.portfolioFilterStatus || null,
      status: event.status || null,
      question: event.question || "",
      outcome: event.outcome || "",
      slug: event.slug || null,
      eventSlug: event.eventSlug || null,
      tokenId: event.tokenId || null,
      url: event.url || null,
      aiProbability: event.aiProbability ?? null,
      marketPrice: event.marketPrice ?? null,
      annualizedReturn: event.annualizedReturn ?? null,
      expectedValueUsdc: event.expectedValueUsdc ?? null,
      netGainIfWinUsdc: event.netGainIfWinUsdc ?? null,
      riskReward: event.riskReward ?? null,
      liquidity: event.liquidity ?? null,
      endDate: event.endDate || null,
      daysToResolution: event.daysToResolution ?? null,
      rejectReasons: Array.isArray(event.rejectReasons) ? event.rejectReasons.slice(0, 3) : [],
      analysisSummary: String(event.analysisSummary || "").slice(0, 600),
      probabilityThesis: String(event.probabilityThesis || "").slice(0, 600),
      analysisModel: event.analysisModel || null,
      riskGroupLabels: Array.isArray(event.riskGroupLabels) ? event.riskGroupLabels.slice(0, 5) : [],
    })),
  };
}

function stateTime(state) {
  const time = Date.parse(state?.generatedAt || "");
  return Number.isFinite(time) ? time : 0;
}

function tradeUpdateTime(trade) {
  return Math.max(
    Date.parse(trade?.resolvedAt || "") || 0,
    Date.parse(trade?.closedTime || "") || 0,
    Date.parse(trade?.lastCheckedAt || "") || 0,
    Date.parse(trade?.openedAt || trade?.date || "") || 0,
  );
}

function evaluationKey(item) {
  const tokenId = String(item?.tokenId || item?.clobTokenId || "").trim();
  if (tokenId) return `token:${tokenId}`;
  const slug = String(item?.slug || item?.eventSlug || "").trim().toLowerCase();
  const outcome = String(item?.outcome || "").trim().toLowerCase();
  if (slug && outcome) return `market:${slug}:${outcome}`;
  return String(item?.id || "").trim();
}

function evaluationUpdateTime(item) {
  return Math.max(
    Date.parse(item?.evaluatedAt || "") || 0,
    Date.parse(item?.lastSeenAt || "") || 0,
    Date.parse(item?.marketDataUpdatedAt || "") || 0,
    Date.parse(item?.updatedAt || "") || 0,
  );
}

function marketObservationKey(item) {
  return String(item?.marketKey || item?.id || item?.tokenId || "").trim();
}

function marketObservationUpdateTime(item) {
  return Date.parse(item?.marketDataUpdatedAt || item?.observedAt || item?.updatedAt || "") || 0;
}

function hasOriginalMarketProbability(item) {
  // `withFirstObservationMetadata` has already made the one safe migration for old
  // rows: a recorded live quote becomes the first stored quote when the original
  // field was absent. A settlement-only 0%/100% print is not an original market
  // probability and must never be used as evidence in the historical simulation.
  return validMarketProbability(item?.firstMarketProbability) != null;
}

// A settled book prints 0 or 1, and `firstMarketProbability` used to be seeded from
// `marketProbability` before `lastLiveMarketProbability` existed. Rows that resolved
// back then carry a stuck 0/1 entry price, and scrapedSimulationTrade() discards any
// row whose entry is not strictly between 0 and 1 -- so resolved observations dropped
// out of the parameter simulation entirely instead of being counted in it, which is
// why "Resolved" there fell far short of the resolved list's own count. Any genuinely
// live quote on the row beats a settlement print, whichever field it sits in.
function firstLiveProbability(...candidates) {
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0 && numeric < 1) return numeric;
  }
  return null;
}

function firstObservationMetadata(item = {}) {
  const firstObservedAt = item.firstObservedAt || item.observedAt || item.marketDataUpdatedAt || null;
  // Falls back to the raw value when no live quote was ever recorded, so the row stays
  // excluded downstream -- a 0%/100% entry price is not a tradable simulation.
  const firstProbability = firstLiveProbability(
    item.firstMarketProbability,
    item.lastLiveMarketProbability,
    item.marketProbability,
    item.marketPrice,
  ) ?? Number(item.firstMarketProbability ?? item.marketProbability ?? item.marketPrice);
  const firstLiquidity = Number(item.firstLiquidity ?? item.liquidity);
  const firstVolumeUsdc = Number(
    item.firstVolumeUsdc ?? item.volumeUsdc ?? item.firstVolume24hr ?? item.volume24hr,
  );
  const firstVolume24hr = Number(item.firstVolume24hr ?? item.volume24hr);
  const firstDays = Number(item.firstDaysToResolution ?? item.daysToResolution);
  const firstFeeRate = Number(item.firstFeeRate ?? item.feeRate);
  const currentTags = Array.isArray(item.tags) ? item.tags.filter(Boolean).map(String) : [];
  const currentPolymarketCategories = Array.isArray(item.polymarketCategories)
    ? item.polymarketCategories.filter(Boolean)
    : [];
  const currentPolymarketTags = Array.isArray(item.polymarketTags)
    ? item.polymarketTags.filter(Boolean)
    : [];
  return {
    firstObservedAt,
    firstMarketProbability: Number.isFinite(firstProbability) ? Number(firstProbability.toFixed(4)) : null,
    firstLiquidity: Number.isFinite(firstLiquidity) ? Number(firstLiquidity.toFixed(2)) : null,
    firstVolumeUsdc: Number.isFinite(firstVolumeUsdc) ? Number(firstVolumeUsdc.toFixed(2)) : null,
    firstVolume24hr: Number.isFinite(firstVolume24hr) ? Number(firstVolume24hr.toFixed(2)) : null,
    firstDaysToResolution: Number.isFinite(firstDays) ? Number(firstDays.toFixed(2)) : null,
    firstFeeRate: Number.isFinite(firstFeeRate) ? Number(firstFeeRate.toFixed(8)) : null,
    firstOutcome: item.firstOutcome || item.outcome || null,
    firstTokenId: item.firstTokenId || item.tokenId || null,
    firstCategory: item.firstCategory || item.riskCategory || currentTags[0] || "general",
    firstTags: Array.isArray(item.firstTags) && item.firstTags.length ? item.firstTags : currentTags,
    firstPolymarketCategories: Array.isArray(item.firstPolymarketCategories)
      && item.firstPolymarketCategories.length
      ? item.firstPolymarketCategories
      : currentPolymarketCategories,
    firstPolymarketTags: Array.isArray(item.firstPolymarketTags) && item.firstPolymarketTags.length
      ? item.firstPolymarketTags
      : currentPolymarketTags,
  };
}

// Once a market settles its book prints 0 or 1, which would overwrite the market
// probability the row carried while it was tradable and leave every resolved entry
// reading 0% or 100%. Remember the last quote seen while the market was genuinely
// live; the settlement outcome is kept separately in finalOutcomePrice. Sticky, so
// a later resolution update can never move it.
function withLastLiveMarketProbability(item = {}) {
  const current = Number(item.marketProbability ?? item.marketPrice);
  const currentIsLive = Number.isFinite(current) && current > 0 && current < 1;
  const stored = Number(item.lastLiveMarketProbability);
  const hasStored = Number.isFinite(stored) && stored > 0 && stored < 1;

  const status = String(item.status || item.selectionStatus || "").trim().toUpperCase();
  const resolved = ["RESOLVED", "CLOSED", "EXPIRED", "FINALIZED", "SETTLED"].includes(status)
    || item.marketClosed === true
    || item.acceptingOrders === false;

  if (resolved) {
    // Frozen from here on. If the transition to resolved happens while the book is
    // still quoting normally, that quote is the last live one worth keeping.
    if (hasStored || !currentIsLive) return item;
    return { ...item, lastLiveMarketProbability: Number(current.toFixed(4)) };
  }

  // Still tradable, so track the current quote rather than the first one.
  if (!currentIsLive) return item;
  if (hasStored && Number(stored.toFixed(4)) === Number(current.toFixed(4))) return item;
  return { ...item, lastLiveMarketProbability: Number(current.toFixed(4)) };
}

function withFirstObservationMetadata(item = {}) {
  return {
    ...withLastLiveMarketProbability(item),
    ...Object.fromEntries(Object.entries(firstObservationMetadata(item)).filter(([, value]) => value != null && value !== "")),
  };
}

function normalizeMarketObservationLifecycle(item, checkedAt = nowIso()) {
  if (!item || typeof item !== "object") return item;
  const timedItem = normalizeStoredMarketObservationTiming(item);
  const status = String(timedItem.status || timedItem.selectionStatus || "").trim().toUpperCase();
  if (status === "ERROR") return withFirstObservationMetadata(timedItem);
  if (status === "RESOLVED") {
    return withFirstObservationMetadata({
      ...timedItem,
      status: "RESOLVED",
      selectionStatus: "RESOLVED",
      resolutionStatus: timedItem.resolutionStatus || "PENDING_RESULT",
      resolvedAt: timedItem.resolvedAt || timedItem.closedTime || timedItem.endDate || checkedAt,
      resolvedDetectedAt: timedItem.resolvedDetectedAt || checkedAt,
    });
  }
  return withFirstObservationMetadata(timedItem);
}

function normalizeMarketScan(input = {}) {
  const storedMinutes = Number(input?.minResolutionMinutes);
  const storedHours = Number(input?.minResolutionHours);
  const minResolutionMinutes = Number.isFinite(storedMinutes)
    ? Math.max(0, storedMinutes)
    : Number.isFinite(storedHours)
      ? Math.max(0, storedHours * 60)
      : MARKET_SCAN_MIN_RESOLUTION_MINUTES;
  return {
    cursor: Math.max(0, Math.floor(Number(input?.cursor) || 0)),
    preferredCursor: Math.max(0, Math.floor(Number(input?.preferredCursor) || 0)),
    categoryCursor: Math.max(0, Math.floor(Number(input?.categoryCursor) || 0)),
    categoryOffsets: Object.fromEntries(
      Object.entries(input?.categoryOffsets && typeof input.categoryOffsets === "object" ? input.categoryOffsets : {})
        .map(([tag, offset]) => [String(tag || "").trim().toLowerCase(), Math.max(0, Math.floor(Number(offset) || 0))])
        .filter(([tag]) => Boolean(tag))
        .slice(0, MARKET_SCAN_CATEGORY_TAGS.length),
    ),
    scanCursors: Object.fromEntries(
      Object.entries(input?.scanCursors && typeof input.scanCursors === "object" ? input.scanCursors : {})
        .map(([scope, cursor]) => [String(scope || "").trim().toLowerCase(), String(cursor || "").trim()])
        .filter(([scope, cursor]) => Boolean(scope) && Boolean(cursor))
        .slice(0, MARKET_SCAN_CATEGORY_TAGS.length + 1),
    ),
    // Numeric Gamma tag ids for slugs outside MARKET_SCAN_CATEGORY_TAGS, keyed by slug.
    // Persisting them means a tag the dashboard offers is looked up once, not once a scan.
    resolvedTagIds: Object.fromEntries(
      Object.entries(input?.resolvedTagIds && typeof input.resolvedTagIds === "object" ? input.resolvedTagIds : {})
        .map(([slug, id]) => [String(slug || "").trim().toLowerCase(), String(id ?? "").trim()])
        .filter(([slug, id]) => Boolean(slug) && Boolean(id))
        .slice(0, 200),
    ),
    scanScopeCursor: Math.max(0, Math.floor(Number(input?.scanScopeCursor) || 0)),
    // Per-scope timestamp of the last full catalogue pass. Without preserving it here the
    // guaranteed hourly slot would read an empty map every run, think both tags were
    // overdue forever, and never let the rotation move.
    tagScannedAt: Object.fromEntries(
      Object.entries(input?.tagScannedAt && typeof input.tagScannedAt === "object" ? input.tagScannedAt : {})
        .map(([scope, at]) => [String(scope || "").trim(), String(at || "").trim()])
        .filter(([scope, at]) => Boolean(scope) && Boolean(at))
        .slice(0, MARKET_SCAN_CATEGORY_TAGS.length + 1),
    ),
    scanQuerySignature: String(input?.scanQuerySignature || "").slice(0, 500),
    lastScope: String(input?.lastScope || "").slice(0, 120),
    lastScopeCursor: String(input?.lastScopeCursor || "").slice(0, 1000) || null,
    lastScopeNextCursor: String(input?.lastScopeNextCursor || "").slice(0, 1000) || null,
    lastBatchEventCount: Math.max(0, Math.floor(Number(input?.lastBatchEventCount) || 0)),
    lastBatchEndDate: String(input?.lastBatchEndDate || "").slice(0, 80) || null,
    lastScanAt: input?.lastScanAt || null,
    lastBatchCount: Math.max(0, Math.floor(Number(input?.lastBatchCount) || 0)),
    lastPreferredCount: Math.max(0, Math.floor(Number(input?.lastPreferredCount) || 0)),
    lastShortHorizonCount: Math.max(0, Math.floor(Number(input?.lastShortHorizonCount) || 0)),
    preferredMaxResolutionDays: Math.max(1, Math.floor(Number(input?.preferredMaxResolutionDays) || MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS)),
    minResolutionMinutes,
    minResolutionHours: minResolutionMinutes / 60,
    lastCategoryCount: Math.max(0, Math.floor(Number(input?.lastCategoryCount) || 0)),
    lastCategoryCounts: input?.lastCategoryCounts && typeof input.lastCategoryCounts === "object" ? input.lastCategoryCounts : {},
    lastRequestedCategories: Array.isArray(input?.lastRequestedCategories)
      ? input.lastRequestedCategories.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean).slice(0, 32)
      : [],
    priorityLiquidityUsdc: Math.max(0, Number(input?.priorityLiquidityUsdc) || MARKET_SCAN_DIVERSITY_LIQUIDITY_USDC),
    liquidityMin: Math.max(0, Number(input?.liquidityMin) || 0),
    maxDays: Number.isFinite(Number(input?.maxDays)) && Number(input.maxDays) >= 0
      ? Math.min(3650, Number(input.maxDays))
      : null,
    lastTag: String(input?.lastTag || "").trim().toLowerCase(),
    // This function is a whitelist, so anything the scan records has to be listed here
    // or it never reaches the published state.
    liveScanEnabled: input?.liveScanEnabled !== false,
    liveScanWindowHours: Math.max(0, Number(input?.liveScanWindowHours) || 0),
    liveScanCount: Math.max(0, Math.floor(Number(input?.liveScanCount) || 0)),
    liveScanCounts: input?.liveScanCounts && typeof input.liveScanCounts === "object" ? input.liveScanCounts : {},
    liveScanError: input?.liveScanError || null,
    endDateGraceHours: Math.max(0, Number(input?.endDateGraceHours) || 0),
    lastScanError: input?.lastScanError || null,
  };
}

function normalizeMarketScanHistory(input = []) {
  return trimMarketScanHistory(Array.isArray(input) ? input : []);
}

function trimMarketScanHistory(input = []) {
  const historyLimit = MARKET_SCAN_HISTORY_LIMIT;
  const auditLimit = Math.max(1, MARKET_SCAN_AUDIT_HISTORY_LIMIT);
  const seen = new Set();
  // Older rows deliberately retain only their compact summary. They must stay
  // visible in the log even though their per-market drill-down has expired.
  const history = (Array.isArray(input) ? input : [])
    .filter((item) => item && typeof item === "object" && (item.id || item.runAt))
    .filter((item) => {
      const key = String(item.id || item.runAt);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (Date.parse(b.runAt || "") || 0) - (Date.parse(a.runAt || "") || 0))
    .slice(0, historyLimit);
  return history
    .map((item, index) => {
      if (index < auditLimit || !item || typeof item !== "object") {
        if (!item?.audit || typeof item.audit !== "object") return item;
        const auditMarkets = Array.isArray(item.audit.markets) ? item.audit.markets : [];
        const truncated = auditMarkets.length > MARKET_SCAN_AUDIT_ROW_LIMIT;
        return {
          ...item,
          audit: {
            ...item.audit,
            totalMarkets: Number(item.audit.totalMarkets || auditMarkets.length),
            truncatedCount: Number(item.audit.truncatedCount || 0) + Math.max(0, auditMarkets.length - MARKET_SCAN_AUDIT_ROW_LIMIT),
            markets: auditMarkets.slice(0, MARKET_SCAN_AUDIT_ROW_LIMIT),
            truncated,
          },
        };
      }
      const { audit, ...summary } = item;
      return summary;
    });
}

function mergeMarketObservationLists(primary = [], secondary = []) {
  const byKey = new Map();
  for (const rawItem of [...secondary, ...primary]) {
    const item = withFirstObservationMetadata(rawItem);
    const key = marketObservationKey(item);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, item);
      continue;
    }
    const incomingIsNewer = marketObservationUpdateTime(item) >= marketObservationUpdateTime(current);
    const newer = incomingIsNewer ? item : current;
    const older = incomingIsNewer ? current : item;
    const newerVerification = newer.executionRevalidation;
    const olderVerification = older.executionRevalidation;
    const newerCheckedAt = Date.parse(newerVerification?.checkedAt || "") || 0;
    const olderCheckedAt = Date.parse(olderVerification?.checkedAt || "") || 0;
    // A Gamma refresh updates market quotes but cannot prove CLOB executability.
    // Keep the latest live verdict until the next executor check replaces it.
    const executionRevalidation = newerCheckedAt >= olderCheckedAt ? newerVerification : olderVerification;
    const olderFirst = firstObservationMetadata(older);
    const newerFirst = firstObservationMetadata(newer);
    const firstTimes = [olderFirst.firstObservedAt, newerFirst.firstObservedAt]
      .map((value) => ({ value, time: Date.parse(value || "") || Infinity }))
      .sort((a, b) => a.time - b.time);
    const first = firstTimes[0]?.time < Infinity ? (
      firstTimes[0].value === olderFirst.firstObservedAt ? olderFirst : newerFirst
    ) : newerFirst;
    byKey.set(key, {
      ...older,
      ...newer,
      ...first,
      ...(executionRevalidation ? { executionRevalidation } : {}),
    });
  }
  const normalized = [...byKey.values()]
    .map((item) => normalizeMarketObservationLifecycle(item))
    .sort((a, b) => marketObservationUpdateTime(b) - marketObservationUpdateTime(a));
  return normalized;
}

function retainMarketObservations(items = []) {
  const active = [];
  const resolved = [];
  for (const item of Array.isArray(items) ? items : []) {
    const status = String(item?.status || item?.selectionStatus || "").toUpperCase();
    if (status !== "RESOLVED") {
      active.push(item);
      continue;
    }
    // Resolved entries without the quote that was available when we first saw them
    // cannot contribute a valid simulated trade: their only price is a final 0/1
    // settlement print. Purge them rather than retaining data that makes the
    // statistics look more complete than they are.
    if (!hasOriginalMarketProbability(item)) continue;
    resolved.push(item);
  }
  const compareActive = (a, b) => {
    const aDays = daysToEnd(a?.endDate);
    const bDays = daysToEnd(b?.endDate);
    const aBucket = Number.isFinite(aDays) && aDays >= 0 ? 0 : 1;
    const bBucket = Number.isFinite(bDays) && bDays >= 0 ? 0 : 1;
    if (aBucket !== bBucket) return aBucket - bBucket;
    if (Number.isFinite(aDays) && Number.isFinite(bDays) && aDays !== bDays) return aDays - bDays;
    return marketObservationUpdateTime(b) - marketObservationUpdateTime(a);
  };
  // Resolved markets are the record of what was actually scraped and how it ended:
  // the settled history every report and every parameter comparison is measured
  // against. Trimming it to a limit meant the archive silently stopped growing once
  // it filled, and the counts stopped matching what had really been mined. Active
  // rows are a working set and are still bounded -- an unresolved market that falls
  // out is re-scraped -- but a resolved one, once dropped, is gone for good.
  return [
    ...active.sort(compareActive).slice(0, MARKET_OBSERVATION_RETAIN_LIMIT),
    ...resolved.sort((a, b) => marketObservationUpdateTime(b) - marketObservationUpdateTime(a)),
  ].sort((a, b) => marketObservationUpdateTime(b) - marketObservationUpdateTime(a));
}

function mergeUniqueById(items, idFn, limit = Infinity) {
  const byId = new Map();
  for (const item of items) {
    const id = idFn(item);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, item);
  }
  return [...byId.values()].slice(0, limit);
}

const EVALUATION_CHANGE_FIELDS = [
  "status",
  "selectionStatus",
  "thesisType",
  "outcome",
  "tokenId",
  "marketPrice",
  "marketProbability",
  "marketDataUpdatedAt",
  "marketOutcomeFlipped",
  "bestAsk",
  "bestBid",
  "spread",
  "liquidity",
  "volume24hr",
  "aiProbability",
  "rawProbability",
  "edge",
  "expectedValueUsdc",
  "annualizedReturn",
  "aiExpectedValueUsdc",
  "aiAnnualizedReturn",
  "marketExpectedValueUsdc",
  "marketExpectedRoi",
  "marketAnnualizedReturn",
  "stakeUsdc",
  "executableShares",
  "totalCostUsdc",
  "takerFeeUsdc",
  "netGainIfWinUsdc",
  "riskReward",
  "expectedRoi",
  "endDate",
  "marketClosed",
  "acceptingOrders",
  "closedTime",
  "resolutionStatus",
  "finalOutcomePrice",
  "probabilityThesis",
];

function comparableEvaluationValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  if (Array.isArray(value)) return value.map(comparableEvaluationValue);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function changedEvaluationFields(previous, next) {
  const changes = [];
  for (const field of EVALUATION_CHANGE_FIELDS) {
    const from = comparableEvaluationValue(previous?.[field]);
    const to = comparableEvaluationValue(next?.[field]);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ field, from, to });
  }
  return changes;
}

function normalizeEvaluationRisk(item) {
  if (!item || typeof item !== "object") return item;
  const risk = riskProfile({
    question: item.question,
    slug: item.slug,
    eventSlug: item.eventSlug,
    outcome: item.outcome,
    tags: item.tags,
  });
  const existingRiskKeys = Array.isArray(item.riskGroupKeys) ? item.riskGroupKeys : [];
  const existingRiskLabels = Array.isArray(item.riskGroupLabels) ? item.riskGroupLabels : [];
  return {
    ...item,
    riskGroupKeys: [...new Set([...existingRiskKeys, ...risk.keys])],
    riskGroupLabels: [...new Set([...existingRiskLabels, ...risk.labels])],
    riskCategory: item.riskCategory || risk.category,
    riskPrimaryEntity: item.riskPrimaryEntity || risk.primaryEntity,
  };
}

function mergeEvaluation(previous, next) {
  if (!previous) {
    const key = evaluationKey(next);
    return normalizeEvaluationRisk({
      ...next,
      id: key || next.id,
      firstEvaluatedAt: next.firstEvaluatedAt || next.evaluatedAt || nowIso(),
      lastSeenAt: next.lastSeenAt || next.evaluatedAt || nowIso(),
      evaluationCount: Number(next.evaluationCount || 1),
      updateHistory: Array.isArray(next.updateHistory) ? next.updateHistory.slice(0, 30) : [],
    });
  }
  if (!next) return previous;

  const incomingIsNewer = evaluationUpdateTime(next) >= evaluationUpdateTime(previous);
  const latest = incomingIsNewer ? next : previous;
  const older = incomingIsNewer ? previous : next;
  const changes = changedEvaluationFields(older, latest);
  const deferredWithoutNewMemo = latest.selectionStatus === "AI_PENDING"
    || latest.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  const preservePreviousMemo = deferredWithoutNewMemo && hasStoredGroundedPublicMemo(previous);
  if (preservePreviousMemo) {
    const retryAt = latest.evaluatedAt || latest.lastSeenAt || nowIso();
    const retryReason = compactSentence(
      latest.errorReason
      || latest.aiAnalysis?.aiModelError
      || latest.analysisSummary
      || "Gemini grounded analysis was deferred before a newer memo was completed.",
    );
    return normalizeEvaluationRisk({
      ...previous,
      lastAiRetryAt: retryAt,
      lastAiRetryStatus: "QUOTA_LIMITED",
      lastAiRetryReason: retryReason,
      aiRetryCount: Number(previous.aiRetryCount || 0) + 1,
      aiRetryHistory: [{ attemptedAt: retryAt, status: "QUOTA_LIMITED", reason: retryReason }, ...(Array.isArray(previous.aiRetryHistory) ? previous.aiRetryHistory : [])].slice(0, 20),
    });
  }
  const sameObservation = (previous.evaluatedAt || previous.lastSeenAt || "") === (next.evaluatedAt || next.lastSeenAt || "")
    && changes.length === 0;
  const previousHistory = Array.isArray(previous.updateHistory) ? previous.updateHistory : [];
  const incomingHistory = Array.isArray(next.updateHistory) ? next.updateHistory : [];
  const changeEntry = changes.length
    ? [{
        changedAt: latest.evaluatedAt || latest.lastSeenAt || nowIso(),
        previousEvaluatedAt: older.evaluatedAt || older.lastSeenAt || null,
        changes: changes.slice(0, 20),
      }]
    : [];

  const merged = {
    ...older,
    ...latest,
    id: evaluationKey(latest) || latest.id || previous.id,
    firstEvaluatedAt: previous.firstEvaluatedAt || next.firstEvaluatedAt || previous.evaluatedAt || next.evaluatedAt || nowIso(),
    previousEvaluatedAt: older.evaluatedAt || older.lastSeenAt || null,
    lastSeenAt: latest.evaluatedAt || latest.lastSeenAt || nowIso(),
    evaluationCount: sameObservation
      ? Math.max(Number(previous.evaluationCount || 1), Number(next.evaluationCount || 1))
      : Number(previous.evaluationCount || 1) + Number(next.evaluationCount || 1),
    updateHistory: [...changeEntry, ...incomingHistory, ...previousHistory].slice(0, 30),
    lastChanges: changes,
  };
  return normalizeEvaluationRisk(merged);
}

function mergeEvaluationLists(primary = [], secondary = [], limit = MAX_HISTORY) {
  const byKey = new Map();
  const ordered = [...secondary, ...primary].sort((a, b) => evaluationUpdateTime(a) - evaluationUpdateTime(b));
  for (const item of ordered) {
    const key = evaluationKey(item);
    if (!key) continue;
    byKey.set(key, mergeEvaluation(byKey.get(key), item));
  }
  const deduplicated = new Map();
  for (const item of byKey.values()) {
    const binaryKey = binaryEvaluationMarketKey(item);
    if (!binaryKey) {
      deduplicated.set(`evaluation:${evaluationKey(item)}`, item);
      continue;
    }
    const previous = deduplicated.get(binaryKey);
    const itemIsPendingRetry = item.selectionStatus === "AI_PENDING" || item.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
    const previousIsPendingRetry = previous?.selectionStatus === "AI_PENDING" || previous?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
    const previousHasMemo = hasStoredGroundedPublicMemo(previous);
    const itemHasMemo = hasStoredGroundedPublicMemo(item);
    if (previousHasMemo && itemIsPendingRetry) continue;
    if (!previous
      || (itemHasMemo && previousIsPendingRetry)
      || evaluationUpdateTime(item) > evaluationUpdateTime(previous)
      || (evaluationUpdateTime(item) === evaluationUpdateTime(previous) && Number(item.aiProbability || 0) > Number(previous.aiProbability || 0))) {
      deduplicated.set(binaryKey, item);
    }
  }
  return [...deduplicated.values()]
    .sort((a, b) => evaluationUpdateTime(b) - evaluationUpdateTime(a))
    .slice(0, limit);
}

function cleanEvaluationErrorMessage(message) {
  return String(message || "")
    .replace(/^Orderbook fetch failed:\s*/i, "")
    .replace(/^Polymarket CLOB orderbook fetch failed:\s*/i, "")
    .trim();
}

function inferEvaluationErrorDetails(item = {}) {
  const reasons = Array.isArray(item.rejectReasons)
    ? item.rejectReasons.map(cleanEvaluationErrorMessage).filter(Boolean)
    : [];
  const rawMessage = cleanEvaluationErrorMessage(item.rawErrorMessage || item.errorReason || reasons[0] || item.analysisSummary || "");
  const joined = `${item.errorType || ""} ${rawMessage} ${item.analysisSummary || ""}`;
  const tokenNote = item.tokenId ? ` token_id ${item.tokenId}.` : "";

  if (/CLOB_ORDERBOOK_NOT_FOUND|HTTP 404|\/book\?token_id=|orderbook.*not found/i.test(joined)) {
    return {
      errorType: "CLOB_ORDERBOOK_NOT_FOUND",
      errorReason: `Polymarket CLOB returned HTTP 404 for${tokenNote || " the market token."} The token is likely closed, stale, migrated, or not currently exposed by the CLOB orderbook.`,
    };
  }

  if (/orderbook|clob|book\?/i.test(joined)) {
    return {
      errorType: item.errorType || "ORDERBOOK_FETCH_FAILED",
      errorReason: `Polymarket CLOB orderbook fetch failed for${tokenNote || " the market token."} ${rawMessage || "No detailed exchange error was returned."}`.trim(),
    };
  }

  return {
    errorType: item.errorType || "EVALUATION_ERROR",
    errorReason: rawMessage || "Unknown evaluation error.",
  };
}

function ensureEvaluationErrorMetadata(item = {}) {
  if (String(item.status || "").toUpperCase() !== "ERROR") return item;
  const details = inferEvaluationErrorDetails(item);
  const errorType = item.errorType || details.errorType;
  const errorReason = item.errorReason || details.errorReason;
  const rejectReasons = [...new Set([
    errorReason,
    ...(Array.isArray(item.rejectReasons) ? item.rejectReasons : []),
  ].filter(Boolean))];

  return {
    ...item,
    errorType,
    errorReason,
    rejectReasons,
    analysisSummary: item.analysisSummary || `Evaluation error: ${errorReason}`,
  };
}

function expirePastEvaluations(evaluations = []) {
  return evaluations.map((item) => {
    const status = String(item.status || "").toUpperCase();
    const end = Date.parse(item.endDate || "");
    if (status === "ERROR" || status === "RESOLVED" || !Number.isFinite(end) || end > Date.now()) return item;

    const rejectReasons = Array.isArray(item.rejectReasons) ? [...item.rejectReasons] : [];
    if (!rejectReasons.some((reason) => /end date|past|closed|accepting orders/i.test(String(reason || "")))) {
      rejectReasons.unshift("event end date is in the past; awaiting resolution sync");
    }
    const changedAt = nowIso();
    const changes = changedEvaluationFields(item, { ...item, status: "RESOLVED", rejectReasons });
    return {
      ...item,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: item.resolutionStatus || "PENDING_RESULT",
      rejectReasons,
      lastSeenAt: item.lastSeenAt || changedAt,
      lastChanges: changes,
      updateHistory: [
        {
          changedAt,
          previousEvaluatedAt: item.evaluatedAt || item.lastSeenAt || null,
          changes: changes.length ? changes : [{ field: "status", from: status || "ELIGIBLE", to: "RESOLVED" }],
        },
        ...(Array.isArray(item.updateHistory) ? item.updateHistory : []),
      ].slice(0, 30),
    };
  });
}

function evaluationResolutionSlug(item) {
  return String(item?.slug || item?.eventSlug || "").trim();
}

function resolutionSyncPriority(item) {
  if (item?.finalOutcomePrice != null && item?.marketClosed !== true) return 0;
  const end = Date.parse(item?.endDate || "");
  const checked = Date.parse(item?.resolutionCheckedAt || "");
  const ageHours = Number.isFinite(checked) ? (Date.now() - checked) / 3600000 : Infinity;
  const days = Number.isFinite(end) ? (end - Date.now()) / 86400000 : Infinity;
  if (days <= 0) return 0;
  if (ageHours < 6) return 9;
  if (days <= 2) return 1;
  if (days <= 7) return 2;
  return 5;
}

function withEvaluationResolutionUpdate(item, patch, reason, checkedAt = nowIso()) {
  const rejectReasons = Array.isArray(item.rejectReasons) ? [...item.rejectReasons] : [];
  if (reason && !rejectReasons.some((entry) => String(entry || "") === reason)) {
    rejectReasons.unshift(reason);
  }
  const next = normalizeEvaluationRisk({
    ...item,
    ...patch,
    rejectReasons,
    lastSeenAt: checkedAt,
    resolutionCheckedAt: checkedAt,
  });
  const changes = changedEvaluationFields(item, next);
  return {
    ...next,
    lastChanges: changes,
    updateHistory: [
      {
        changedAt: checkedAt,
        previousEvaluatedAt: item.evaluatedAt || item.lastSeenAt || null,
        changes: changes.length ? changes : [{ field: "resolutionCheckedAt", from: item.resolutionCheckedAt || null, to: checkedAt }],
      },
      ...(Array.isArray(item.updateHistory) ? item.updateHistory : []),
    ].slice(0, 30),
  };
}

function resolvedEvaluationFromMarket(item, market, checkedAt = nowIso()) {
  const outcomeIndex = outcomeIndexForTrade(market, item);
  const prices = parseOutcomePrices(market);
  const resolvedPrice = outcomeIndex >= 0 ? prices[outcomeIndex] : null;
  const dateContext = marketDateContext({ ...market, resolutionEndDate: market.endDate || item.resolutionEndDate || item.endDate || null }, item.evaluatedAt || item.firstEvaluatedAt);
  const endDate = dateContext.endDate;
  const remainingDays = endDate ? daysToEnd(endDate) : null;
  const patch = {
    question: market.question || item.question,
    slug: market.slug || item.slug || "",
    eventSlug: marketEventSlug(market) || item.eventSlug || "",
    endDate,
    daysToResolution: remainingDays == null ? item.daysToResolution ?? null : Number(remainingDays.toFixed(2)),
    marketClosed: typeof market.closed === "boolean" ? market.closed : item.marketClosed ?? null,
    marketActive: typeof market.active === "boolean" ? market.active : item.marketActive ?? null,
    acceptingOrders: typeof market.acceptingOrders === "boolean" ? market.acceptingOrders : item.acceptingOrders ?? null,
    closedTime: market.closedTime || item.closedTime || null,
    umaResolutionStatus: market.umaResolutionStatus || item.umaResolutionStatus || null,
    finalOutcomePrice: market.closed && Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : null,
  };

  if (market.closed) {
    return withEvaluationResolutionUpdate(item, {
      ...patch,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: Number.isFinite(resolvedPrice) ? "FINAL_PRICE_AVAILABLE" : "PENDING_RESULT",
    }, "Polymarket market is closed; no longer selectable for new trades", checkedAt);
  }

  if (market.acceptingOrders === false) {
    return withEvaluationResolutionUpdate(item, {
      ...patch,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: "NOT_ACCEPTING_ORDERS",
    }, "Polymarket market is no longer accepting orders; excluded from active evaluated opportunities", checkedAt);
  }

  if (dateContext.sportsEventStarted) {
    return withEvaluationResolutionUpdate(item, {
      ...patch,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: "PENDING_RESULT",
    }, "scheduled sports event has started; awaiting official Polymarket resolution", checkedAt);
  }

  if (remainingDays != null && remainingDays <= 0) {
    return withEvaluationResolutionUpdate(item, {
      ...patch,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: "PENDING_RESULT",
    }, "event end date is in the past; awaiting resolution sync", checkedAt);
  }

  return withEvaluationResolutionUpdate(item, patch, "", checkedAt);
}

async function refreshStoredEvaluationResolutionStatuses(evaluations = []) {
  const refreshable = evaluations
    .map((item, index) => ({ item, index, status: String(item.status || "").toUpperCase(), slug: evaluationResolutionSlug(item) }))
    .filter(({ status, slug }) => slug && status !== "ERROR" && status !== "RESOLVED")
    .sort((a, b) => resolutionSyncPriority(a.item) - resolutionSyncPriority(b.item))
    .slice(0, Math.max(0, EVALUATION_RESOLUTION_SYNC_LIMIT));
  if (!refreshable.length) return evaluations;

  const next = [...evaluations];
  // Each entry writes only its own index, so overlapping the lookups changes nothing
  // about the result -- only how long the whole batch takes.
  await mapWithConcurrency(refreshable, async (entry) => {
    const checkedAt = nowIso();
    try {
      const market = await fetchMarketBySlug(entry.slug);
      if (!market) {
        next[entry.index] = withEvaluationResolutionUpdate(entry.item, {
          marketUrlStatus: "not_found",
        }, "Polymarket market slug was not found during resolution sync", checkedAt);
        return;
      }
      next[entry.index] = resolvedEvaluationFromMarket(entry.item, market, checkedAt);
    } catch (error) {
      next[entry.index] = {
        ...entry.item,
        resolutionCheckedAt: checkedAt,
        resolutionCheckError: error?.message || String(error || "Unknown resolution sync error"),
      };
    }
  });
  return next;
}

function marketObservationResolutionSlug(item) {
  return String(item?.slug || item?.eventSlug || "").trim();
}

function marketObservationResolutionSyncPriority(item) {
  if (finalOutcomePriceValue(item?.finalOutcomePrice) != null) return Infinity;
  const status = String(item?.status || item?.selectionStatus || "").toUpperCase();
  const checkedAt = Date.parse(item?.resolutionCheckedAt || "");
  const checkedAgeHours = Number.isFinite(checkedAt) ? (Date.now() - checkedAt) / 3600000 : Infinity;
  const endAt = Date.parse(item?.scheduledEventDate || item?.resolutionEndDate || item?.endDate || "");
  const pastScheduledResolution = Number.isFinite(endAt) && endAt <= Date.now();
  const marketEnded = item?.marketClosed === true || item?.acceptingOrders === false;

  // A record may still be marked SCRAPED when Polymarket closes it between
  // scans. Treat every matured record as a resolution candidate, not only
  // rows that a previous scan already labelled RESOLVED.
  if (marketEnded) return 0;
  if (status === "RESOLVED") return checkedAgeHours >= 1 ? 1 : 8;
  if (pastScheduledResolution) return checkedAgeHours >= 1 ? 2 : 9;
  return Infinity;
}

function resolvedMarketObservationFromMarket(item, market, checkedAt = nowIso()) {
  const outcome = item.firstOutcome || item.outcome;
  const tokenId = item.firstTokenId || item.tokenId;
  const outcomeIndex = outcomeIndexForTrade(market, { outcome, tokenId });
  const prices = parseOutcomePrices(market);
  const resolvedPrice = outcomeIndex >= 0 ? prices[outcomeIndex] : null;
  const dateContext = marketDateContext({ ...market, resolutionEndDate: market.endDate || item.resolutionEndDate || item.endDate || null }, item.firstObservedAt || item.observedAt);
  const endDate = dateContext.endDate;
  const resolvedVolumeUsdc = marketVolumeSnapshotUsdc(market);
  const resolvedVolume24hr = Number(market.volume24hr);
  const ended = Boolean(market.closed) || market.acceptingOrders === false;
  if (!ended) {
    return {
      ...item,
      question: market.question || item.question,
      endDate,
      scheduledEventDate: dateContext.scheduledEventDate,
      resolutionEndDate: dateContext.resolutionEndDate,
      endDateSource: dateContext.endDateSource,
      marketClosed: typeof market.closed === "boolean" ? market.closed : item.marketClosed ?? null,
      acceptingOrders: typeof market.acceptingOrders === "boolean" ? market.acceptingOrders : item.acceptingOrders ?? null,
      resolutionCheckedAt: checkedAt,
    };
  }
  return withFirstObservationMetadata({
    ...item,
    question: market.question || item.question,
    slug: market.slug || item.slug || "",
    eventSlug: marketEventSlug(market) || item.eventSlug || "",
    endDate,
    scheduledEventDate: dateContext.scheduledEventDate,
    resolutionEndDate: dateContext.resolutionEndDate,
    endDateSource: dateContext.endDateSource,
    marketClosed: typeof market.closed === "boolean" ? market.closed : item.marketClosed ?? null,
    acceptingOrders: typeof market.acceptingOrders === "boolean" ? market.acceptingOrders : item.acceptingOrders ?? null,
    closedTime: market.closedTime || item.closedTime || null,
    // Preserve both measurement points. The first snapshot evaluates what was
    // tradable on discovery; this one describes the market when it resolved.
    resolvedVolumeUsdc: resolvedVolumeUsdc == null ? item.resolvedVolumeUsdc ?? null : resolvedVolumeUsdc,
    resolvedVolume24hr: Number.isFinite(resolvedVolume24hr)
      ? Number(resolvedVolume24hr.toFixed(2))
      : item.resolvedVolume24hr ?? null,
    finalOutcomePrice: market.closed && Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : item.finalOutcomePrice ?? null,
    resolutionStatus: market.closed && Number.isFinite(resolvedPrice) ? "FINAL_PRICE_AVAILABLE" : (market.acceptingOrders === false ? "NOT_ACCEPTING_ORDERS" : "PENDING_RESULT"),
    status: "RESOLVED",
    selectionStatus: "RESOLVED",
    resolvedAt: item.resolvedAt || market.closedTime || endDate || checkedAt,
    resolvedDetectedAt: checkedAt,
    resolutionCheckedAt: checkedAt,
  });
}

async function refreshStoredMarketObservationResolutionStatuses(observations = []) {
  const refreshable = observations
    .map((item, index) => ({
      item,
      index,
      slug: marketObservationResolutionSlug(item),
      priority: marketObservationResolutionSyncPriority(item),
    }))
    .filter(({ item, slug }) => {
      return Boolean(slug) && Number.isFinite(marketObservationResolutionSyncPriority(item));
    })
    .sort((a, b) => a.priority - b.priority
      || (Date.parse(a.item.scheduledEventDate || a.item.endDate || "") || 0) - (Date.parse(b.item.scheduledEventDate || b.item.endDate || "") || 0))
    .slice(0, Math.max(0, SCRAPED_SIMULATION_RESOLUTION_SYNC_LIMIT));
  if (!refreshable.length) return observations;

  const next = [...observations];
  await mapWithConcurrency(refreshable, async (entry) => {
    const checkedAt = nowIso();
    try {
      const market = await fetchMarketBySlug(entry.slug);
      if (market) next[entry.index] = resolvedMarketObservationFromMarket(entry.item, market, checkedAt);
    } catch {
      next[entry.index] = { ...entry.item, resolutionCheckedAt: checkedAt };
    }
  });
  return next;
}

function mergeTrade(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const closedStatuses = new Set(["WON", "LOST", "CLOSED", "CANCELLED", "CANCELED", "STOP_LOSS", "STOP_GAP"]);
  const existingClosed = closedStatuses.has(String(existing.status || "").toUpperCase());
  const incomingClosed = closedStatuses.has(String(incoming.status || "").toUpperCase());
  if (incomingClosed && !existingClosed) return incoming;
  if (existingClosed && !incomingClosed) return existing;
  return tradeUpdateTime(incoming) >= tradeUpdateTime(existing) ? incoming : existing;
}

function retainPaperTrades(trades = []) {
  const active = [];
  const closed = [];
  for (const trade of Array.isArray(trades) ? trades : []) {
    const status = String(trade?.status || "OPEN").toUpperCase();
    (["WON", "LOST", "CLOSED", "CANCELLED", "CANCELED", "STOP_LOSS", "STOP_GAP", "LIMIT_ORDER_EXPIRED"].includes(status) ? closed : active).push(trade);
  }
  return [
    ...active,
    ...closed.sort((a, b) => tradeUpdateTime(b) - tradeUpdateTime(a)).slice(0, PAPER_CLOSED_TRADE_HISTORY_LIMIT),
  ].sort((a, b) => tradeUpdateTime(b) - tradeUpdateTime(a));
}

function isoOrNull(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeCadence(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    lastRunAt: isoOrNull(source.lastRunAt),
    lastScanAt: isoOrNull(source.lastScanAt),
    lastReportAt: isoOrNull(source.lastReportAt),
    lastFullAt: isoOrNull(source.lastFullAt),
    lastStage: typeof source.lastStage === "string" && source.lastStage ? source.lastStage : null,
  };
}

function mergeCadence(primary, secondary) {
  const a = normalizeCadence(primary);
  const b = normalizeCadence(secondary);
  const later = (left, right) => {
    if (!left) return right;
    if (!right) return left;
    return Date.parse(left) >= Date.parse(right) ? left : right;
  };
  const lastRunAt = later(a.lastRunAt, b.lastRunAt);
  return {
    lastRunAt,
    lastScanAt: later(a.lastScanAt, b.lastScanAt),
    lastReportAt: later(a.lastReportAt, b.lastReportAt),
    lastFullAt: later(a.lastFullAt, b.lastFullAt),
    lastStage: lastRunAt && lastRunAt === a.lastRunAt ? a.lastStage : b.lastStage,
  };
}

function minutesSinceIso(value, now = Date.now()) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return Infinity;
  return (now - time) / 60000;
}

// A full pass also recalculates the report, and every pass refreshes the scraped
// catalogue, so satisfying a later stage implicitly satisfies the earlier ones.
function markCadenceStage(state, stage) {
  const at = state.generatedAt || nowIso();
  const cadence = normalizeCadence(state.cadence);
  cadence.lastRunAt = at;
  cadence.lastStage = stage;
  cadence.lastScanAt = at;
  if (stage === "report" || stage === "full") cadence.lastReportAt = at;
  if (stage === "full") cadence.lastFullAt = at;
  state.cadence = cadence;
  return state;
}

// Decide what a scheduled tick should do. Overdue portfolio execution always wins
// over a report, and a report wins over another catalogue-only scan.
// Which paper portfolios are holding capital they could actually deploy right now.
//
// The numbers are the ones the previous run published, which is exactly the signal
// wanted: capital that has been sitting idle since then. A whole stake has to be fundable
// -- below that, executePortfolio reports insufficient capital and a forced pass buys
// nothing, so it would only cost work.
function portfoliosWithDeployableCapital(state) {
  const portfolios = state?.paperPortfolios && typeof state.paperPortfolios === "object"
    ? state.paperPortfolios
    : {};
  const ready = [];
  for (const strategy of Object.values(PAPER_STRATEGIES)) {
    // An archived portfolio is never executed, so its free capital is not a reason to
    // bring a pass forward. Its stored rows are still maintained everywhere else.
    if (paperStrategyIsArchived(strategy)) continue;
    const portfolio = portfolios[strategy.id]?.portfolio;
    if (!portfolio) continue;
    const free = Number(portfolio.freeCapitalUsdc);
    const stake = Number(portfolio.maxStakeUsdc);
    if (Number.isFinite(free) && Number.isFinite(stake) && stake > 0 && free + 0.000001 >= stake) {
      ready.push(strategy.id);
    }
  }
  return ready;
}

function resolveScheduledCadence(state) {
  const cadence = normalizeCadence(state.cadence);
  const fullAgeMinutes = minutesSinceIso(cadence.lastFullAt);
  if (fullAgeMinutes >= FULL_CADENCE_MINUTES) {
    return { stage: "full", scanOnly: false, reportOnly: false, fullAgeMinutes };
  }
  // Only a full pass executes a portfolio, so a portfolio holding a fundable stake was
  // left idle for the rest of the cadence -- up to FULL_CADENCE_MINUTES of doing nothing
  // with capital that had somewhere to go. Free capital now brings the pass forward.
  // The floor keeps consecutive ticks from each running a full pass: without it, a
  // portfolio that stays funded (no eligible candidate to spend it on) would turn every
  // scheduled tick into the expensive stage.
  const capitalReadyPortfolios = portfoliosWithDeployableCapital(state);
  if (capitalReadyPortfolios.length && fullAgeMinutes >= IDLE_CAPITAL_FULL_PASS_MIN_MINUTES) {
    return {
      stage: "full",
      scanOnly: false,
      reportOnly: false,
      fullAgeMinutes,
      capitalReadyPortfolios,
      broughtForwardByCapital: true,
    };
  }
  const reportAgeMinutes = minutesSinceIso(cadence.lastReportAt);
  if (reportAgeMinutes >= REPORT_CADENCE_MINUTES) {
    return { stage: "report", scanOnly: false, reportOnly: true, fullAgeMinutes, reportAgeMinutes, capitalReadyPortfolios };
  }
  return { stage: "scan", scanOnly: true, reportOnly: false, fullAgeMinutes, reportAgeMinutes, capitalReadyPortfolios };
}

function mergeStates(primary, secondary) {
  const base = stateTime(primary) >= stateTime(secondary) ? primary : secondary;
  const other = base === primary ? secondary : primary;
  const merged = {
    ...base,
    evaluations: mergeEvaluationLists(base.evaluations || [], other.evaluations || []),
    marketObservations: mergeMarketObservationLists(base.marketObservations || [], other.marketObservations || []),
    marketScan: stateTime(base) >= stateTime(other) ? normalizeMarketScan(base.marketScan) : normalizeMarketScan(other.marketScan),
    marketScanHistory: mergeUniqueById(
      [...(base.marketScanHistory || []), ...(other.marketScanHistory || [])],
      (item) => item.runAt || item.id || "",
      MARKET_SCAN_HISTORY_LIMIT,
    ).sort((a, b) => (Date.parse(b.runAt || "") || 0) - (Date.parse(a.runAt || "") || 0)),
    evaluationRunLog: mergeUniqueById([...(base.evaluationRunLog || []), ...(other.evaluationRunLog || [])], (item) => item.runAt || item.id || "", EVALUATION_RUN_LOG_LIMIT),
    calculationReports: mergeUniqueById([...(base.calculationReports || []), ...(other.calculationReports || [])], (item) => item.id || item.generatedAt || "", CALCULATION_REPORT_HISTORY_LIMIT)
      .sort((a, b) => (Date.parse(b.generatedAt || "") || 0) - (Date.parse(a.generatedAt || "") || 0))
      .slice(0, CALCULATION_REPORT_HISTORY_LIMIT),
  };
  merged.latestCalculationReport = merged.calculationReports?.[0] || base.latestCalculationReport || other.latestCalculationReport || null;
  merged.paperPortfolioArchives = normalizePaperPortfolioArchives([
    ...(base.paperPortfolioArchives || []),
    ...(other.paperPortfolioArchives || []),
  ]);
  // Keep the furthest-advanced cadence from either side. A stale repository
  // snapshot must never move a cadence clock backwards and re-trigger a pass.
  merged.cadence = mergeCadence(base.cadence, other.cadence);
  merged.paperPortfolios = {};
  for (const strategy of Object.values(PAPER_STRATEGIES)) {
    const basePortfolio = base.paperPortfolios?.[strategy.id] || normalizePaperPortfolio(strategy, {});
    const otherPortfolio = other.paperPortfolios?.[strategy.id] || normalizePaperPortfolio(strategy, {});
    const baseResetAt = Date.parse(basePortfolio.resetAt || "") || 0;
    const otherResetAt = Date.parse(otherPortfolio.resetAt || "") || 0;
    // A reset starts a new account generation. Do not merge pre-reset trades
    // from a stale repository snapshot back into a freshly reset live state.
    const resetSource = baseResetAt !== otherResetAt
      ? (baseResetAt > otherResetAt ? basePortfolio : otherPortfolio)
      : null;
    const portfolioSources = resetSource ? [resetSource] : [otherPortfolio, basePortfolio];
    const tradesById = new Map();
    for (const source of portfolioSources) for (const trade of source.trades || []) {
      tradesById.set(trade.id, mergeTrade(tradesById.get(trade.id), trade));
    }
    merged.paperPortfolios[strategy.id] = {
      ...(resetSource || basePortfolio),
      trades: retainPaperTrades([...tradesById.values()]),
      runLog: mergeUniqueById(portfolioSources.flatMap((source) => source.runLog || []), (item) => `${item.runAt || ""}:${item.strategyId || strategy.id}`, PORTFOLIO_RUN_LOG_LIMIT),
    };
  }
  // Market scans and focused refreshes do not always load portfolio-config.json, so a
  // browser-created portfolio is unknown to PAPER_STRATEGIES in those processes. It
  // still belongs to the persisted state. Rebuilding merged.paperPortfolios from the
  // known strategy list alone used to erase its entire history whenever such a process
  // merged the hosted state with the checked-out seed file. Keep every unknown id and
  // merge its append-only records just like a configured portfolio. Only an explicit
  // archive/reset action is allowed to remove its active history.
  const knownStrategyIds = new Set(Object.keys(PAPER_STRATEGIES));
  const persistedPortfolioIds = new Set([
    ...Object.keys(base.paperPortfolios || {}),
    ...Object.keys(other.paperPortfolios || {}),
  ]);
  for (const id of persistedPortfolioIds) {
    if (knownStrategyIds.has(id)) continue;
    const basePortfolio = base.paperPortfolios?.[id];
    const otherPortfolio = other.paperPortfolios?.[id];
    if (!basePortfolio || typeof basePortfolio !== "object") {
      if (otherPortfolio && typeof otherPortfolio === "object") merged.paperPortfolios[id] = otherPortfolio;
      continue;
    }
    if (!otherPortfolio || typeof otherPortfolio !== "object") {
      merged.paperPortfolios[id] = basePortfolio;
      continue;
    }

    const tradesById = new Map();
    for (const source of [otherPortfolio, basePortfolio]) {
      for (const trade of source.trades || []) {
        tradesById.set(trade.id, mergeTrade(tradesById.get(trade.id), trade));
      }
    }
    const baseDecisionAt = Date.parse(basePortfolio.lastDecision?.runAt || "") || 0;
    const otherDecisionAt = Date.parse(otherPortfolio.lastDecision?.runAt || "") || 0;
    merged.paperPortfolios[id] = {
      ...otherPortfolio,
      ...basePortfolio,
      trades: retainPaperTrades([...tradesById.values()]),
      runLog: mergeUniqueById(
        [...(basePortfolio.runLog || []), ...(otherPortfolio.runLog || [])],
        (item) => `${item.runAt || ""}:${item.strategyId || id}`,
        PORTFOLIO_RUN_LOG_LIMIT,
      ),
      lastDecision: baseDecisionAt >= otherDecisionAt
        ? (basePortfolio.lastDecision || otherPortfolio.lastDecision || null)
        : (otherPortfolio.lastDecision || basePortfolio.lastDecision || null),
    };
  }
  syncLegacyPaperAliases(merged);
  return merged;
}

function syncLegacyPaperAliases(state) {
  const conservative = state.paperPortfolios?.conservative || normalizePaperPortfolio(PAPER_STRATEGIES.conservative, {});
  state.paperPortfolios ||= {};
  state.paperPortfolios.conservative = conservative;
  state.paperPortfolios.highReward ||= normalizePaperPortfolio(PAPER_STRATEGIES.highReward, {});
  state.paperPortfolios.moreProbable ||= normalizePaperPortfolio(PAPER_STRATEGIES.moreProbable, {});
  state.paperPortfolios.equal ||= normalizePaperPortfolio(PAPER_STRATEGIES.equal, {});
  state.portfolio = conservative.portfolio;
  state.trades = conservative.trades;
  state.lastTradeDate = conservative.lastTradeDate;
  state.lastTradeHour = conservative.lastTradeHour;
  state.lastDecision = conservative.lastDecision;
  state.runLog = conservative.runLog;
  return state;
}

function normalizeLearningProfile(profile = {}) {
  return {
    version: 1,
    updatedAt: profile.updatedAt || null,
    sampleSize: Number(profile.sampleSize || 0),
    brierScore: profile.brierScore != null && Number.isFinite(Number(profile.brierScore)) ? Number(profile.brierScore) : null,
    calibrationBias: profile.calibrationBias != null && Number.isFinite(Number(profile.calibrationBias)) ? Number(profile.calibrationBias) : 0,
    bucketCalibration: profile.bucketCalibration && typeof profile.bucketCalibration === "object" ? profile.bucketCalibration : {},
    factorAdjustments: profile.factorAdjustments && typeof profile.factorAdjustments === "object" ? profile.factorAdjustments : {},
    promptRules: Array.isArray(profile.promptRules) ? profile.promptRules : [],
    aiLastRun: profile.aiLastRun || null,
    aiModel: profile.aiModel || null,
    aiProvider: profile.aiProvider || null,
  };
}

function normalizeTrade(trade) {
  if (!trade || typeof trade !== "object") return trade;
  const risk = riskProfile({
    question: trade.question,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
    outcome: trade.outcome,
    tags: trade.tags,
  });
  const existingRiskKeys = Array.isArray(trade.riskGroupKeys) ? trade.riskGroupKeys : [];
  const existingRiskLabels = Array.isArray(trade.riskGroupLabels) ? trade.riskGroupLabels : [];
  const riskTargetUsdc = Number(trade.riskTargetUsdc ?? trade.netGainIfWinUsdc);
  const realizedPnlUsdc = Number(trade.realizedPnlUsdc);
  // Older Equal paper rows used the first bid below the sell floor as an exit
  // price. Reclassify them so the historical dashboard does not claim a stop
  // loss was successfully executed when its loss cap was missed.
  const historicalStopGap = Boolean(
    trade.equalRiskProtection
    && String(trade.status || "").toUpperCase() === "STOP_LOSS"
    && Number.isFinite(riskTargetUsdc)
    && riskTargetUsdc > 0
    && Number.isFinite(realizedPnlUsdc)
    && -realizedPnlUsdc > riskTargetUsdc + 0.00001
  );
  return {
    ...trade,
    status: historicalStopGap ? "STOP_GAP" : (trade.status || "OPEN"),
    totalCostUsdc: Number(trade.totalCostUsdc || trade.maxLossUsdc || trade.stakeUsdc || 0),
    aiAnalysis: trade.aiAnalysis || {
      model: trade.analysisModel || "legacy-paper-trade",
      thesis: trade.probabilityThesis || trade.analysisSummary || "",
      probability: Number.isFinite(Number(trade.aiProbability)) ? Number(trade.aiProbability) : null,
      rawProbability: Number.isFinite(Number(trade.rawProbability)) ? Number(trade.rawProbability) : null,
      confidenceTier: trade.thesisType || null,
    },
    probabilityThesis: trade.probabilityThesis || trade.aiAnalysis?.thesis || "",
    analysisSummary: trade.analysisSummary || trade.aiAnalysis?.thesis || "",
    riskGroupKeys: [...new Set([...existingRiskKeys, ...risk.keys])],
    riskGroupLabels: [...new Set([...existingRiskLabels, ...risk.labels])],
    ...(historicalStopGap ? {
      stopLossStatus: "GAP_BEYOND_TARGET",
      stopLossCapBreachUsdc: Number(((-realizedPnlUsdc) - riskTargetUsdc).toFixed(5)),
      statusNote: "Historical Equal paper stop was observed below its sell floor. This was a price gap, not a protected fill.",
    } : {}),
  };
}

function daysToEnd(endDate) {
  const end = Date.parse(endDate || "");
  if (!Number.isFinite(end)) return null;
  return (end - Date.now()) / 86400000;
}

function endDateIsFuture(endDate) {
  const end = Date.parse(endDate || "");
  return Number.isFinite(end) && end > Date.now();
}

function inferredEndDateFromQuestion(question, fallbackDate = null) {
  const match = String(question || "").match(/\b(?:by|on|before|through)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!match) return null;
  const months = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };
  const fallback = new Date(fallbackDate || Date.now());
  const year = Number(match[3]) || (Number.isFinite(fallback.getTime()) ? fallback.getUTCFullYear() : new Date().getUTCFullYear());
  const month = months[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (!Number.isInteger(month) || !Number.isFinite(day)) return null;
  const inferred = new Date(Date.UTC(year, month, day, 23, 59, 59));
  return Number.isFinite(inferred.getTime()) ? inferred.toISOString() : null;
}

function correctedEndDate(question, rawEndDate, fallbackDate = null) {
  const inferred = inferredEndDateFromQuestion(question, rawEndDate || fallbackDate);
  if (!inferred) return rawEndDate || null;
  const rawTime = Date.parse(rawEndDate || "");
  const inferredTime = Date.parse(inferred);
  if (!Number.isFinite(rawTime) || inferredTime > rawTime) return inferred;
  return rawEndDate || inferred;
}

const SPORTS_MARKET_HINT = /\b(atp|wta|nba|nfl|mlb|nhl|ufc|fifa|world[- ]cup|soccer|football|tennis|baseball|basketball|hockey|esports|e[- ]?sports|lol|match|game|tournament|spread|moneyline|winner)\b/i;

function isSportsMarket(market = {}) {
  const events = Array.isArray(market.events) ? market.events : [];
  const text = [
    market.slug,
    market.eventSlug,
    market.question,
    market.category,
    market.categorySlug,
    market.sportsMarketType,
    market.marketType,
    market.tags,
    ...events.flatMap((event) => [event?.slug, event?.title, event?.category, event?.categorySlug, event?.tags]),
  ].filter(Boolean).join(" ");
  return Boolean(
    market.gameStartTime
    || market.eventStartTime
    || market.gameId
    || market.sportsMarketType
    || market.teamAID
    || market.teamBID
    || SPORTS_MARKET_HINT.test(text),
  );
}

function parseSportsDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const date = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function sportsDateFromSlug(value) {
  const match = String(value || "").match(/(?:^|[-_])((?:19|20)\d{2})-(\d{2})-(\d{2})(?:$|[-_])/);
  if (!match) return null;
  return parseSportsDate(`${match[1]}-${match[2]}-${match[3]}`);
}

// Two very different things can come back here and callers must be able to tell them
// apart. A gameStartTime is an actual kickoff. A date recovered from a slug
// ("val-fpx-jdg-2026-08-06") is only the day the fixture belongs to, and parseSportsDate
// stretches it to 23:59:59 -- a whole-day bucket, not a time the match starts or ends.
// Treating the second as a kickoff kept finished matches looking open until end of day.
//
// event.startDate is a third thing and was dropped from the candidates below: on live
// "... nominee" and "By-Election Winner" markets (isSportsMarket true only because
// "winner" -- a normal word for a single-winner election -- is in SPORTS_MARKET_HINT, not
// because these are sports) it held an arbitrary timestamp unrelated to any real election
// date, while every other candidate here was empty. With nothing to outrank it, it was
// taken as a "precise" kickoff and silently overrode the market's correct, much later
// resolutionEndDate with a date months in the past.
function sportsScheduledEventDateDetail(market = {}) {
  if (!isSportsMarket(market)) return { date: null, precise: false };
  const events = Array.isArray(market.events) ? market.events : [];
  // A bare top-level gameStartTime is not on its own proof of a real kickoff. Live case:
  // "Elon Musk # tweets August 11 - August 18, 2026?" is not a sports market at all, but
  // Gamma still populates gameStartTime with the tracking window's *start* (the 11th),
  // with every other sports-only field -- gameId, sportsMarketType, eventStartTime,
  // teamAID/teamBID -- left blank. isSportsMarket came back true only because
  // gameStartTime itself is truthy, and with nothing to outrank it, the window's start
  // (already days in the past) was taken as a "precise" kickoff and silently overrode the
  // market's correct, still-days-away real end date. Every genuine fixture seen in
  // production (soccer, esports) carries at least one of these alongside gameStartTime;
  // require that corroboration before trusting it.
  const hasSportsFixtureSignal = Boolean(
    market.gameId || market.sportsMarketType || market.eventStartTime || market.teamAID || market.teamBID,
  );
  const candidates = [
    hasSportsFixtureSignal ? market.gameStartTime : null,
    market.eventStartTime,
    ...events.flatMap((event) => [event?.gameStartTime, event?.eventStartTime, event?.startDateIso]),
  ];
  for (const candidate of candidates) {
    const parsed = parseSportsDate(candidate);
    if (parsed) return { date: parsed, precise: true };
  }
  const fromSlug = sportsDateFromSlug(market.slug)
    || sportsDateFromSlug(market.eventSlug)
    || sportsDateFromSlug(events.find((event) => event?.slug)?.slug)
    || null;
  return { date: fromSlug, precise: false };
}

function sportsScheduledEventDate(market = {}, fallbackDate = null) {
  return sportsScheduledEventDateDetail(market).date;
}

function marketDateContext(market = {}, fallbackDate = null) {
  const rawResolutionEndDate = market.resolutionEndDate || market.endDate || null;
  const resolutionEndDate = correctedEndDate(market.question || "", rawResolutionEndDate, fallbackDate);
  const scheduled = sportsScheduledEventDateDetail(market);
  const scheduledEventDate = scheduled.date;
  const scheduledTime = Date.parse(scheduledEventDate || "");
  const resolutionTime = Date.parse(resolutionEndDate || "");
  // A kickoff that hasn't happened yet must win even when it falls after the market's
  // own resolution window: that window is sometimes a stale pre-reschedule estimate
  // (seen live on an exact-score market whose resolutionEndDate said 02:00 while
  // Polymarket's own event page still showed a ~2h countdown to an 18:30 kickoff), and
  // a game cannot be past resolution before it has actually been played.
  //
  // Only a real kickoff may do that. A slug-derived date is the whole day stretched to
  // 23:59:59, so it is "in the future" for the entire day it names -- letting it override
  // a real end date is what kept finished fixtures listed as candidates until 01:59 the
  // next morning. It stays a fallback for markets that have no usable end date at all.
  const scheduledIsFuture = scheduled.precise
    && Number.isFinite(scheduledTime)
    && scheduledTime > Date.now();
  const useScheduledDate = Boolean(scheduledEventDate)
    && (!Number.isFinite(resolutionTime) || (Number.isFinite(scheduledTime) && scheduledTime < resolutionTime) || scheduledIsFuture);
  const endDate = useScheduledDate ? scheduledEventDate : resolutionEndDate;
  return {
    endDate: endDate || null,
    scheduledEventDate: scheduledEventDate || null,
    resolutionEndDate: resolutionEndDate || null,
    endDateSource: useScheduledDate ? "sports-event-start" : "polymarket-resolution-window",
    sportsEventStarted: useScheduledDate && Number.isFinite(scheduledTime) && scheduledTime <= Date.now(),
  };
}

function normalizeStoredMarketObservationTiming(item = {}) {
  const context = marketDateContext(item, item.firstObservedAt || item.observedAt || item.marketDataUpdatedAt);
  if (!context.endDate && !context.scheduledEventDate && !context.resolutionEndDate) return item;
  return {
    ...item,
    endDate: context.endDate || item.endDate || null,
    scheduledEventDate: context.scheduledEventDate || item.scheduledEventDate || null,
    resolutionEndDate: item.resolutionEndDate || context.resolutionEndDate || null,
    endDateSource: context.endDateSource || item.endDateSource || null,
  };
}

function tagQuestion(question) {
  const text = String(question || "").toLowerCase();
  const tags = [];
  if (/\b(bitcoin|btc|ethereum|eth|crypto|solana|xrp)\b/.test(text)) tags.push("crypto");
  if (/\b(fed|rate|inflation|cpi|jobs|unemployment|gdp)\b/.test(text)) tags.push("macro");
  if (/\b(election|president|senate|congress|minister|vote|referendum)\b/.test(text)) tags.push("politics");
  if (/\b(nba|nfl|mlb|nhl|ufc|world cup|champions|match|game|tournament)\b/.test(text)) tags.push("sports");
  if (/\b(will|by|before|on|in 2026|in 2027)\b/.test(text)) tags.push("clear-resolution");
  return tags.length ? tags : ["general"];
}

function normalizeRiskText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function displayRiskName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function cleanTeamName(value) {
  let text = String(value || "")
    .replace(/\b(the|a|an)\b/gi, " ")
    .replace(/\b(on|in|at|by|before|after)\b.*$/i, " ")
    // A trailing " - <whatever>" is a descriptor -- a game number, a map, a round -- not
    // part of the name. "Team Spirit - Game 2 Winner" is the team "Team Spirit"; without
    // this, "Winner" alone got stripped below and left "Team Spirit - Game 2" behind.
    .replace(/\s+-\s+.*$/, " ")
    .replace(/\b(to advance|advance|win|wins|winner|draw|end)\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^will\s+/i, "").replace(/[?:,]+$/g, "").trim();
  return text;
}

function addTeam(teams, value) {
  const cleaned = cleanTeamName(value);
  const key = normalizeRiskText(cleaned);
  if (!key || key.length < 2) return;
  if (/^(yes|no|over|under|draw|other|none)$/.test(key)) return;
  teams.set(key, displayRiskName(cleaned));
}

// A short label before the fixture, consumed and discarded rather than captured: esports
// and league questions are consistently written "<Game or League>: TeamA vs TeamB - ...".
//
// Reported: "team:dota 2" was showing up as a risk key, correlating every Dota 2 match with
// every other one regardless of which teams were actually playing. "Dota 2: Team Yandex vs
// Team Spirit - Game 2 Winner" anchors its first capture group at the start of the string,
// so without this it captured "Dota 2: Team Yandex" whole -- and cleanTeamName used to strip
// "team" as filler, which (with no other rule bounding it) deleted "Team Yandex" outright and
// left the game's own title standing in as if it were a team. Consuming the label first means
// the capture starts at the real name instead.
const RISK_LEAGUE_LABEL_PREFIX = "(?:[^:?]{1,40}:\\s*)?";

function extractTeams(question) {
  const text = String(question || "");
  const teams = new Map();
  const patterns = [
    /^Exact Score:\s*(.+?)\s+\d+\s*-\s*\d+\s*(.+?)\?/i,
    new RegExp(`^${RISK_LEAGUE_LABEL_PREFIX}(.+?)\\s+vs\\.?\\s+(.+?)(?::|\\s+end\\b|\\s+go\\b|\\s+O\\/U\\b|\\?|$)`, "i"),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      addTeam(teams, match[1]);
      addTeam(teams, match[2]);
    }
  }

  const spread = text.match(/^Spread:\s*(.+?)\s*\(/i);
  if (spread) addTeam(teams, spread[1]);

  const winner = text.match(/^Will\s+(.+?)\s+win(?:\s+on\b|\s+the\b|\?|$)/i);
  if (winner && !/\bvs\.?\b/i.test(winner[1])) addTeam(teams, winner[1]);

  return teams;
}

function eventSlugKey(slug) {
  const text = normalizeRiskText(slug).replace(/\s+/g, "-");
  const dated = text.match(/^(.+?-\d{4}-\d{2}-\d{2})(?:-|$)/);
  return dated ? dated[1] : "";
}

function topicRiskClusters({ question, slug, eventSlug }) {
  const text = normalizeRiskText(`${question || ""} ${slug || ""} ${eventSlug || ""}`);
  const clusters = [];
  const cryptoAssets = [
    { key: "bitcoin", label: "Bitcoin", pattern: /\b(bitcoin|btc)\b/ },
    { key: "ethereum", label: "Ethereum", pattern: /\b(ethereum|ether|eth)\b/ },
    { key: "solana", label: "Solana", pattern: /\bsolana\b/ },
    { key: "xrp", label: "XRP", pattern: /\b(xrp|ripple)\b/ },
  ];
  for (const asset of cryptoAssets) {
    if (asset.pattern.test(text)) {
      clusters.push([`topic:${asset.key}`, `Topic: ${asset.label}`]);
    }
  }
  if (/\b(iran|iranian|hormuz|kharg|strait of hormuz|israel|israeli|tehran|nuclear)\b/.test(text)) {
    clusters.push(["topic:iran-war", "Topic: Iran war / Gulf escalation"]);
  }
  if (/\b(fed|federal reserve|interest rates?|rate cut|rate hike|bps|fomc)\b/.test(text)) {
    const month = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/)?.[1] || "meeting";
    const year = text.match(/\b(20\d{2})\b/)?.[1] || "";
    clusters.push([`topic:fed-${month}${year ? `-${year}` : ""}`, `Topic: Fed ${month}${year ? ` ${year}` : ""} meeting`]);
  }
  return clusters;
}

function riskProfile({ question, slug, eventSlug, outcome, tags }) {
  const keys = new Set();
  const labels = new Map();
  const addKey = (key, label) => {
    if (!key) return;
    keys.add(key);
    if (label) labels.set(key, label);
  };

  const normalizedSlug = normalizeRiskText(slug).replace(/\s+/g, "-");
  if (normalizedSlug) addKey(`market:${normalizedSlug}`, `Market: ${normalizedSlug}`);

  const normalizedEventSlug = normalizeRiskText(eventSlug).replace(/\s+/g, "-");
  if (normalizedEventSlug) addKey(`event:${normalizedEventSlug}`, `Event: ${normalizedEventSlug}`);
  const eventKey = eventSlugKey(eventSlug || slug);
  if (eventKey) addKey(`event:${eventKey}`, `Event: ${eventKey}`);
  for (const [key, label] of topicRiskClusters({ question, slug, eventSlug })) addKey(key, label);

  const teams = extractTeams(question);
  for (const [teamKey, label] of teams) {
    addKey(`team:${teamKey}`, `Team: ${label}`);
  }

  if (teams.size >= 2) {
    const pair = [...teams.keys()].sort().join("-vs-");
    const pairLabel = [...teams.values()].sort().join(" vs ");
    addKey(`match:${pair}`, `Match: ${pairLabel}`);
  }

  const tagList = Array.isArray(tags) ? tags : tagQuestion(question);
  return {
    keys: [...keys],
    labels: [...keys].map((key) => labels.get(key) || key),
    category: tagList.includes("sports") ? "sports" : tagList[0] || "general",
    primaryEntity: [...teams.values()][0] || String(outcome || ""),
  };
}

function marketEventSlug(market) {
  const events = Array.isArray(market.events) ? market.events : [];
  const eventSlug = events.find((event) => event?.slug)?.slug;
  return eventSlug || market.eventSlug || market.slug || "";
}

function bestBook(book) {
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const bidPrices = bids.map((level) => Number(level.price)).filter(Number.isFinite);
  const askPrices = asks.map((level) => Number(level.price)).filter(Number.isFinite);
  const bestBid = bidPrices.length ? Math.max(...bidPrices) : null;
  const bestAsk = askPrices.length ? Math.min(...askPrices) : null;
  return {
    bestBid,
    bestAsk,
    spread: bestBid != null && bestAsk != null ? Math.max(0, bestAsk - bestBid) : null,
    askDepth: asks.slice(0, 5).reduce((sum, level) => sum + Number(level.size || 0), 0),
    asks,
  };
}

function simulateMarketBuy(asks, stakeUsdc) {
  const levels = asks
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
    .sort((a, b) => a.price - b.price);

  let remaining = stakeUsdc;
  let cost = 0;
  let shares = 0;
  const fills = [];

  for (const level of levels) {
    if (remaining <= 0) break;
    const levelCost = level.price * level.size;
    const costAtLevel = Math.min(remaining, levelCost);
    const sizeAtLevel = costAtLevel / level.price;
    cost += costAtLevel;
    shares += sizeAtLevel;
    remaining -= costAtLevel;
    fills.push({
      price: Number(level.price.toFixed(4)),
      size: Number(sizeAtLevel.toFixed(4)),
      costUsdc: Number(costAtLevel.toFixed(4)),
    });
  }

  const avgPrice = shares > 0 ? cost / shares : null;
  const bestAsk = levels[0]?.price ?? null;
  const depthUsdc = levels.reduce((sum, level) => sum + level.price * level.size, 0);

  return {
    requestedUsdc: Number(stakeUsdc.toFixed(2)),
    filledUsdc: Number(cost.toFixed(4)),
    fillable: cost >= stakeUsdc * 0.999,
    shares: Number(shares.toFixed(4)),
    avgPrice: avgPrice == null ? null : Number(avgPrice.toFixed(4)),
    bestAsk: bestAsk == null ? null : Number(bestAsk.toFixed(4)),
    slippage: avgPrice != null && bestAsk != null ? Number((avgPrice - bestAsk).toFixed(4)) : null,
    depthUsdc: Number(depthUsdc.toFixed(4)),
    fills: fills.slice(0, 8),
  };
}

function feeConfig(market) {
  const schedule = market.feeSchedule && typeof market.feeSchedule === "object" ? market.feeSchedule : {};
  // Revalidation rebuilds a minimal market object from the stored opportunity. That
  // object retains feeRate, but does not need to retain Gamma's full feeSchedule.
  // Prefer the live schedule and fall back to the persisted per-market rate so a
  // revalidated fee market cannot accidentally become fee-free in paper trading.
  const scheduledRate = Number(schedule.rate);
  const storedRate = Number(market.feeRate);
  const rate = Number.isFinite(scheduledRate) && scheduledRate > 0 ? scheduledRate : storedRate;
  const enabled = Boolean(market.feesEnabled) && Number.isFinite(rate) && rate > 0;
  return {
    feesEnabled: enabled,
    feeRate: enabled ? rate : 0,
    feeType: market.feeType || (enabled ? "unknown" : "fee_free"),
    takerOnly: schedule.takerOnly !== false,
  };
}

function takerFeeForFills(fills, feeRate) {
  if (!Number.isFinite(feeRate) || feeRate <= 0) return 0;
  const fee = fills.reduce((sum, fill) => {
    const size = Number(fill.size);
    const price = Number(fill.price);
    if (!Number.isFinite(size) || !Number.isFinite(price)) return sum;
    return sum + size * feeRate * price * (1 - price);
  }, 0);
  return Number(fee.toFixed(5));
}

function netExitValueAtPrice({ shares, price, feeRate = 0, feesEnabled = true } = {}) {
  const size = Number(shares);
  const exitPrice = Number(price);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(exitPrice) || exitPrice < 0 || exitPrice > 1) return null;
  const gross = size * exitPrice;
  const fee = feesEnabled ? takerFeeForFills([{ size, price: exitPrice }], Number(feeRate) || 0) : 0;
  return Number((gross - fee).toFixed(5));
}

// Equal caps the planned loss at a configurable multiple of the net gain on a
// winning resolution. The exit fee is price dependent, therefore a bounded search
// is safer than duplicating a hand-derived fee equation elsewhere in the trading logic.
function equalRiskStopPlan({ totalCostUsdc, netGainIfWinUsdc, shares, entryPrice, feeRate = 0, feesEnabled = true, riskMultiplier = 1 } = {}) {
  const cost = Number(totalCostUsdc);
  const reward = Number(netGainIfWinUsdc);
  const size = Number(shares);
  const entry = Number(entryPrice);
  const multiplier = normalizeStopLossRiskMultiplier(riskMultiplier, 1);
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(reward) || reward <= 0 || multiplier <= 0 || !Number.isFinite(size) || size <= 0 || !Number.isFinite(entry) || entry <= 0 || entry >= 1) {
    return { protectable: false, reason: "missing valid entry economics" };
  }
  const riskTarget = Number(Math.min(cost, reward * multiplier).toFixed(5));
  if (riskTarget >= cost) {
    return {
      protectable: true,
      requiresStop: false,
      costUsdc: Number(cost.toFixed(5)),
      riskTargetUsdc: Number(cost.toFixed(5)),
      stopLossRiskMultiplier: Number(multiplier.toFixed(2)),
      minimumExitValueUsdc: 0,
      stopPrice: null,
    };
  }

  const minimumExitValueUsdc = Number((cost - riskTarget).toFixed(5));
  const entryExitValue = netExitValueAtPrice({ shares: size, price: entry, feeRate, feesEnabled });
  if (!Number.isFinite(entryExitValue) || entryExitValue < minimumExitValueUsdc) {
    return { protectable: false, reason: "entry cannot support the required net-loss boundary" };
  }

  let low = 0;
  let high = entry;
  for (let index = 0; index < 48; index += 1) {
    const mid = (low + high) / 2;
    const exitValue = netExitValueAtPrice({ shares: size, price: mid, feeRate, feesEnabled });
    if (exitValue != null && exitValue >= minimumExitValueUsdc) high = mid;
    else low = mid;
  }
  return {
    protectable: true,
    requiresStop: true,
    costUsdc: Number(cost.toFixed(5)),
    riskTargetUsdc: riskTarget,
    stopLossRiskMultiplier: Number(multiplier.toFixed(2)),
    minimumExitValueUsdc,
    stopPrice: Number(high.toFixed(5)),
  };
}

function equalRiskEntryProtection({ plan, bestBid, shares, feeRate = 0, feesEnabled = true } = {}) {
  if (!plan?.protectable) return { eligible: false, reason: plan?.reason || "missing valid stop plan" };
  if (!plan.requiresStop) return { eligible: true, reason: null };
  const bid = Number(bestBid);
  if (!Number.isFinite(bid) || bid <= 0) {
    return { eligible: false, reason: "no executable bid is available for the Equal protective exit" };
  }
  const exitValueUsdc = netExitValueAtPrice({ shares, price: bid, feeRate, feesEnabled });
  if (!Number.isFinite(exitValueUsdc) || bid + 0.000001 < Number(plan.stopPrice)) {
    return {
      eligible: false,
      reason: `current bid ${(bid * 100).toFixed(1)}% is below Equal stop floor ${(Number(plan.stopPrice) * 100).toFixed(1)}%`,
    };
  }
  return { eligible: true, reason: null, exitValueUsdc };
}

// What the stop is worth depends entirely on the price it exits at, and paper was booking
// the wrong one.
//
// Reported: the Equal portfolio ends every trade on an enormous STOP_GAP, practically the
// size of the whole position. Measured on its own numbers -- a 5.00 USDC entry at 0.95
// caps its planned loss at the 0.2632 USDC win, which puts the stop floor at 0.9000, a
// five-point band. A near-certain outcome that turns against you does not sit inside that
// band waiting to be looked at; it collapses. So every poll observed a bid of 0.05 or
// 0.01, booked the exit *there*, and recorded a 4.74 USDC loss against a 0.26 target --
// eighteen times the cap, on every trade.
//
// The live side does not work that way. The RPi exit worker polls every five seconds and
// submits its sell **at stopPrice**, never at the collapsed bid, and triggers a touch
// above the floor so the order has room to fill. Paper is meant to estimate that, and was
// instead measuring something no live run would ever do.
//
// So the fill price is now derived the way a stop actually behaves. A limit sell resting
// at the floor is taken out by the crossing: if the market was above the floor when this
// position was last observed and is below it now, it traded through, and that order filled
// at the floor. Only a position already below the floor when first seen has genuinely
// gapped past a stop that could not fill -- and that, and only that, is a STOP_GAP.
function equalRiskStopExitDecision({ plan, bestBid, shares, feeRate = 0, feesEnabled = true, previousBid = null } = {}) {
  if (!plan?.protectable || !plan.requiresStop) return null;
  const bid = Number(bestBid);
  const size = Number(shares);
  if (!Number.isFinite(bid) || !(bid >= 0) || !Number.isFinite(size) || !(size > 0)) return null;
  const currentValue = netExitValueAtPrice({ shares: size, price: bid, feeRate, feesEnabled });
  if (!Number.isFinite(currentValue) || currentValue > Number(plan.minimumExitValueUsdc) + 0.00001) return null;

  const floor = Number(plan.stopPrice);
  const observedAtOrAboveFloor = bid + 0.000001 >= floor;
  // The previous mark, written by the check before this one. Absent means this position
  // has never been observed above the floor, so nothing can be assumed about a crossing.
  const priorBid = Number(previousBid);
  const crossedSinceLastLook = Number.isFinite(priorBid) && priorBid > floor;

  // Filled at the floor by the crossing, or at the bid when that is better than the floor.
  const fillPrice = observedAtOrAboveFloor ? bid : (crossedSinceLastLook ? floor : bid);
  const executableAtFloor = observedAtOrAboveFloor || crossedSinceLastLook;
  const exitValueUsdc = netExitValueAtPrice({ shares: size, price: fillPrice, feeRate, feesEnabled });
  const realizedPnlUsdc = Number((Number(exitValueUsdc) - Number(plan.costUsdc || 0)).toFixed(5));
  return {
    triggered: true,
    executableAtFloor,
    fillPrice: Number(Number(fillPrice).toFixed(6)),
    filledByCrossing: !observedAtOrAboveFloor && crossedSinceLastLook,
    observedBid: Number(bid.toFixed(6)),
    currentValueUsdc: Number(currentValue.toFixed(5)),
    exitValueUsdc: Number(Number(exitValueUsdc).toFixed(5)),
    realizedPnlUsdc,
    realizedLossUsdc: Number(Math.max(0, -realizedPnlUsdc).toFixed(5)),
  };
}

function totalCost(trade) {
  return Number(trade.totalCostUsdc || trade.maxLossUsdc || trade.stakeUsdc || 0);
}

function pnlPercent(pnl, basis) {
  const denominator = Number(basis);
  return denominator > 0 ? Number((Number(pnl || 0) / denominator).toFixed(4)) : null;
}

function average(values) {
  const rows = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function parseOutcomePrices(market) {
  return parseJsonField(market.outcomePrices).map((price) => Number(price));
}

function outcomeIndexForTrade(market, trade) {
  const outcomes = parseJsonField(market.outcomes).map((outcome) => String(outcome));
  const byOutcome = outcomes.findIndex((outcome) => outcome.toLowerCase() === String(trade.outcome || "").toLowerCase());
  if (byOutcome >= 0) return byOutcome;
  const tokenIds = parseJsonField(market.clobTokenIds).map((tokenId) => String(tokenId));
  return tokenIds.findIndex((tokenId) => tokenId === String(trade.tokenId || ""));
}

async function fetchMarketBySlugUncached(slug) {
  for (const closed of ["true", "false"]) {
    const url = new URL("https://gamma-api.polymarket.com/markets");
    url.searchParams.set("slug", slug);
    url.searchParams.set("closed", closed);
    const markets = await fetchJson(url);
    if (Array.isArray(markets) && markets[0]) return markets[0];
  }
  return null;
}

// Deduplicated per process by marketBySlugCache. Callers only ever read the market they
// get back -- nothing in this file assigns to a field of one -- so handing the same
// object to several of them is safe.
//
// A rejected lookup is not cached: a transient failure must not become this pass's
// permanent answer for that market.
async function fetchMarketBySlug(slug) {
  if (!slug) return null;
  const key = String(slug);
  const cached = marketBySlugCache.get(key);
  if (cached) return cached;
  const pending = fetchMarketBySlugUncached(key);
  marketBySlugCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    marketBySlugCache.delete(key);
    throw error;
  }
}

function shouldCheckEqualStopBeforePending({ equalRiskProtection = false, awaitingResolution = false, marketClosed = false } = {}) {
  return Boolean(equalRiskProtection && awaitingResolution && !marketClosed);
}

// The same crossing rule as equalRiskStopExitDecision, for the one case that rule never
// reached: the market closed.
//
// Reported: the two most recent losers in a protected portfolio sit in LOST at the full
// stake with stopLossStatus still ARMED. The stop was not merely unlucky, it was skipped --
// a settled market returned a result before the floor was ever consulted, so any position
// whose market closed between two polls paid the whole stake with an armed stop on it.
//
// A losing settlement is the strongest possible evidence of a crossing. The floor is
// derived below the entry, and the price ended at zero, so it went through the floor on the
// way down; a resting sell there is filled by that. The live path already books exactly
// this when a position is above the floor at one look and below it at the next. Resolution
// only makes the crossing certain instead of inferred.
//
// What the last live mark decides is whether a resting order can be claimed at all. Above
// the floor means the position was watched above it, so the order was there to be taken.
// At or below it means the floor had already been breached with no stop booked -- a real
// gap, not a fill -- and the full loss stands. A settlement print of 0 or 1 is not a quote
// and cannot stand in for that mark, which is why lastLiveBid is carried separately.
function settlementStopFill({
  plan,
  lastLiveMark,
  shares,
  feeRate = 0,
  feesEnabled = true,
  totalCostUsdc,
} = {}) {
  if (!plan?.protectable || !plan.requiresStop) return null;
  const floor = Number(plan.stopPrice);
  const size = Number(shares);
  const cost = Number(totalCostUsdc);
  const mark = Number(lastLiveMark);
  if (!Number.isFinite(floor) || !(floor > 0)) return null;
  if (!Number.isFinite(size) || !(size > 0) || !Number.isFinite(cost) || !(cost > 0)) return null;
  // A quote, not a settlement. 0 and 1 are what the closing write leaves behind.
  if (!Number.isFinite(mark) || !(mark > 0) || !(mark < 1) || !(mark > floor)) return null;
  const exitValueUsdc = netExitValueAtPrice({ shares: size, price: floor, feeRate, feesEnabled });
  if (!Number.isFinite(exitValueUsdc)) return null;
  const realizedPnlUsdc = Number((exitValueUsdc - cost).toFixed(4));
  return {
    fillPrice: floor,
    lastLiveMark: Number(mark.toFixed(4)),
    exitValueUsdc: Number(exitValueUsdc.toFixed(4)),
    realizedPnlUsdc,
    riskTargetUsdc: plan.riskTargetUsdc,
    stopLossRiskMultiplier: plan.stopLossRiskMultiplier ?? null,
    capBreachUsdc: Number(Math.max(0, -realizedPnlUsdc - Number(plan.riskTargetUsdc || 0)).toFixed(5)),
  };
}

// Pure decision, kept apart from the fetching around it. A resting buy fills when the
// market comes down to the price it rests at; short of that it is discarded with no fill and
// no stake spent once the event ends, exactly as a real resting order nobody took would be.
//
// This used to ask only where the best ask is *right now*, and audited against traded prices
// that was wrong for 28 of 40 resting orders in production. Two ways it failed, both fixed
// by looking at more than the current ask:
//
//  - No ask at all reads as "did not fill", when it is really "cannot tell from the book".
//    On a decided market nobody offers the worthless side, so the ask side empties while the
//    price has already collapsed through the resting order. Those orders sat in WAITING for
//    hours -- and the simulation flattered itself, because an order that really did fill and
//    lose was being discarded for free instead.
//  - A dip between two checks leaves nothing behind in the book. The market touches the
//    resting price, takes the order, and is back above it before the next look.
//
// So three signals, cheapest first: the ask, the market's current price (already fetched
// with the market, so free), and the lowest price actually traded since the last look. The
// fill price is the limit either way -- a resting order is filled at its own price, never at
// a better one.
function limitOrderFillDecision({
  limitPrice,
  bestAsk,
  eventEnded,
  marketPrice = null,
  lowestTradedPrice = null,
}) {
  const limit = Number(limitPrice);
  if (!Number.isFinite(limit)) return { outcome: eventEnded ? "EXPIRED" : "WAITING" };
  const filled = (filledBy, observed) => ({ outcome: "FILLED", fillPrice: limit, filledBy, observed });

  if (Number.isFinite(bestAsk) && bestAsk <= limit) return filled("ask", Number(bestAsk));
  // Where the market is trading now. Below the resting price means the order was passed on
  // the way down, whether or not anyone is offering at this instant.
  if (Number.isFinite(marketPrice) && marketPrice > 0 && marketPrice <= limit) {
    return filled("market-price", Number(marketPrice));
  }
  // And the gap between two looks, which neither of the above can see.
  if (Number.isFinite(lowestTradedPrice) && lowestTradedPrice <= limit) {
    return filled("traded-through", Number(lowestTradedPrice));
  }
  return { outcome: eventEnded ? "EXPIRED" : "WAITING" };
}

// Whether the market traded down to a resting order while nobody was looking.
//
// fidelity=1 is the finest series the CLOB serves, so a dip lasting under a minute can still
// hide. That is a real remaining limit, not a solved problem -- but it replaces a window of
// minutes to an hour between passes with one of a minute.
const LIMIT_ORDER_TRADE_HISTORY = envBool("PAPER_LIMIT_ORDER_TRADE_HISTORY", true);

async function lowestTradedPriceSince(tokenId, sinceIso) {
  if (!LIMIT_ORDER_TRADE_HISTORY || !tokenId) return null;
  const startTs = Math.floor(Date.parse(sinceIso || "") / 1000);
  if (!Number.isFinite(startTs)) return null;
  const url = new URL("https://clob.polymarket.com/prices-history");
  url.searchParams.set("market", String(tokenId));
  url.searchParams.set("startTs", String(startTs));
  url.searchParams.set("endTs", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("fidelity", "1");
  let history;
  try {
    history = await fetchJson(url);
  } catch {
    // A missing history is not evidence of no fill, so it must not be turned into one:
    // null leaves the decision to the other two signals.
    return null;
  }
  const points = Array.isArray(history?.history) ? history.history : [];
  let low = Infinity;
  for (const point of points) {
    const price = Number(point?.p);
    if (Number.isFinite(price) && price > 0 && price < low) low = price;
  }
  return Number.isFinite(low) ? low : null;
}

function apiBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

// Gamma's scheduled endDate is useful for planning but is not a settlement signal:
// sports and delayed markets can remain active and accept orders after it passes.
// A resting paper bid must stay on the book while Polymarket explicitly says that the
// market is still active/accepting orders. The date remains a conservative fallback
// only when the API gives no live-status signal at all.
function limitOrderEventEnded(market = {}, remainingDays = null) {
  if (apiBoolean(market.closed)) return true;

  const marketIsActive = apiBoolean(market.active);
  const acceptsOrders = apiBoolean(market.acceptingOrders ?? market.accepting_orders);
  if (marketIsActive || acceptsOrders) return false;

  return Number.isFinite(remainingDays) && remainingDays <= 0;
}

// A resting limit buy is not a position yet, so it is refreshed on its own terms
// instead of falling into markOpenTrade()'s resolution/P&L logic below, which
// assumes an already-executed fill.
async function markWaitingLimitOrder(trade) {
  const checkedAt = nowIso();
  let market = null;
  try {
    market = await fetchMarketBySlug(trade.slug);
  } catch (error) {
    return { ...trade, statusNote: `Market refresh failed: ${error.message}`, lastCheckedAt: checkedAt };
  }
  if (!market) {
    return {
      ...trade,
      status: "MARKET_NOT_FOUND",
      statusNote: "Market slug not found in Gamma API.",
      lastCheckedAt: checkedAt,
      marketUrlStatus: "not_found",
    };
  }

  const dateContext = marketDateContext({ ...market, resolutionEndDate: market.endDate || trade.resolutionEndDate || trade.endDate || null }, trade.openedAt || trade.date);
  const endDate = dateContext.endDate;
  const remainingDays = endDate ? daysToEnd(endDate) : null;
  const eventEnded = limitOrderEventEnded(market, remainingDays);
  const base = {
    ...trade,
    question: market.question || trade.question,
    endDate,
    scheduledEventDate: dateContext.scheduledEventDate,
    resolutionEndDate: dateContext.resolutionEndDate,
    endDateSource: dateContext.endDateSource,
    daysToResolution: remainingDays == null ? trade.daysToResolution ?? null : Number(remainingDays.toFixed(2)),
    lastCheckedAt: checkedAt,
  };

  let bestAsk = null;
  let bookNote = "";
  try {
    const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(trade.tokenId)}`);
    bestAsk = bestBook(book).bestAsk;
  } catch (error) {
    // A book that cannot be read is not a book that nobody is selling into. These tokens
    // 404 once the market is delisted, and returning here meant the two signals that need
    // no book at all -- the market's own price and the traded history -- never ran.
    // Measured on production: that is why orders whose market had already collapsed
    // straight through them were still sitting in WAITING hours later.
    bookNote = ` (order book unavailable: ${error.message})`;
  }

  const limitPrice = Number(trade.entryPrice);
  const outcomeIndex = outcomeIndexForTrade(market, trade);
  const marketPrice = outcomeIndex >= 0 ? parseOutcomePrices(market)[outcomeIndex] : null;
  // Only asked for when the two free signals did not already settle it, and only over the
  // window since the last look -- there is no point re-reading history this pass already
  // covered.
  const needsHistory = !(Number.isFinite(bestAsk) && bestAsk <= limitPrice)
    && !(Number.isFinite(marketPrice) && marketPrice > 0 && marketPrice <= limitPrice);
  // Normally the last look is far enough back, because every earlier look covered its own
  // window. An order placed before this check existed has never had its history read at
  // all, though, so the first read goes back to when the order was placed -- otherwise the
  // dip that filled it stays permanently outside every window. Measured: orders whose
  // market passed through them hours ago were invisible to a window starting at the last
  // look, which is exactly how they came to be sitting there.
  const historyFrom = trade.historyCheckedAt || trade.openedAt || trade.date || trade.lastCheckedAt;
  const lowestTradedPrice = needsHistory
    ? await lowestTradedPriceSince(trade.tokenId, historyFrom)
    : null;
  const decision = limitOrderFillDecision({
    limitPrice,
    bestAsk,
    eventEnded,
    marketPrice,
    lowestTradedPrice,
  });
  const askNote = Number.isFinite(bestAsk) ? bestAsk.toFixed(4) : "n/a";

  if (decision.outcome === "FILLED") {
    const how = {
      ask: `the best ask reached ${askNote}`,
      "market-price": `the market is trading at ${Number(decision.observed).toFixed(4)}, at or below the resting price`,
      "traded-through": `the market traded down to ${Number(decision.observed).toFixed(4)} since the last check`,
    }[decision.filledBy] || `the market reached ${askNote}`;
    return {
      ...base,
      status: "OPEN",
      filledAt: checkedAt,
      currentPrice: decision.fillPrice,
      // Which signal caught it. A run of "traded-through" fills is the sampling gap being
      // closed; a run of "market-price" fills is books that had emptied out.
      filledBy: decision.filledBy,
      currentValueUsdc: trade.currentValueUsdc,
      unrealizedPnlUsdc: 0,
      unrealizedPnlPct: 0,
      statusNote: `Resting limit buy at ${limitPrice.toFixed(4)} was filled: ${how}.`,
    };
  }

  if (decision.outcome === "EXPIRED") {
    return {
      ...base,
      status: "LIMIT_ORDER_EXPIRED",
      closedAt: checkedAt,
      resolvedAt: checkedAt,
      currentPrice: null,
      currentValueUsdc: 0,
      unrealizedPnlUsdc: 0,
      unrealizedPnlPct: 0,
      realizedPnlUsdc: 0,
      realizedPnlPct: 0,
      statusNote: `Resting limit buy at ${limitPrice.toFixed(4)} never filled before the event ended`
        + ` (best ask stayed at ${askNote}); discarded with no fill.`,
    };
  }

  return {
    ...base,
    // Only recorded once the history has genuinely been read to this point, so a pass that
    // could not read it leaves the catch-up window open rather than closing it silently.
    historyCheckedAt: lowestTradedPrice != null || !needsHistory ? checkedAt : trade.historyCheckedAt ?? null,
    statusNote: `Waiting to fill a resting limit buy at ${limitPrice.toFixed(4)}; best ask is ${askNote}`
      + `${bookNote}${Number.isFinite(marketPrice) ? `, market at ${Number(marketPrice).toFixed(4)}` : ""}`
      + `${Number.isFinite(lowestTradedPrice) ? `, lowest traded ${Number(lowestTradedPrice).toFixed(4)}` : ""}.`,
  };
}

async function markOpenTrade(trade) {
  if (trade.status === "LIMIT_ORDER_WAITING") return markWaitingLimitOrder(trade);
  if (!OPEN_STATUSES.has(trade.status)) return trade;

  const checkedAt = nowIso();
  const cost = totalCost(trade);
  let market = null;

  try {
    market = await fetchMarketBySlug(trade.slug);
  } catch (error) {
    return {
      ...trade,
      statusNote: `Market refresh failed: ${error.message}`,
      lastCheckedAt: checkedAt,
    };
  }

  if (!market) {
    return {
      ...trade,
      status: "MARKET_NOT_FOUND",
      statusNote: "Market slug not found in Gamma API.",
      lastCheckedAt: checkedAt,
      marketUrlStatus: "not_found",
    };
  }

  const outcomeIndex = outcomeIndexForTrade(market, trade);
  const prices = parseOutcomePrices(market);
  const resolvedPrice = outcomeIndex >= 0 ? prices[outcomeIndex] : null;
  const eventSlug = marketEventSlug(market);
  const dateContext = marketDateContext({ ...market, resolutionEndDate: market.endDate || trade.resolutionEndDate || trade.endDate || null }, trade.openedAt || trade.date);
  const endDate = dateContext.endDate;
  const remainingDays = endDate ? daysToEnd(endDate) : null;
  const awaitingResolution = dateContext.sportsEventStarted || (remainingDays != null && remainingDays <= 0);
  const base = {
    ...trade,
    question: market.question || trade.question,
    eventSlug,
    endDate,
    scheduledEventDate: dateContext.scheduledEventDate,
    resolutionEndDate: dateContext.resolutionEndDate,
    endDateSource: dateContext.endDateSource,
    daysToResolution: remainingDays == null ? trade.daysToResolution ?? null : Number(remainingDays.toFixed(2)),
    marketClosed: Boolean(market.closed),
    marketActive: Boolean(market.active),
    acceptingOrders: Boolean(market.acceptingOrders),
    umaResolutionStatus: market.umaResolutionStatus || trade.umaResolutionStatus || null,
    closedTime: market.closedTime || trade.closedTime || null,
    lastCheckedAt: checkedAt,
    marketUrlStatus: eventSlug && eventSlug !== trade.slug ? "use_event_slug" : "ok",
    // The last mark taken from a live orderbook, kept apart from currentPrice because the
    // closing write overwrites currentPrice with the settlement print. Reading a stop
    // decision off currentPrice after that asks a 0 or a 1 what the market was quoting.
    lastLiveBid: trade.lastLiveBid ?? null,
  };

  // One derivation of the floor for this position, shared by the settlement path below and
  // the live check further down. Two copies of these arguments is how the two paths would
  // drift into protecting the same trade at different prices.
  const stopPlanForTrade = () => (trade.equalRiskProtection
    ? equalRiskStopPlan({
      totalCostUsdc: cost,
      netGainIfWinUsdc: trade.riskTargetUsdc ?? trade.netGainIfWinUsdc,
      shares: trade.shares,
      entryPrice: trade.entryPrice,
      feeRate: trade.feeRate,
      feesEnabled: trade.feesEnabled,
      riskMultiplier: trade.riskTargetUsdc ? 1 : (trade.stopLossRiskMultiplier ?? 1),
    })
    : null);

  if (market.closed && Number.isFinite(resolvedPrice)) {
    const won = resolvedPrice >= 0.999;
    const lost = resolvedPrice <= 0.001;
    if (won || lost) {
      // A protected position that settles at zero crossed its floor to get there: the floor
      // sits below the entry by construction and the price ended below the floor, so it
      // passed through, and a sell resting at the floor is taken out by that crossing. The
      // settlement was being booked before the floor was ever consulted, so a market that
      // closed between two polls took the whole stake and left the stop reading ARMED.
      const settlementStop = lost
        ? settlementStopFill({
          plan: stopPlanForTrade(),
          lastLiveMark: trade.lastLiveBid ?? trade.currentPrice,
          shares: trade.shares,
          feeRate: trade.feeRate,
          feesEnabled: trade.feesEnabled,
          totalCostUsdc: cost,
        })
        : null;
      if (settlementStop) {
        return {
          ...base,
          status: "STOP_LOSS",
          closedAt: checkedAt,
          resolvedAt: market.closedTime || checkedAt,
          finalOutcomePrice: Number(resolvedPrice.toFixed(4)),
          currentPrice: settlementStop.fillPrice,
          observedBidAtStop: settlementStop.lastLiveMark,
          currentValueUsdc: settlementStop.exitValueUsdc,
          unrealizedPnlUsdc: 0,
          unrealizedPnlPct: 0,
          realizedPnlUsdc: settlementStop.realizedPnlUsdc,
          realizedPnlPct: pnlPercent(settlementStop.realizedPnlUsdc, cost),
          stopLossStatus: "FILLED_AT_FLOOR",
          stopLossTriggeredAt: checkedAt,
          stopLossPrice: settlementStop.fillPrice,
          riskTargetUsdc: settlementStop.riskTargetUsdc,
          stopLossRiskMultiplier: settlementStop.stopLossRiskMultiplier ?? trade.stopLossRiskMultiplier ?? null,
          stopLossCapBreachUsdc: settlementStop.capBreachUsdc,
          statusNote: `Equal stop filled at its ${settlementStop.fillPrice.toFixed(4)} floor: the market was`
            + ` quoted at ${settlementStop.lastLiveMark.toFixed(4)} at the last look and settled at`
            + ` ${resolvedPrice}, so it traded through the resting exit before resolving.`,
        };
      }
      const realizedPnl = won ? Number((Number(trade.shares || 0) - cost).toFixed(4)) : Number((-cost).toFixed(4));
      return {
        ...base,
        status: won ? "WON" : "LOST",
        resolvedAt: market.closedTime || checkedAt,
        finalOutcomePrice: Number(resolvedPrice.toFixed(4)),
        currentPrice: Number(resolvedPrice.toFixed(4)),
        currentValueUsdc: won ? Number(Number(trade.shares || 0).toFixed(4)) : 0,
        unrealizedPnlUsdc: 0,
        unrealizedPnlPct: 0,
        realizedPnlUsdc: realizedPnl,
        realizedPnlPct: pnlPercent(realizedPnl, cost),
        statusNote: `Resolved by Polymarket as ${trade.outcome}=${resolvedPrice}.`,
      };
    }
  }

  if (market.closed) {
    return {
      ...base,
      status: "PENDING_RESOLUTION",
      finalOutcomePrice: Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : null,
      statusNote: "Market is closed but outcome price is not final yet.",
    };
  }

  const pendingResolutionResult = (current = {}) => ({
      ...base,
      status: "PENDING_RESOLUTION",
      finalOutcomePrice: Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : null,
      currentPrice: current.currentPrice ?? (Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : trade.currentPrice ?? null),
      // Only a figure that came off a book updates this. currentPrice above may be the
      // settlement print, and a stop must never be decided against one.
      lastLiveBid: current.lastLiveBid ?? trade.lastLiveBid ?? null,
      currentValueUsdc: current.currentValueUsdc ?? trade.currentValueUsdc ?? null,
      unrealizedPnlUsdc: current.unrealizedPnlUsdc ?? trade.unrealizedPnlUsdc ?? 0,
      unrealizedPnlPct: current.unrealizedPnlPct ?? trade.unrealizedPnlPct ?? 0,
      statusNote: current.statusNote || "Event end date has passed; waiting for Polymarket resolution.",
    });

  // A sports kickoff and Gamma's estimated end date are not an exchange close.
  // Equal must still inspect a live book at that point: it is the only chance to
  // observe and record its synthetic protective exit before final resolution.
  if (awaitingResolution && !shouldCheckEqualStopBeforePending({
    equalRiskProtection: trade.equalRiskProtection,
    awaitingResolution,
    marketClosed: market.closed,
  })) {
    return pendingResolutionResult();
  }

  try {
    const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(trade.tokenId)}`);
    const { bestBid } = bestBook(book);
    if (Number.isFinite(bestBid)) {
      const equalRiskPlan = stopPlanForTrade();
      const grossCurrentValue = Number((Number(trade.shares || 0) * bestBid).toFixed(4));
      const currentValue = equalRiskPlan
        ? netExitValueAtPrice({ shares: trade.shares, price: bestBid, feeRate: trade.feeRate, feesEnabled: trade.feesEnabled })
        : grossCurrentValue;
      const unrealizedPnl = Number((currentValue - cost).toFixed(4));
      const equalStopDecision = equalRiskStopExitDecision({
        plan: equalRiskPlan,
        bestBid,
        shares: trade.shares,
        feeRate: trade.feeRate,
        feesEnabled: trade.feesEnabled,
        // The mark written by the previous check. It is what says whether the market
        // crossed the floor between two looks -- which a resting stop would have been
        // filled by -- or was already through it before this position was ever watched.
        previousBid: trade.currentPrice,
      });
      if (equalStopDecision?.triggered) {
        const capBreachUsdc = Number(Math.max(0, equalStopDecision.realizedLossUsdc - equalRiskPlan.riskTargetUsdc).toFixed(5));
        return {
          ...base,
          status: "STOP_LOSS",
          closedAt: checkedAt,
          resolvedAt: checkedAt,
          currentPrice: Number(equalStopDecision.fillPrice.toFixed(4)),
          observedBidAtStop: equalStopDecision.observedBid,
          currentValueUsdc: equalStopDecision.exitValueUsdc,
          unrealizedPnlUsdc: 0,
          unrealizedPnlPct: 0,
          realizedPnlUsdc: equalStopDecision.realizedPnlUsdc,
          realizedPnlPct: pnlPercent(equalStopDecision.realizedPnlUsdc, cost),
          stopLossStatus: equalStopDecision.filledByCrossing
            ? "FILLED_AT_FLOOR"
            : (equalStopDecision.executableAtFloor ? "FILLED_WITHIN_TARGET" : "FILLED_AFTER_GAP"),
          stopLossTriggeredAt: checkedAt,
          stopLossPrice: equalRiskPlan.stopPrice,
          riskTargetUsdc: equalRiskPlan.riskTargetUsdc,
          stopLossRiskMultiplier: equalRiskPlan.stopLossRiskMultiplier ?? trade.stopLossRiskMultiplier ?? null,
          stopLossCapBreachUsdc: capBreachUsdc,
          statusNote: equalStopDecision.filledByCrossing
            ? `Equal stop filled at its ${equalRiskPlan.stopPrice.toFixed(4)} floor: the market was above the floor at the previous check and is ${bestBid.toFixed(4)} now, so it traded through the resting exit.`
            : (equalStopDecision.executableAtFloor
              ? `Synthetic Equal paper stop exited at executable bid ${bestBid.toFixed(4)} within its planned loss target.`
              : `Equal stop could not fill: this position was already below its ${equalRiskPlan.stopPrice.toFixed(4)} floor when first observed, at bid ${bestBid.toFixed(4)}. The loss target was exceeded by ${capBreachUsdc.toFixed(4)} USDC.`),
        };
      }
      if (awaitingResolution) {
        return pendingResolutionResult({
          currentPrice: Number(bestBid.toFixed(4)),
          lastLiveBid: Number(bestBid.toFixed(4)),
          currentValueUsdc: currentValue,
          unrealizedPnlUsdc: unrealizedPnl,
          unrealizedPnlPct: pnlPercent(unrealizedPnl, cost),
          statusNote: trade.equalRiskProtection
            ? "Equal stop was checked against the current best bid; waiting for Polymarket resolution."
            : "Event end date has passed; waiting for Polymarket resolution.",
        });
      }
      return {
        ...base,
        status: "OPEN",
        currentPrice: Number(bestBid.toFixed(4)),
        lastLiveBid: Number(bestBid.toFixed(4)),
        currentValueUsdc: currentValue,
        unrealizedPnlUsdc: unrealizedPnl,
        unrealizedPnlPct: pnlPercent(unrealizedPnl, cost),
        equalRiskProtection: Boolean(trade.equalRiskProtection),
        riskTargetUsdc: equalRiskPlan?.riskTargetUsdc ?? trade.riskTargetUsdc ?? null,
        stopLossRiskMultiplier: equalRiskPlan?.stopLossRiskMultiplier ?? trade.stopLossRiskMultiplier ?? null,
        stopLossPrice: equalRiskPlan?.stopPrice ?? trade.stopLossPrice ?? null,
        stopLossStatus: equalRiskPlan?.requiresStop ? "ARMED" : (trade.equalRiskProtection ? "NOT_REQUIRED" : null),
        statusNote: trade.equalRiskProtection ? "Marked to current best bid; Equal paper stop is armed." : "Marked to current best bid.",
      };
    }
  } catch (error) {
    if (awaitingResolution) {
      return pendingResolutionResult({
        statusNote: trade.equalRiskProtection
          ? `Equal stop could not be checked before resolution: ${error.message}`
          : "Event end date has passed; waiting for Polymarket resolution.",
      });
    }
    return {
      ...base,
      statusNote: `Orderbook refresh failed: ${error.message}`,
    };
  }

  return awaitingResolution ? pendingResolutionResult() : base;
}

// A resting order that the account cannot honour is not an order.
//
// Placing them stays deliberately permissive: capital held by unfilled orders is not counted
// against the next one, because an offer nobody takes costs nothing. Measured on production,
// the consequence is a queue far larger than the balance behind it -- three portfolios
// reached roughly twice their own equity within three hours, one of them opening on all 24
// of its last runs, because nothing in the placing decision ever runs out.
//
// So the brake belongs where the promise comes due rather than where it is made. A fill is
// funded out of capital that is not already in a position; resting orders reserve nothing
// against it, since they are not exposure. When a fill cannot be funded the portfolio has
// over-promised, and every remaining resting order is cancelled -- not just the one that
// did not fit. Refusing them one at a time on later passes would leave the same
// over-promised queue standing, and the queue is the thing that was wrong.
function cancelLimitOrderForCapital(trade, note) {
  const at = nowIso();
  return {
    ...trade,
    status: "LIMIT_ORDER_EXPIRED",
    // Distinguishes this from an order that simply outlived its event. Both are discarded
    // with no stake spent, so they share the terminal status, but only one of them says
    // something about the account.
    cancelledForCapital: true,
    closedAt: at,
    resolvedAt: at,
    currentPrice: null,
    currentValueUsdc: 0,
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    realizedPnlUsdc: 0,
    realizedPnlPct: 0,
    statusNote: note,
  };
}

function fundLimitOrderFills(previousTrades, refreshedTrades, portfolioState) {
  const before = Array.isArray(previousTrades) ? previousTrades : [];
  const filledNow = (trade, index) => String(before[index]?.status || "") === "LIMIT_ORDER_WAITING"
    && String(trade?.status || "") === "OPEN";
  if (!refreshedTrades.some(filledNow)) return { trades: refreshedTrades, funded: 0, cancelled: 0 };

  const realizedPnl = refreshedTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
  const capitalAdjustment = Number(portfolioState?.capitalAdjustmentUsdc) || 0;
  const balance = Math.max(0, PORTFOLIO_USDC + capitalAdjustment + realizedPnl);
  // Capacity before this pass's fills: the balance less what is already held. Rows that
  // filled on this pass are excluded because they are exactly what is being funded.
  let capacity = balance - positionRisk(refreshedTrades.filter((trade, index) => !filledNow(trade, index)));

  let overPromised = false;
  let funded = 0;
  const trades = refreshedTrades.map((trade, index) => {
    if (!filledNow(trade, index)) return trade;
    const cost = Number(trade.maxLossUsdc || trade.stakeUsdc || 0);
    // Once one fill cannot be funded, the rest of this pass's fills go with it. They are
    // resting orders too, and the account is already out of room.
    if (!overPromised && cost <= capacity + 0.00001) {
      capacity -= cost;
      funded += 1;
      return trade;
    }
    overPromised = true;
    return cancelLimitOrderForCapital(trade, `Resting limit buy reached its fill price but the`
      + ` portfolio had ${Math.max(0, capacity).toFixed(2)} USDC outside its positions and the`
      + ` position needs ${cost.toFixed(2)} USDC. Every resting order was cancelled.`);
  });
  if (!overPromised) return { trades, funded, cancelled: 0 };

  let cancelled = 0;
  const settled = trades.map((trade) => {
    if (String(trade?.status || "") !== "LIMIT_ORDER_WAITING") return trade;
    cancelled += 1;
    return cancelLimitOrderForCapital(trade, "Cancelled unfilled: another resting order reached"
      + " its fill price with no capital left outside this portfolio's positions to fund it,"
      + " so the whole resting queue was cancelled.");
  });
  return { trades: settled, funded, cancelled };
}

async function refreshTrades(trades, portfolioState = null) {
  // mapWithConcurrency returns input order, so this is the same array the sequential
  // loop built -- markOpenTrade reads the market and returns a new trade, and touches
  // nothing another trade can see.
  const refreshed = await mapWithConcurrency(trades, (trade) => markOpenTrade(trade));
  // Funding is decided after the fan-out, not inside it: whether one fill fits depends on
  // every other fill on the same pass, which a per-trade worker cannot see.
  if (!portfolioState) return refreshed;
  const funding = fundLimitOrderFills(trades, refreshed, portfolioState);
  if (funding.cancelled) {
    console.warn(`${portfolioState.id}: a resting order reached its fill price with no capital to`
      + ` fund the position; cancelled ${funding.cancelled} resting order(s)`
      + `${funding.funded ? ` after funding ${funding.funded}` : ""}.`);
  }
  return funding.trades;
}

function probabilityBucket(probability) {
  const value = Number(probability);
  if (!Number.isFinite(value)) return "unknown";
  if (value < 0.2) return "00-20";
  if (value < 0.4) return "20-40";
  if (value < 0.6) return "40-60";
  if (value < 0.8) return "60-80";
  if (value < 0.9) return "80-90";
  if (value < 0.97) return "90-97";
  return "97-100";
}

function outcomeKind(outcome) {
  const text = String(outcome || "").toLowerCase();
  if (text === "yes") return "YES";
  if (text === "no") return "NO";
  return "OUTCOME";
}

function binaryYesNoOutcomeIndexes(outcomes = []) {
  const normalized = outcomes.map((outcome) => String(outcome || "").trim().toLowerCase());
  if (normalized.length !== 2) return null;
  const yesIndex = normalized.indexOf("yes");
  const noIndex = normalized.indexOf("no");
  return yesIndex >= 0 && noIndex >= 0 ? { yesIndex, noIndex } : null;
}

function binaryEvaluationMarketKey(item) {
  const outcome = outcomeKind(item?.outcome);
  // Older stored evaluations do not always carry outcomeCount or the paired
  // token IDs. A Yes/No evaluation is still a binary market and must match the
  // fresh Gamma snapshot by slug so its current Polymarket probability is kept.
  const isBinary = item?.binaryYesTokenId || outcome === "YES" || outcome === "NO" || Number(item?.outcomeCount) === 2;
  if (!isBinary) return "";
  const slug = String(item?.slug || item?.eventSlug || "").trim().toLowerCase();
  const question = String(item?.question || "").trim().toLowerCase();
  return slug ? `binary:${slug}` : (question ? `binary-question:${question}` : "");
}

function binaryMarketKeyFromMarket(market) {
  const outcomes = parseJsonField(market?.outcomes);
  if (!binaryYesNoOutcomeIndexes(outcomes)) return "";
  const slug = String(market?.slug || marketEventSlug(market) || "").trim().toLowerCase();
  const question = String(market?.question || "").trim().toLowerCase();
  return slug ? `binary:${slug}` : (question ? `binary-question:${question}` : "");
}

function analysisFactorKeys({ probability, outcome, tags, spread, liquidity, volume24hr, days, market }) {
  const keys = new Set();
  const tagList = Array.isArray(tags) && tags.length ? tags : ["general"];
  for (const tag of tagList.slice(0, 4)) keys.add(`tag:${tag}`);
  keys.add(`bucket:${probabilityBucket(probability)}`);
  keys.add(`outcome:${outcomeKind(outcome).toLowerCase()}`);
  keys.add(spread != null && spread <= 0.015 ? "spread:tight" : "spread:wide");
  keys.add(liquidity >= 5000 || volume24hr >= 5000 ? "liquidity:deep" : "liquidity:thin");
  keys.add(days != null && days <= 21 ? "horizon:short" : "horizon:long");
  if (market?.negRisk) keys.add("market:negative-risk");
  return [...keys];
}

function learningAdjustment({ probability, outcome, tags, spread, liquidity, volume24hr, days, market, learningProfile }) {
  const profile = normalizeLearningProfile(learningProfile);
  const factors = analysisFactorKeys({ probability, outcome, tags, spread, liquidity, volume24hr, days, market });
  const applied = [];
  let adjustment = 0;

  for (const key of factors) {
    const value = Number(profile.factorAdjustments?.[key]?.adjustment);
    if (Number.isFinite(value) && value !== 0) {
      adjustment += value;
      applied.push({ key, adjustment: Number(value.toFixed(4)) });
    }
  }

  const bucket = profile.bucketCalibration?.[probabilityBucket(probability)];
  const bucketError = Number(bucket?.calibrationError);
  if (Number.isFinite(bucketError) && Number(bucket?.count || 0) >= 3) {
    const value = clamp(bucketError * 0.25, -0.04, 0.04);
    adjustment += value;
    applied.push({ key: `calibration:${probabilityBucket(probability)}`, adjustment: Number(value.toFixed(4)) });
  }

  const bias = Number(profile.calibrationBias);
  if (Number.isFinite(bias) && profile.sampleSize >= 5) {
    const value = clamp(bias * 0.15, -0.025, 0.025);
    adjustment += value;
    applied.push({ key: "global:bias", adjustment: Number(value.toFixed(4)) });
  }

  return {
    adjustment: clamp(adjustment, -0.08, 0.08),
    applied,
    factors,
  };
}

function confidenceTier(probability) {
  if (probability >= 0.95) return "near-certain";
  if (probability >= 0.8) return "high";
  if (probability >= 0.6) return "edge-watch";
  if (probability >= 0.4) return "uncertain";
  return "long-shot";
}

function buildHeuristicAnalysis({
  question,
  outcome,
  probability,
  rawProbability,
  executionPrice,
  edge,
  annualizedReturn,
  expectedValue,
  notes,
  tags,
  learning,
}) {
  const direction = outcomeKind(outcome);
  const likely = probability >= 0.5 ? "likely" : "unlikely";
  const value = expectedValue > 0 ? "positive" : "negative";
  const thesis = `${direction} thesis: ${String(outcome || "selected outcome")} is ${likely} at ${(probability * 100).toFixed(1)}% versus market-buy entry ${(executionPrice * 100).toFixed(1)}%; expected value is ${value}.`;
  const probabilityRationale = notes.length
    ? `The probability is calibrated from the strongest available signals: ${notes.slice(0, 3).join(" ")}`
    : "The probability remains close to the observable execution price because no stronger independent public signal was available in the heuristic pass.";
  const probabilityPointRationale = `The estimate lands at ${pctText(probability)} after a raw heuristic estimate of ${pctText(rawProbability)} and learning adjustment of ${pointText(probability - rawProbability)}.`;
  const marketComparisonSummary = buildMarketComparisonSummary({
    probability,
    marketProbability: executionPrice,
    rationale: probabilityRationale,
  });
  const uncertaintyFlags = [
    executionPrice > 0.97 ? "crowded near-certain market" : "",
    executionPrice < 0.15 ? "long-shot price bucket" : "",
    Math.abs(edge) < 0.015 ? "thin modeled edge" : "",
    tags.includes("clear-resolution") ? "" : "resolution wording needs review",
  ].filter(Boolean);

  return {
    model: "heuristic-calibration-v2",
    direction,
    thesis,
    probability: Number(probability.toFixed(4)),
    rawProbability: Number(rawProbability.toFixed(4)),
    confidenceTier: confidenceTier(probability),
    marketImpliedProbability: Number(executionPrice.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    probabilityRationale,
    probabilityPointRationale,
    marketComparisonSummary,
    expectedValueUsdc: Number(expectedValue.toFixed(4)),
    annualizedReturn: Number(annualizedReturn.toFixed(4)),
    evidence: notes.slice(0, 6),
    counterEvidence: uncertaintyFlags,
    tags,
    learningAdjustment: Number((probability - rawProbability).toFixed(4)),
    learningFactors: learning.factors,
    appliedLearning: learning.applied,
  };
}

function scoreStatus({ probability, annualizedReturn, edge, spreadOk, volumeOk, depthOk, endOk }) {
  const highConfidenceOk = probability >= MIN_PROBABILITY;
  const opportunityOk = probability >= OPPORTUNITY_MIN_PROBABILITY
    && edge >= OPPORTUNITY_MIN_EDGE
    && annualizedReturn >= OPPORTUNITY_MIN_ANNUAL_RETURN;
  const returnOk = annualizedReturn >= MIN_ANNUAL_RETURN;
  const eligible = endOk && (highConfidenceOk || opportunityOk) && returnOk && spreadOk && volumeOk && depthOk;
  return {
    status: eligible ? "ELIGIBLE" : "REJECTED",
    thesisType: highConfidenceOk ? "HIGH_CONFIDENCE" : (opportunityOk ? "EDGE_OPPORTUNITY" : "REJECTED"),
    rejectReasons: [
      endOk ? null : "event end date is in the past",
      highConfidenceOk || opportunityOk ? null : `probability ${(probability * 100).toFixed(1)}% below high-confidence threshold and edge-opportunity threshold`,
      annualizedReturn <= 0
        ? `annualized EV ${(annualizedReturn * 100).toFixed(1)}% is non-profitable after fees`
        : (returnOk ? null : `annualized EV ${(annualizedReturn * 100).toFixed(1)}% below ${(MIN_ANNUAL_RETURN * 100).toFixed(1)}%`),
      spreadOk ? null : "spread too wide",
      volumeOk ? null : "liquidity/volume too low",
      depthOk ? null : "insufficient ask depth for market buy",
    ].filter(Boolean),
  };
}

// Rounds for storage without asserting the value exists. A missing number stays
// missing instead of crashing the caller, so downstream filters can report "no
// probability" rather than a TypeError.
function rounded(value, digits) {
  // Number(null) is 0 and Number("") is 0, both finite, so a missing value would be
  // stored as a real zero and read as "this is worth nothing" rather than "unknown".
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : null;
}

function economicsForProbability({ probability, execution, stake, takerFee, totalCost, days, spreadOk, volumeOk, depthOk, endOk }) {
  const executionPrice = execution.avgPrice;
  const expectedValue = probability * execution.shares - stake - takerFee;
  const expectedRoi = totalCost > 0 ? expectedValue / totalCost : 0;
  const annualizedReturn = annualizeReturn(expectedRoi, days);
  const edge = probability - executionPrice;
  const scored = scoreStatus({ probability, annualizedReturn, edge, spreadOk, volumeOk, depthOk, endOk });
  return {
    expectedValue,
    expectedRoi,
    annualizedReturn,
    edge,
    ...scored,
  };
}

function estimateProbability({ market, outcome, ask, bid, spread, liquidity, volume24hr, tags, days, learningProfile }) {
  const marketConsensus = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : ask;
  let probability = marketConsensus;
  const notes = [];

  if (ask >= 0.94) {
    probability += 0.018;
    notes.push("Market consensus already prices this outcome as near-certain.");
  }
  if (spread != null && spread <= 0.015) {
    probability += 0.006;
    notes.push("Tight spread increases confidence in the quoted probability.");
  }
  if (liquidity >= 5000 || volume24hr >= 5000) {
    probability += 0.006;
    notes.push("Liquidity/volume is high enough to treat price as meaningful.");
  }
  if (days != null && days <= 21 && ask >= 0.9) {
    probability += 0.008;
    notes.push("Short time to resolution reduces forecast horizon.");
  }
  if (!tags.includes("clear-resolution")) {
    probability -= 0.01;
    notes.push("Resolution wording may need manual review.");
  }
  if (/other|none|unknown|another/i.test(outcome)) {
    probability -= 0.015;
    notes.push("Outcome label is less specific than a direct yes/no claim.");
  }
  if (market.negRisk) {
    notes.push("Negative-risk market: execution needs extra care in live mode.");
  }

  const rawProbability = clamp(probability, 0.01, 0.995);
  const learning = learningAdjustment({
    probability: rawProbability,
    outcome,
    tags,
    spread,
    liquidity,
    volume24hr,
    days,
    market,
    learningProfile,
  });
  probability = rawProbability + learning.adjustment;
  if (learning.applied.length) {
    notes.push(`Learning calibration adjusted probability by ${(learning.adjustment * 100).toFixed(1)} pts.`);
  }

  return {
    probability: clamp(probability, 0.01, 0.995),
    rawProbability,
    notes,
    learning,
  };
}

function evaluateCandidate({ market, outcomeIndex, tokenId, book, learningProfile }) {
  const question = String(market.question || "");
  const outcomes = parseJsonField(market.outcomes);
  const outcomePrices = parseJsonField(market.outcomePrices);
  const outcome = String(outcomes[outcomeIndex] || `Outcome ${outcomeIndex + 1}`);
  const { bestBid, bestAsk, spread, askDepth, asks } = bestBook(book);
  const volume24hr = Number(market.volume24hr || 0);
  const liquidity = Number(market.liquidity || 0);
  const tags = tagQuestion(question);
  const eventSlug = marketEventSlug(market);
  const risk = riskProfile({ question, slug: market.slug, eventSlug, outcome, tags });
  const dateContext = marketDateContext(market, market.createdAt || market.updatedAt);
  const endDate = dateContext.endDate;
  const days = daysToEnd(endDate);
  const endOk = endDateIsFuture(endDate);
  const stake = PORTFOLIO_USDC * MAX_FRACTION;
  const execution = simulateMarketBuy(asks, stake);
  const fees = feeConfig(market);

  if (!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1) return null;
  if (!Number.isFinite(execution.avgPrice) || execution.avgPrice <= 0 || execution.avgPrice >= 1) return null;

  const { probability, rawProbability, notes, learning } = estimateProbability({
    market,
    outcome,
    ask: bestAsk,
    bid: bestBid,
    spread,
    liquidity,
    volume24hr,
    tags,
    days,
    learningProfile,
  });
  const executionPrice = execution.avgPrice;
  const takerFee = takerFeeForFills(execution.fills, fees.feeRate);
  const totalCost = stake + takerFee;
  const grossGainIfWin = execution.shares - stake;
  const netGainIfWin = execution.shares - stake - takerFee;
  const grossRoiIfWin = totalCost > 0 ? netGainIfWin / totalCost : 0;
  const grossAnnualizedIfWin = annualizeReturn(grossRoiIfWin, days);
  const spreadOk = spread != null && spread <= MAX_SPREAD;
  const volumeOk = volume24hr >= MIN_VOLUME_24H || liquidity >= MIN_VOLUME_24H;
  const depthOk = execution.fillable;
  const economics = economicsForProbability({ probability, execution, stake, takerFee, totalCost, days, spreadOk, volumeOk, depthOk, endOk });
  const marketProbability = validMarketProbability(outcomePrices[outcomeIndex]) ?? executionPrice;
  const marketEconomics = economicsForProbability({
    probability: marketProbability,
    execution,
    stake,
    takerFee,
    totalCost,
    days,
    spreadOk,
    volumeOk,
    depthOk,
    endOk,
  });
  // Which verdict the row carries. With no model consulted there is no AI probability, so
  // the AI-scored economics are a row of zeros -- and those zeros were what the run log
  // showed as the reason a candidate went unused: "probability 0.0% below high-confidence
  // threshold and edge-opportunity threshold; annualized EV 0.0% is non-profitable after
  // fees", against a market priced nowhere near zero. Every portfolio scores on the
  // Polymarket probability, so that is the verdict stored when the model is not running.
  const scoringEconomics = AI_ANALYSIS_ENABLED ? economics : marketEconomics;
  const rejectReasons = scoringEconomics.rejectReasons.map((reason) => {
    if (reason === "spread too wide") return `spread ${spread == null ? "n/a" : (spread * 100).toFixed(1) + " pts"} too wide`;
    if (reason === "insufficient ask depth for market buy") return `insufficient ask depth for ${stake.toFixed(2)} USDC market buy`;
    return reason;
  });
  const aiAnalysis = buildHeuristicAnalysis({
    question,
    outcome,
    probability,
    rawProbability,
    executionPrice,
    edge: economics.edge,
    annualizedReturn: economics.annualizedReturn,
    expectedValue: economics.expectedValue,
    notes,
    tags,
    learning,
  });

  return {
    id: `token:${tokenId}`,
    evaluatedAt: nowIso(),
    status: scoringEconomics.status,
    thesisType: scoringEconomics.thesisType,
    rejectReasons,
    question,
    slug: market.slug || "",
    eventSlug,
    outcome,
    outcomeCount: outcomes.length,
    marketType: reportMarketType({ question, slug: market.slug, eventSlug, outcome, outcomeCount: outcomes.length }),
    tokenId,
    endDate,
    scheduledEventDate: dateContext.scheduledEventDate,
    resolutionEndDate: dateContext.resolutionEndDate,
    endDateSource: dateContext.endDateSource,
    tags,
    riskCategory: risk.category,
    riskPrimaryEntity: risk.primaryEntity,
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    executionMode: "MARKET_BUY",
    marketPrice: Number(executionPrice.toFixed(4)),
    marketProbability: Number(marketProbability.toFixed(4)),
    bestAsk: Number(bestAsk.toFixed(4)),
    bestBid: bestBid == null ? null : Number(bestBid.toFixed(4)),
    spread: spread == null ? null : Number(spread.toFixed(4)),
    slippage: execution.slippage,
    liquidity: Number(liquidity.toFixed(2)),
    volume24hr: Number(volume24hr.toFixed(2)),
    askDepth: Number(askDepth.toFixed(2)),
    executableDepthUsdc: execution.depthUsdc,
    filledStakeUsdc: execution.filledUsdc,
    executableShares: execution.shares,
    marketFills: execution.fills,
    feesEnabled: fees.feesEnabled,
    feeType: fees.feeType,
    feeRate: fees.feeRate,
    takerFeeUsdc: takerFee,
    totalCostUsdc: Number(totalCost.toFixed(5)),
    grossGainIfWinUsdc: Number(grossGainIfWin.toFixed(4)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    // Persisted, not derived on read: these are what the portfolios now rank and
    // filter on, and every consumer that had to rebuild them from the gain and the
    // cost was one missing field away from scoring the row at a flat zero.
    netYield: rounded(totalCost > 0 ? netGainIfWin / totalCost : null, 4),
    potentialAnnualizedReturn: rounded(
      annualizedPotentialReturn(totalCost > 0 ? netGainIfWin / totalCost : null, days),
      4,
    ),
    daysToResolution: rounded(days, 2),
    // annualizeReturn() returns null for a non-finite input, so any of these can be
    // null when the probability estimate is unavailable — which is normal for a
    // scraped candidate that was never AI-analysed. Calling .toFixed() on that threw
    // "Cannot read properties of null (reading 'toFixed')" inside execution
    // revalidation, the candidate was stamped ERROR, and the portfolio filter then
    // rejected it as "base status ERROR is not executable". A whole shortlist of
    // perfectly tradable markets was discarded by a crash, not by any rule.
    aiProbability: rounded(probability, 4),
    rawProbability: rounded(rawProbability, 4),
    edge: rounded(economics.edge, 4),
    expectedRoi: rounded(economics.expectedRoi, 4),
    annualizedReturn: rounded(economics.annualizedReturn, 4),
    aiExpectedValueUsdc: rounded(economics.expectedValue, 4),
    aiAnnualizedReturn: rounded(economics.annualizedReturn, 4),
    grossAnnualizedIfWin: rounded(grossAnnualizedIfWin, 4),
    stakeUsdc: Number(stake.toFixed(2)),
    expectedValueUsdc: rounded(economics.expectedValue, 4),
    marketExpectedValueUsdc: rounded(marketEconomics.expectedValue, 4),
    marketExpectedRoi: rounded(marketEconomics.expectedRoi, 4),
    marketAnnualizedReturn: rounded(marketEconomics.annualizedReturn, 4),
    maxLossUsdc: Number(totalCost.toFixed(5)),
    aiAnalysis,
    probabilityThesis: aiAnalysis.thesis,
    analysisModel: aiAnalysis.model,
    analysisSummary: [
      `${aiAnalysis.thesis}`,
      `Raw probability ${(rawProbability * 100).toFixed(1)}%, calibrated probability ${(probability * 100).toFixed(1)}% vs simulated market-buy entry ${(executionPrice * 100).toFixed(1)}%.`,
      `Why this probability: ${aiAnalysis.probabilityRationale}`,
      `Why these percentage points: ${aiAnalysis.probabilityPointRationale}`,
      `AI vs Polymarket: ${aiAnalysis.marketComparisonSummary}`,
      `Best ask ${(bestAsk * 100).toFixed(1)}%, slippage ${execution.slippage == null ? "n/a" : (execution.slippage * 100).toFixed(1) + " pts"} for ${stake.toFixed(2)} USDC.`,
      `Polymarket taker fee ${takerFee.toFixed(5)} USDC (${fees.feesEnabled ? `${(fees.feeRate * 100).toFixed(1)}% ${fees.feeType}` : "fee-free market"}).`,
      `Net gain if win ${netGainIfWin.toFixed(4)} USDC; expected annualized return ${(economics.annualizedReturn * 100).toFixed(1)}% with max paper loss ${totalCost.toFixed(5)} USDC.`,
      `Selection thesis type: ${economics.thesisType}.`,
      notes.length ? notes.join(" ") : "No strong qualitative adjustment found.",
    ].join(" "),
    evidence: [
      `question=${question}`,
      `outcome=${outcome}`,
      `riskGroupKeys=${risk.keys.join(",")}`,
      `executionMode=MARKET_BUY`,
      `bestAsk=${bestAsk}`,
      `avgExecutionPrice=${executionPrice}`,
      `filledStakeUsdc=${execution.filledUsdc}`,
      `executableDepthUsdc=${execution.depthUsdc}`,
      `feesEnabled=${fees.feesEnabled}`,
      `feeRate=${fees.feeRate}`,
      `takerFeeUsdc=${takerFee}`,
      `netGainIfWinUsdc=${netGainIfWin}`,
      `rawProbability=${rawProbability}`,
      `calibratedProbability=${probability}`,
      `thesisType=${economics.thesisType}`,
      `learningFactors=${learning.factors.join(",")}`,
      `bestBid=${bestBid ?? "n/a"}`,
      `spread=${spread ?? "n/a"}`,
      `volume24hr=${volume24hr}`,
      `liquidity=${liquidity}`,
      `daysToResolution=${days ?? "n/a"}`,
    ],
  };
}

function withBinaryEvaluationMetadata(evaluation, { yesProbability, yesTokenId, noTokenId }) {
  const { _binaryCounterpart, ...clean } = evaluation;
  return {
    ...clean,
    binaryYesProbability: Number(yesProbability.toFixed(4)),
    binaryYesTokenId: String(yesTokenId || ""),
    binaryNoTokenId: String(noTokenId || ""),
  };
}

function invertedNoModelAnalysis(modelAnalysis, yesProbability) {
  const noProbability = 1 - yesProbability;
  const yesText = pctText(yesProbability);
  const noText = pctText(noProbability);
  const rationale = compactSentence(modelAnalysis?.probabilityRationale || modelAnalysis?.researchSummary || "The model assessed the YES statement from independent public evidence.");
  return {
    ...modelAnalysis,
    direction: "NO",
    thesis: `NO thesis: independent research estimates the YES statement at ${yesText}, so its inverse NO outcome is ${noText}.`,
    finalHumanConclusion: `Gemini estimates that the YES statement has only ${yesText} probability on public evidence; the displayed NO outcome is therefore the more probable inverse at ${noText}.`,
    probabilityRationale: `Gemini's public-evidence assessment assigns ${yesText} to YES. The inverse NO probability is therefore ${noText}. Evidence for the YES assessment: ${rationale}`,
    probabilityPointRationale: `The model first estimated YES at ${yesText}; NO is calculated as 100% minus YES, resulting in ${noText}.`,
    probabilityBridge: `YES ${yesText} -> inverse NO ${noText}.`,
    confidenceTier: modelAnalysis?.confidenceTier || confidenceTier(noProbability),
  };
}

function modelProbabilityForCandidate(result, candidate) {
  const expectedOutcome = String(candidate?.outcome || "").trim().toLowerCase();
  const declaredOutcome = String(result?.evaluatedOutcome || result?.probabilityFor || result?.direction || "").trim().toLowerCase();
  const probability = Number(result?.probability);
  if (!Number.isFinite(probability)) {
    return { valid: false, reason: "Gemini returned no valid probability" };
  }
  if (expectedOutcome && declaredOutcome && declaredOutcome !== expectedOutcome) {
    return {
      valid: false,
      reason: `Gemini labelled probability as ${declaredOutcome.toUpperCase()}, but this pass must return probability for ${expectedOutcome.toUpperCase()} only`,
    };
  }
  return {
    valid: true,
    probability: clamp(probability, 0.01, 0.995),
    declaredOutcome: declaredOutcome || expectedOutcome,
  };
}

async function materializePreferredBinaryOutcome(candidate, yesProbability, modelName, modelAnalysis) {
  const counterpart = candidate?._binaryCounterpart;
  if (!counterpart || yesProbability >= 0.5) {
    return withBinaryEvaluationMetadata(
      refreshEvaluationAfterProbability(candidate, yesProbability, modelName, modelAnalysis),
      {
        yesProbability,
        yesTokenId: counterpart?.yesTokenId || candidate.tokenId,
        noTokenId: counterpart?.tokenId || "",
      },
    );
  }

  const inverseAnalysis = invertedNoModelAnalysis(modelAnalysis, yesProbability);
  try {
    const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(counterpart.tokenId)}`);
    const noEvaluation = evaluateCandidate({
      market: counterpart.market,
      outcomeIndex: counterpart.outcomeIndex,
      tokenId: counterpart.tokenId,
      book,
      learningProfile: counterpart.learningProfile,
    });
    if (!noEvaluation) throw new Error("No executable orderbook data for the inverse NO outcome");
    return withBinaryEvaluationMetadata(
      refreshEvaluationAfterProbability(noEvaluation, 1 - yesProbability, modelName, inverseAnalysis),
      {
        yesProbability,
        yesTokenId: counterpart.yesTokenId || candidate.tokenId,
        noTokenId: counterpart.tokenId,
      },
    );
  } catch (error) {
    const message = `Inverse NO orderbook refresh failed: ${error?.message || String(error)}`;
    return withBinaryEvaluationMetadata(ensureEvaluationErrorMetadata({
      ...candidate,
      id: `token:${counterpart.tokenId}`,
      tokenId: counterpart.tokenId,
      outcome: counterpart.outcome || "No",
      status: "ERROR",
      rawErrorMessage: message,
      rejectReasons: [message],
      aiProbability: Number((1 - yesProbability).toFixed(4)),
      rawProbability: Number((1 - yesProbability).toFixed(4)),
      aiAnalysis: inverseAnalysis,
      probabilityThesis: inverseAnalysis.thesis,
      analysisModel: modelName,
      analysisSummary: `${inverseAnalysis.finalHumanConclusion} ${message}`,
    }), {
      yesProbability,
      yesTokenId: counterpart.yesTokenId || candidate.tokenId,
      noTokenId: counterpart.tokenId,
    });
  }
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function callOpenAiJson(messages) {
  if (!OPENAI_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages,
      }),
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const payload = await response.json();
    return parseJsonObject(payload?.choices?.[0]?.message?.content);
  } catch (error) {
    return { error: error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function messagesToGeminiText(messages) {
  return messages
    .map((message) => {
      const role = message.role === "system" ? "System" : "User";
      return `${role}:\n${message.content}`;
    })
    .join("\n\n");
}

async function callGeminiJson(messages) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const requestText = `${messagesToGeminiText(messages)}\n\nReturn only one valid JSON object.`;
  const requestBody = {
    generationConfig: {
      responseMimeType: "application/json",
    },
    tools: GEMINI_SEARCH_GROUNDING ? [{ google_search: {} }] : undefined,
    contents: [{
      role: "user",
      parts: [{
        text: requestText,
      }],
    }],
  };

  async function send() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // Gemini returns the quota dimension and sometimes a retry delay in this body.
        // Preserve enough of it to distinguish RPM/TPM/RPD/project-limit responses.
        throw new Error(`Gemini HTTP ${response.status}${detail ? `: ${detail.slice(0, 1800)}` : ""}`);
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
      const payload = await send();
    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    const parsed = parseJsonObject(text);
    if (!parsed || typeof parsed !== "object") return parsed;
    const grounding = payload?.candidates?.[0]?.groundingMetadata || null;
    return {
      ...parsed,
      _grounding: grounding ? {
        webSearchQueries: Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries.slice(0, 8) : [],
        sources: Array.isArray(grounding.groundingChunks)
          ? grounding.groundingChunks
              .map((chunk) => chunk.web)
              .filter(Boolean)
              .map((web) => ({ title: web.title || "", uri: web.uri || "" }))
              .filter((source) => source.uri)
              .slice(0, 8)
          : [],
      } : null,
      _usage: {
        promptTokens: Number(payload?.usageMetadata?.promptTokenCount || 0) || null,
        outputTokens: Number(payload?.usageMetadata?.candidatesTokenCount || 0) || null,
        totalTokens: Number(payload?.usageMetadata?.totalTokenCount || 0) || null,
      },
    };
  } catch (error) {
    return { error: error.message || String(error), provider: "gemini", model: GEMINI_MODEL };
  }
}

async function callAiJson(messages) {
  const providers = PRIMARY_AI_PROVIDER === "openai"
    ? ["openai", "gemini"]
    : ["gemini", "openai"];
  let lastError = null;

  for (const provider of providers) {
    const result = provider === "gemini"
      ? await callGeminiJson(messages)
      : await callOpenAiJson(messages);
    if (!result) continue;
    if (!result.error) {
      return {
        ...result,
        _model: provider === "gemini" ? GEMINI_MODEL : OPENAI_MODEL,
        _provider: provider,
      };
    }
    lastError = result;
  }

  return lastError || null;
}

function refreshEvaluationAfterProbability(evaluation, probability, modelName, modelAnalysis) {
  const stake = Number(evaluation.stakeUsdc || PORTFOLIO_USDC * MAX_FRACTION);
  const takerFee = Number(evaluation.takerFeeUsdc || 0);
  const totalCostValue = Number(evaluation.totalCostUsdc || stake + takerFee);
  const execution = {
    avgPrice: Number(evaluation.marketPrice),
    shares: Number(evaluation.executableShares),
  };
  const spread = Number(evaluation.spread);
  const spreadOk = Number.isFinite(spread) && spread <= MAX_SPREAD;
  const liquidity = Number(evaluation.liquidity || 0);
  const volume24hr = Number(evaluation.volume24hr || 0);
  const volumeOk = volume24hr >= MIN_VOLUME_24H || liquidity >= MIN_VOLUME_24H;
  const depthOk = Number(evaluation.filledStakeUsdc || 0) >= stake * 0.999;
  const days = Number(evaluation.daysToResolution);
  const endOk = endDateIsFuture(evaluation.endDate);
  const economics = economicsForProbability({
    probability,
    execution,
    stake,
    takerFee,
    totalCost: totalCostValue,
    days: Number.isFinite(days) ? days : null,
    spreadOk,
    volumeOk,
    depthOk,
    endOk,
  });
  const marketProbability = validMarketProbability(evaluation.marketProbability) ?? Number(evaluation.marketPrice);
  const marketEconomics = Number.isFinite(marketProbability)
    ? economicsForProbability({
        probability: marketProbability,
        execution,
        stake,
        takerFee,
        totalCost: totalCostValue,
        days: Number.isFinite(days) ? days : null,
        spreadOk,
        volumeOk,
        depthOk,
        endOk,
      })
    : null;

  // The same rule the main evaluation path uses: with the AI pipeline retired, the verdict
  // has to come from the market's own economics rather than from an AI probability nothing
  // produces any more. It was referenced below without ever being declared here, so every
  // call threw ReferenceError -- and this function is what revalidates a stored execution
  // candidate, so the throw came back as "revalidation failed ... base status ERROR is not
  // executable" on every conservative candidate at once and the portfolio stopped opening
  // orders. The fallback covers a market whose own probability cannot be read: judged by
  // something is right, and crashing the whole shortlist is not.
  const scoringEconomics = (AI_ANALYSIS_ENABLED ? economics : marketEconomics) || economics;

  const rejectReasons = economics.rejectReasons.map((reason) => {
    if (reason === "spread too wide") return `spread ${Number.isFinite(spread) ? (spread * 100).toFixed(1) + " pts" : "n/a"} too wide`;
    if (reason === "insufficient ask depth for market buy") return `insufficient ask depth for ${stake.toFixed(2)} USDC market buy`;
    return reason;
  });
  const probabilityRationale = compactSentence(
    modelAnalysis?.probabilityRationale
      || modelAnalysis?.researchSummary
      || modelAnalysis?.thesis
      || evaluation.probabilityThesis
      || "No source-grounded probability rationale was returned by the model."
  );
  const probabilityPointRationale = compactSentence(
    modelAnalysis?.probabilityPointRationale
      || `The model's independent probability is ${pctText(probability)}; the difference versus Polymarket is computed after the forecast from the entry price ${pctText(evaluation.marketPrice)}.`
  );
  const marketComparisonSummary = buildMarketComparisonSummary({
    probability,
    marketProbability: evaluation.marketProbability ?? evaluation.marketPrice,
    rationale: probabilityRationale,
  });
  const aiAnalysis = {
    ...(evaluation.aiAnalysis || {}),
    ...modelAnalysis,
    model: modelName,
    analysisSchemaVersion: modelAnalysis?.analysisSchemaVersion || GROUNDED_AI_ANALYSIS_VERSION,
    probability: Number(probability.toFixed(4)),
    probabilityMethod: "independent-public-research",
    marketImpliedProbability: Number(evaluation.marketProbability ?? evaluation.marketPrice),
    edge: rounded(economics.edge, 4),
    probabilityRationale,
    probabilityPointRationale,
    marketComparisonSummary,
    expectedValueUsdc: rounded(economics.expectedValue, 4),
    annualizedReturn: rounded(economics.annualizedReturn, 4),
    confidenceTier: modelAnalysis?.confidenceTier || confidenceTier(probability),
    provider: modelAnalysis?._provider || modelAnalysis?.provider || null,
  };
  const keyFacts = formatKeyFacts(aiAnalysis.keyFacts);
  const groundingSources = formatGroundingSources(aiAnalysis.groundingSources);
  const evidence = Array.isArray(aiAnalysis.evidence) && aiAnalysis.evidence.length
    ? aiAnalysis.evidence.map((item) => `- ${compactSentence(item)}`).join(" ")
    : "";
  const counterEvidence = Array.isArray(aiAnalysis.counterEvidence) && aiAnalysis.counterEvidence.length
    ? aiAnalysis.counterEvidence.map((item) => `- ${compactSentence(item)}`).join(" ")
    : "";
  const groundedSummary = [
    aiAnalysis.finalHumanConclusion ? `Zaver: ${compactSentence(aiAnalysis.finalHumanConclusion)}` : "",
    aiAnalysis.researchSummary ? `Verejna fakta: ${compactSentence(aiAnalysis.researchSummary)}` : "",
    keyFacts ? `Klicova fakta: ${keyFacts}` : "",
    `AI probability ${(probability * 100).toFixed(1)}%.`,
    aiAnalysis.probabilityRationale ? `Proc tato pravdepodobnost: ${aiAnalysis.probabilityRationale}` : "",
    aiAnalysis.probabilityPointRationale ? `Kalibrace procent: ${aiAnalysis.probabilityPointRationale}` : "",
    aiAnalysis.probabilityBridge ? `Mostek vypoctu: ${compactSentence(aiAnalysis.probabilityBridge)}` : "",
    evidence ? `Evidence: ${evidence}` : "",
    counterEvidence ? `Nejistoty/protiargumenty: ${counterEvidence}` : "",
    groundingSources ? `Zdroje: ${groundingSources}` : "",
  ].filter(Boolean).join(" ");

  return {
    ...evaluation,
    status: scoringEconomics.status,
    thesisType: scoringEconomics.thesisType,
    rejectReasons,
    aiProbability: Number(probability.toFixed(4)),
    edge: rounded(economics.edge, 4),
    expectedRoi: rounded(economics.expectedRoi, 4),
    annualizedReturn: rounded(economics.annualizedReturn, 4),
    expectedValueUsdc: rounded(economics.expectedValue, 4),
    aiExpectedValueUsdc: rounded(economics.expectedValue, 4),
    aiAnnualizedReturn: rounded(economics.annualizedReturn, 4),
    marketExpectedValueUsdc: marketEconomics ? Number(marketEconomics.expectedValue.toFixed(4)) : null,
    marketExpectedRoi: marketEconomics ? Number(marketEconomics.expectedRoi.toFixed(4)) : null,
    marketAnnualizedReturn: marketEconomics ? Number(marketEconomics.annualizedReturn.toFixed(4)) : null,
    aiAnalysis,
    probabilityThesis: aiAnalysis.thesis || evaluation.probabilityThesis,
    analysisModel: modelName,
    analysisSummary: groundedSummary || [
      aiAnalysis.thesis || evaluation.probabilityThesis || "AI analysis produced no thesis.",
      `Independent AI probability ${(probability * 100).toFixed(1)}%; Polymarket entry is used only after the AI estimate for EV calculation.`,
      aiAnalysis.probabilityRationale ? `Why this probability: ${aiAnalysis.probabilityRationale}` : "",
      aiAnalysis.probabilityPointRationale ? `Why these percentage points: ${aiAnalysis.probabilityPointRationale}` : "",
      aiAnalysis.marketComparisonSummary ? `AI vs Polymarket: ${aiAnalysis.marketComparisonSummary}` : "",
      `Edge ${(economics.edge * 100).toFixed(1)} pts; expected annualized return ${(economics.annualizedReturn * 100).toFixed(1)}%; thesis type ${economics.thesisType}.`,
    ].filter(Boolean).join(" "),
  };
}

function hasIndependentResearch(item) {
  return item?.aiAnalysis?.probabilityMethod === "independent-public-research";
}

function longEnough(value, minLength) {
  return String(value || "").trim().length >= minLength;
}

function hasStoredGroundedPublicMemo(item) {
  const analysis = item?.aiAnalysis || {};
  return analysis.analysisSchemaVersion === GROUNDED_AI_ANALYSIS_VERSION
    && longEnough(analysis.probabilityRationale, 80)
    && longEnough(analysis.probabilityPointRationale, 70)
    && longEnough(analysis.researchSummary, 140)
    && (Array.isArray(analysis.keyFacts) ? analysis.keyFacts.length >= 2 : Array.isArray(analysis.evidence) && analysis.evidence.length >= 2);
}

function hasGroundedPublicMemo(item) {
  if (item?.selectionStatus === "AI_PENDING" || item?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED") return false;
  return hasStoredGroundedPublicMemo(item);
}

function formatKeyFact(fact) {
  if (!fact || typeof fact !== "object") return compactSentence(fact);
  const source = compactSentence(fact.source || fact.authority || fact.publisher || "");
  const date = compactSentence(fact.date || fact.asOf || "");
  const impact = compactSentence(fact.impact || fact.effect || "");
  const effect = Number(fact.probabilityEffectPts);
  const effectText = Number.isFinite(effect) ? `${effect >= 0 ? "+" : ""}${effect.toFixed(1)} pp` : "";
  const text = compactSentence(fact.fact || fact.summary || fact.text || "");
  return [
    source || "public source",
    date ? `(${date})` : "",
    text ? `- ${text}` : "",
    impact ? `Impact: ${impact}.` : "",
    effectText ? `Calibration: ${effectText}.` : "",
  ].filter(Boolean).join(" ");
}

function formatKeyFacts(facts = []) {
  const rows = Array.isArray(facts) ? facts.map(formatKeyFact).filter(Boolean).slice(0, 5) : [];
  return rows.length ? rows.map((fact) => `- ${fact}`).join(" ") : "";
}

function formatGroundingSources(sources = []) {
  if (!Array.isArray(sources) || !sources.length) return "";
  return sources
    .map((source) => compactSentence(source.title || source.uri || ""))
    .filter(Boolean)
    .slice(0, 5)
    .join("; ");
}

function isQuotaError(result) {
  return /quota|rate limit|429/i.test(String(result?.error || ""));
}

function markAiAnalysisUnavailable(item, message) {
  const reason = compactSentence(message || "Gemini grounded AI analysis unavailable");
  return ensureEvaluationErrorMetadata({
    ...item,
    status: "ERROR",
    errorType: "AI_ANALYSIS_UNAVAILABLE",
    errorReason: `Gemini grounded AI analysis unavailable: ${reason}. Trade selection is blocked because Gemini analysis is required.`,
    rejectReasons: [
      `Gemini grounded AI analysis unavailable: ${reason}`,
      ...(Array.isArray(item.rejectReasons) ? item.rejectReasons : []),
    ],
    aiAnalysis: {
      ...(item.aiAnalysis || {}),
      aiModelError: reason,
      requiredModel: GEMINI_MODEL,
      provider: "gemini",
    },
    analysisSummary: `Gemini grounded AI analysis unavailable: ${reason}. This opportunity was not allowed to trade from heuristic-only analysis.`,
  });
}

function markAiAnalysisDeferred(item, message) {
  const reason = compactSentence(String(message || "Gemini grounded AI analysis was deferred")
    .replace(/(?:Gemini grounded AI analysis is pending:\s*)+/gi, "")
    .replace(/(?:\.?\s*The item will be retried by a later scheduled evaluation run\.?)+/gi, "")
    .trim());
  return ensureEvaluationErrorMetadata({
    ...item,
    status: "ERROR",
    errorType: "AI_ANALYSIS_PENDING",
    errorReason: `Gemini grounded AI analysis is pending: ${reason}. The item will be retried by a later scheduled evaluation run.`,
    selectionStatus: "AI_PENDING",
    aiAnalysis: {
      ...(item.aiAnalysis || {}),
      aiModelStatus: "QUOTA_LIMITED",
      aiModelError: reason,
      requiredModel: GEMINI_MODEL,
      provider: "gemini",
    },
    analysisSummary: `Gemini grounded AI analysis is pending because the API rate limit or quota was reached: ${reason}. This is not an evaluated opportunity and cannot be selected for trading until a grounded memo is completed.`,
  });
}

function normalizeAiPendingEvaluation(item) {
  const pending = item?.selectionStatus === "AI_PENDING" || item?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  if (!pending) return item;
  if (!hasStoredGroundedPublicMemo(item)) {
    return markAiAnalysisDeferred(item, item.errorReason || item.aiAnalysis?.aiModelError || item.analysisSummary);
  }
  const { aiModelStatus, aiModelError, ...completedAnalysis } = item.aiAnalysis || {};
  return {
    ...item,
    selectionStatus: null,
    aiAnalysis: completedAnalysis,
    lastAiRetryAt: item.lastAiRetryAt || item.lastSeenAt || nowIso(),
    lastAiRetryStatus: item.lastAiRetryStatus || aiModelStatus || "QUOTA_LIMITED",
    lastAiRetryReason: item.lastAiRetryReason || aiModelError || null,
  };
}

function aiUsageEntries(state) {
  return Array.isArray(state?.aiUsageLog) ? state.aiUsageLog : [];
}

function pacificDateStamp(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function nextPacificQuotaReset(now = Date.now()) {
  try {
    const currentDate = pacificDateStamp(now);
    let lower = now;
    let upper = now + 36 * 60 * 60 * 1000;
    while (pacificDateStamp(upper) === currentDate) upper += 24 * 60 * 60 * 1000;
    while (upper - lower > 1000) {
      const midpoint = Math.floor((lower + upper) / 2);
      if (pacificDateStamp(midpoint) === currentDate) lower = midpoint;
      else upper = midpoint;
    }
    // Leave a small safety margin after the provider-side daily reset.
    return new Date(upper + 5 * 60 * 1000).toISOString();
  } catch {
    return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  }
}

function quotaBackoffUntil(error, now = Date.now()) {
  const text = String(error || "");
  const match = text.match(/retry(?:\s+in|[_\s-]*delay)?[^\d]*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit.startsWith("h") ? 3600000 : unit.startsWith("m") ? 60000 : 1000;
    if (Number.isFinite(amount) && amount > 0) return new Date(now + amount * multiplier + 5000).toISOString();
  }
  return nextPacificQuotaReset(now);
}

function recordAiQuotaBackoff(state, error) {
  if (!state) return;
  const now = Date.now();
  state.aiUsage = {
    ...aiUsageSnapshot(state, now),
    quotaBlockedUntil: quotaBackoffUntil(error, now),
    quotaBlockedReason: compactSentence(error || "Gemini quota/rate limit response"),
  };
}

function aiUsageSnapshot(state, now = Date.now()) {
  const entries = aiUsageEntries(state).filter((entry) => {
    const time = Date.parse(entry.requestedAt || "");
    return Number.isFinite(time) && time >= now - 86400000;
  });
  const inWindow = (duration) => entries.filter((entry) => Date.parse(entry.requestedAt || "") >= now - duration);
  const minute = inWindow(60000);
  const hour = inWindow(3600000);
  const successful = (rows) => rows.filter((entry) => entry.status === "SUCCESS").length;
  const quotaErrors = (rows) => rows.filter((entry) => entry.status === "QUOTA_LIMITED").length;
  const inputTokens = (rows) => rows.reduce((total, entry) => total + Math.max(0, Number(entry.inputTokens ?? entry.estimatedInputTokens ?? 0)), 0);
  const last = [...entries].sort((a, b) => Date.parse(b.requestedAt || "") - Date.parse(a.requestedAt || ""))[0] || null;
  const nextFromInterval = last ? Date.parse(last.requestedAt || "") + AI_MIN_INTERVAL_SECONDS * 1000 : 0;
  const oldestHour = hour[0] ? Date.parse(hour[0].requestedAt || "") + 3600000 : 0;
  const oldestMinute = minute[0] ? Date.parse(minute[0].requestedAt || "") + 60000 : 0;
  const oldestDay = entries[0] ? Date.parse(entries[0].requestedAt || "") + 86400000 : 0;
  const storedQuotaModel = String(state?.aiUsage?.model || "");
  const storedQuotaBlockedUntil = storedQuotaModel && storedQuotaModel !== GEMINI_MODEL
    ? 0
    : Date.parse(state?.aiUsage?.quotaBlockedUntil || "") || 0;
  const quotaBlockedUntil = storedQuotaBlockedUntil > now ? new Date(storedQuotaBlockedUntil).toISOString() : null;
  const nextAvailable = Math.max(
    nextFromInterval,
    minute.length >= AI_MAX_REQUESTS_PER_MINUTE ? oldestMinute : 0,
    hour.length >= AI_MAX_REQUESTS_PER_HOUR ? oldestHour : 0,
    entries.length >= AI_MAX_REQUESTS_PER_DAY ? oldestDay : 0,
    storedQuotaBlockedUntil > now ? storedQuotaBlockedUntil : 0,
  );
  return {
    model: GEMINI_MODEL,
    requestsLastMinute: minute.length,
    inputTokensLastMinute: inputTokens(minute),
    requestsLastHour: hour.length,
    requestsLast24Hours: entries.length,
    successfulLastMinute: successful(minute),
    successfulLastHour: successful(hour),
    successfulLast24Hours: successful(entries),
    quotaErrorsLast24Hours: quotaErrors(entries),
    maxRequestsPerHour: AI_MAX_REQUESTS_PER_HOUR,
    maxRequestsPerMinute: AI_MAX_REQUESTS_PER_MINUTE,
    maxInputTokensPerMinute: AI_MAX_INPUT_TOKENS_PER_MINUTE,
    maxRequestsPer24Hours: AI_MAX_REQUESTS_PER_DAY,
    executionReserveRequests: AI_EXECUTION_RESERVE_REQUESTS,
    backgroundRequestBudget: Math.max(0, AI_MAX_REQUESTS_PER_DAY - AI_EXECUTION_RESERVE_REQUESTS),
    minIntervalSeconds: AI_MIN_INTERVAL_SECONDS,
    estimatedDailyCapacity: Math.min(AI_MAX_REQUESTS_PER_DAY, Math.floor(86400 / Math.max(1, AI_MIN_INTERVAL_SECONDS))),
    nextAvailableAt: nextAvailable > now ? new Date(nextAvailable).toISOString() : null,
    lastRequestAt: last?.requestedAt || null,
    lastRequestStatus: last?.status || null,
    lastError: last?.error || null,
    quotaBlockedUntil,
    quotaBlockedReason: quotaBlockedUntil ? state?.aiUsage?.quotaBlockedReason || null : null,
    deferredRuns: Number(state?.aiUsage?.deferredRuns || 0),
    lastDeferredAt: state?.aiUsage?.lastDeferredAt || null,
  };
}

function reserveAiRequest(state, estimatedInputTokens = 0, metadata = {}) {
  const entry = {
    id: `ai-${nowIso()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedAt: nowIso(),
    status: "IN_FLIGHT",
    model: GEMINI_MODEL,
    estimatedInputTokens: Math.max(0, Number(estimatedInputTokens) || 0),
    evaluationKey: metadata.evaluationKey || null,
    phase: metadata.phase || "research",
  };
  state.aiUsageLog = [...aiUsageEntries(state), entry].slice(-Math.max(20, AI_USAGE_HISTORY_LIMIT));
  state.aiUsage = aiUsageSnapshot(state);
  return entry.id;
}

function finishAiRequest(state, id, status, error = "", usage = null) {
  state.aiUsageLog = aiUsageEntries(state).map((entry) => entry.id === id
    ? {
        ...entry,
        completedAt: nowIso(),
        status,
        error: error ? compactSentence(error) : null,
        inputTokens: Number(usage?.promptTokens) || entry.estimatedInputTokens || 0,
        outputTokens: Number(usage?.outputTokens) || null,
        totalTokens: Number(usage?.totalTokens) || null,
      }
    : entry);
  state.aiUsage = aiUsageSnapshot(state);
}

function deferAiRun(state, reason) {
  state.aiUsage = {
    ...aiUsageSnapshot(state),
    deferredRuns: Number(state?.aiUsage?.deferredRuns || 0) + 1,
    lastDeferredAt: nowIso(),
    lastDeferredReason: compactSentence(reason),
  };
}

function aiSlotAvailability(state, nextInputTokens = 0) {
  const snapshot = aiUsageSnapshot(state);
  const backgroundDailyBudget = Math.max(0, AI_MAX_REQUESTS_PER_DAY - AI_EXECUTION_RESERVE_REQUESTS);
  if (snapshot.quotaBlockedUntil) {
    return { allowed: false, reason: `Gemini quota backoff until ${snapshot.quotaBlockedUntil}`, snapshot };
  }
  if (snapshot.requestsLast24Hours >= backgroundDailyBudget) {
    return { allowed: false, reason: `AI background daily budget reached (${backgroundDailyBudget}/24h; ${AI_EXECUTION_RESERVE_REQUESTS} reserved for execution)`, snapshot };
  }
  if (snapshot.requestsLastMinute >= AI_MAX_REQUESTS_PER_MINUTE) {
    return { allowed: false, reason: `AI minute request budget reached (${AI_MAX_REQUESTS_PER_MINUTE}/min)`, snapshot };
  }
  if (snapshot.inputTokensLastMinute + Math.max(0, Number(nextInputTokens) || 0) > AI_MAX_INPUT_TOKENS_PER_MINUTE) {
    return { allowed: false, reason: `AI minute input-token budget reached (${AI_MAX_INPUT_TOKENS_PER_MINUTE}/min)`, snapshot };
  }
  if (snapshot.requestsLastHour >= AI_MAX_REQUESTS_PER_HOUR) {
    return { allowed: false, reason: `AI hourly request budget reached (${AI_MAX_REQUESTS_PER_HOUR}/h)`, snapshot };
  }
  if (snapshot.nextAvailableAt) {
    return { allowed: false, reason: `AI request slot is reserved until ${snapshot.nextAvailableAt}`, snapshot };
  }
  return { allowed: true, reason: "AI request slot available", snapshot };
}

async function enrichEvaluationsWithAi(evaluations, learningProfile, state = null) {
  if (!GEMINI_API_KEY || AI_ANALYSIS_LIMIT <= 0) return evaluations;
  const storedByKey = new Map((state?.evaluations || []).map((item) => [evaluationKey(item), item]).filter(([key]) => key));
  const carriedMemos = new Map();
  const candidates = [...evaluations]
    .filter((item) => item.status !== "ERROR")
    .filter((item) => {
      const stored = storedByKey.get(evaluationKey(item));
      if (!stored || !hasGroundedPublicMemo(stored)) return true;
      const lastGroundedAt = Date.parse(stored.evaluatedAt || stored.lastSeenAt || "");
      if (!Number.isFinite(lastGroundedAt) || Date.now() - lastGroundedAt >= 86400000) return true;
      carriedMemos.set(evaluationKey(item), stored);
      return false;
    })
    .sort((a, b) => {
      if (hasGroundedPublicMemo(a) !== hasGroundedPublicMemo(b)) return hasGroundedPublicMemo(a) ? 1 : -1;
      if (hasIndependentResearch(a) !== hasIndependentResearch(b)) return hasIndependentResearch(a) ? 1 : -1;
      if (a.status !== b.status) return a.status === "ELIGIBLE" ? -1 : 1;
      const horizon = compareShorterHorizon(a, b);
      if (horizon !== 0) return horizon;
      if (b.expectedValueUsdc !== a.expectedValueUsdc) return b.expectedValueUsdc - a.expectedValueUsdc;
      return b.annualizedReturn - a.annualizedReturn;
    })
    .slice(0, AI_ANALYSIS_LIMIT);
  const byId = new Map(evaluations.map((item) => [item.id, item]));
  let quotaResponseReceived = false;
  const attemptedIds = new Set();

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (candidateIndex > 0 && AI_REQUEST_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, AI_REQUEST_DELAY_MS));
    }
    const prompt = {
      task: "Deep-research this prediction-market event and estimate the true probability of the selected outcome using public evidence only.",
      strictRules: [
        "Do not search for, infer from, mention, or use Polymarket prices, odds, order books, volume, liquidity, market-implied probability, or betting consensus.",
        "The probability must be independent of Polymarket. Treat market pricing as unavailable.",
        "Use verified public information with strong causal relevance to the event outcome: official sources, primary data, reputable news, match/event schedules, statements, results, or authoritative statistics.",
        "Search the web if needed. Prefer recent and primary sources. If evidence is weak or conflicting, lower confidence instead of copying market intuition.",
        "Evidence bullets must name the source or authority, include the date/as-of date when available, and state the concrete fact learned, for example an official schedule, regulator release, company statement, weather service, or reputable news outlet.",
        "Do not write generic filler such as 'market conditions suggest' or 'current sentiment indicates' unless it is tied to a named public source and a concrete fact.",
        "For macro/central-bank markets, use official central-bank communications, inflation/jobs/activity data, and reputable reporting about policymakers; do not use prediction-market odds or betting consensus.",
        "For YES/NO markets, estimate the probability that the selected outcome is true by resolution time. For multi-outcome markets, estimate the selected outcome only.",
        "For a binary market, this initial research pass always has candidate.outcome = YES. The probability field must therefore mean probability of YES only. Never select NO or return probability for NO; the application inverts a sub-50% YES result itself after the analysis is complete.",
        "Always include a fact-based human-language sentence explaining why the final probability is exactly in this range, grounded in the public evidence you found.",
        "Always explain the percentage-point calibration: which facts push probability upward, which facts cap or reduce it, and why the final percentage is not merely a vague likely/unlikely label.",
        "Write the rationale in Czech, concise but concrete. Keep each field short enough for a dashboard detail modal.",
        "Return calibrated probability, not trade recommendation. EV is calculated later outside the model.",
      ],
      candidate: {
        question: candidate.question,
        outcome: candidate.outcome,
        endDate: candidate.endDate,
        daysToResolution: candidate.daysToResolution,
        tags: candidate.tags,
        riskGroupLabels: candidate.riskGroupLabels,
      },
      learningProfile: {
        sampleSize: learningProfile.sampleSize,
        brierScore: learningProfile.brierScore,
        calibrationBias: learningProfile.calibrationBias,
        promptRules: learningProfile.promptRules,
      },
      requiredJson: {
        evaluatedOutcome: "must exactly repeat candidate.outcome; for a binary research pass this is always YES",
        probability: "number from 0.01 to 0.995",
        thesis: "one Czech sentence with the core forecast",
        finalHumanConclusion: "one Czech sentence: based on named public facts, why the final probability is exactly this high/low",
        probabilityRationale: "one clear Czech human sentence explaining why the final probability is what it is, based on verified public evidence",
        probabilityPointRationale: "one concise Czech sentence explaining the percentage-point calibration: facts pushing up, facts pushing down, and why the final number lands there",
        probabilityBridge: "one Czech sentence with a rough base-rate/adjustment bridge, e.g. start near X%, add Y pp for fact A, subtract Z pp for uncertainty B",
        confidenceTier: "near-certain | high | edge-watch | uncertain | long-shot",
        keyFacts: [
          {
            source: "source or authority name",
            date: "publication/as-of date if known",
            fact: "specific public fact used",
            impact: "pushes probability up | pushes probability down | caps probability",
            probabilityEffectPts: "approximate percentage-point effect as a signed number",
          },
        ],
        evidence: ["short Czech bullet with a named public source and concrete fact"],
        counterEvidence: ["short Czech bullet with uncertainty or contrary public fact"],
        researchSummary: "2-4 concise Czech sentences explaining the public evidence chain, with named facts rather than generic commentary",
        sourceQuality: "primary | reputable-news | mixed | weak",
      },
    };
    const messages = [
      { role: "system", content: "You are a cautious forecasting analyst doing source-grounded public research. You must ignore prediction-market pricing and betting consensus. You write concrete Czech rationales based on named public facts, not generic trading commentary. Return only valid JSON." },
      { role: "user", content: JSON.stringify(prompt) },
    ];
    const estimatedInputTokens = Math.ceil(messagesToGeminiText(messages).length / 4) + 128;
    if (state) {
      const slot = aiSlotAvailability(state, estimatedInputTokens);
      if (!slot.allowed) {
        deferAiRun(state, slot.reason);
        quotaResponseReceived = true;
        break;
      }
    }
    const requestId = state ? reserveAiRequest(state, estimatedInputTokens, { evaluationKey: evaluationKey(candidate), phase: "research" }) : null;
    attemptedIds.add(candidate.id);
    let result = await callGeminiJson(messages);
    if (!result || result.error) {
      const message = result?.error || "Gemini public-research analysis unavailable";
      const quotaLimited = isQuotaError(result);
      if (requestId) finishAiRequest(state, requestId, quotaLimited ? "QUOTA_LIMITED" : "ERROR", message);
      if (quotaLimited) recordAiQuotaBackoff(state, message);
      const deferredMessage = quotaLimited && state?.aiUsage?.quotaBlockedUntil
        ? `${message}. Retry deferred until ${state.aiUsage.quotaBlockedUntil}`
        : message;
      byId.set(candidate.id, REQUIRE_GEMINI && !quotaLimited
        ? markAiAnalysisUnavailable(candidate, message)
        : quotaLimited
          ? markAiAnalysisDeferred(candidate, deferredMessage)
          : {
            ...candidate,
            aiAnalysis: {
              ...(candidate.aiAnalysis || {}),
              aiModelError: message,
            },
          });
      if (AI_STOP_ON_QUOTA_ERROR && quotaLimited) {
        quotaResponseReceived = true;
        break;
      }
      continue;
    }
    if (requestId) finishAiRequest(state, requestId, "SUCCESS", "", result._usage);

    const researchResult = result;
    let criticResult = null;
    if (AI_CRITIC_ENABLED) {
      await new Promise((resolve) => setTimeout(resolve, AI_REQUEST_DELAY_MS));
      const criticPrompt = {
        task: "Independently audit this prediction-market research. Search public sources yourself, challenge omissions and calibration, then return the final probability. Do not use market prices or betting consensus.",
        candidate: prompt.candidate,
        preliminaryResearch: {
          probability: result.probability,
          thesis: result.thesis,
          keyFacts: result.keyFacts,
          evidence: result.evidence,
          counterEvidence: result.counterEvidence,
          probabilityRationale: result.probabilityRationale,
        },
        strictRules: prompt.strictRules,
        requiredJson: prompt.requiredJson,
      };
      const criticMessages = [
        { role: "system", content: "You are an independent forecasting critic. Verify public facts yourself, correct unsupported claims, and return only valid JSON in Czech." },
        { role: "user", content: JSON.stringify(criticPrompt) },
      ];
      const criticEstimate = Math.ceil(messagesToGeminiText(criticMessages).length / 4) + 128;
      if (state) {
        const slot = aiSlotAvailability(state, criticEstimate);
        if (!slot.allowed) {
          deferAiRun(state, slot.reason);
          byId.set(candidate.id, markAiAnalysisDeferred(candidate, `Gemini critic pass deferred: ${slot.reason}`));
          quotaResponseReceived = true;
          break;
        }
      }
      const criticRequestId = state ? reserveAiRequest(state, criticEstimate, { evaluationKey: evaluationKey(candidate), phase: "critic" }) : null;
      criticResult = await callGeminiJson(criticMessages);
      if (!criticResult || criticResult.error) {
        const message = criticResult?.error || "Gemini critic analysis unavailable";
        const quotaLimited = isQuotaError(criticResult);
        if (criticRequestId) finishAiRequest(state, criticRequestId, quotaLimited ? "QUOTA_LIMITED" : "ERROR", message);
        if (quotaLimited) recordAiQuotaBackoff(state, message);
        const deferredMessage = quotaLimited && state?.aiUsage?.quotaBlockedUntil
          ? `${message}. Retry deferred until ${state.aiUsage.quotaBlockedUntil}`
          : message;
        byId.set(candidate.id, quotaLimited ? markAiAnalysisDeferred(candidate, deferredMessage) : markAiAnalysisUnavailable(candidate, message));
        if (AI_STOP_ON_QUOTA_ERROR && quotaLimited) {
          quotaResponseReceived = true;
          break;
        }
        continue;
      }
      if (criticRequestId) finishAiRequest(state, criticRequestId, "SUCCESS", "", criticResult._usage);
      result = criticResult;
    }
    const probabilityResult = modelProbabilityForCandidate(result, candidate);
    if (!probabilityResult.valid) {
      if (requestId) finishAiRequest(state, requestId, "ERROR", probabilityResult.reason);
      byId.set(candidate.id, markAiAnalysisUnavailable(candidate, probabilityResult.reason));
      continue;
    }
    const probability = probabilityResult.probability;
    const modelAnalysis = {
      direction: outcomeKind(candidate.outcome),
      evaluatedOutcome: probabilityResult.declaredOutcome,
      thesis: result.thesis || candidate.probabilityThesis,
      finalHumanConclusion: result.finalHumanConclusion || "",
      probabilityRationale: result.probabilityRationale || "",
      probabilityPointRationale: result.probabilityPointRationale || "",
      probabilityBridge: result.probabilityBridge || "",
      confidenceTier: result.confidenceTier || confidenceTier(probability),
      keyFacts: Array.isArray(result.keyFacts) ? result.keyFacts.slice(0, 6) : [],
      evidence: Array.isArray(result.evidence) ? result.evidence.slice(0, 6) : [],
      counterEvidence: Array.isArray(result.counterEvidence) ? result.counterEvidence.slice(0, 6) : [],
      researchSummary: result.researchSummary || "",
      sourceQuality: result.sourceQuality || "",
      analysisSchemaVersion: GROUNDED_AI_ANALYSIS_VERSION,
      groundingQueries: result._grounding?.webSearchQueries || [],
      groundingSources: result._grounding?.sources || [],
      source: "gemini-grounded-public-research",
      researchPass: {
        probability: Number(researchResult.probability) || null,
        thesis: researchResult.thesis || "",
        keyFacts: Array.isArray(researchResult.keyFacts) ? researchResult.keyFacts.slice(0, 6) : [],
      },
      aiRequestUsage: {
        totalRequests: AI_CRITIC_ENABLED ? 2 : 1,
        research: researchResult._usage || null,
        critic: criticResult?._usage || null,
      },
      _provider: "gemini",
    };
    byId.set(candidate.id, await materializePreferredBinaryOutcome(
      candidate,
      probability,
      result._model || GEMINI_MODEL,
      modelAnalysis,
    ));
  }
  // A 429 is authoritative for this run. Persist only requests that Gemini
  // actually received (plus existing carried memos), leaving all other market
  // observations untouched for the next scheduled evaluation.
  const output = quotaResponseReceived
    ? evaluations.filter((item) => attemptedIds.has(item.id) || carriedMemos.has(evaluationKey(item)))
    : evaluations;

  return output.map((item) => {
    const carried = carriedMemos.get(evaluationKey(item));
    if (!carried) {
      const { _binaryCounterpart, ...clean } = byId.get(item.id) || item;
      return clean;
    }
    const refreshed = refreshEvaluationAfterProbability(
      item,
      Number(carried.aiProbability),
      carried.analysisModel || carried.aiAnalysis?.model || GEMINI_MODEL,
      carried.aiAnalysis || {},
    );
    const { _binaryCounterpart, ...clean } = refreshed;
    return clean;
  });
}

function openRisk(trades) {
  return trades
    .filter((trade) => OPEN_STATUSES.has(trade.status))
    .reduce((sum, trade) => sum + Number(trade.maxLossUsdc || trade.stakeUsdc || 0), 0);
}

// Capital held by resting buys that have not filled.
//
// A limit order is not a position. It is an offer sitting on the book at a price the market
// has not come down to, and it may never fill -- once the event ends it is discarded with
// no stake spent at all. Counting it as committed capital is what stopped a portfolio
// placing any further orders: a handful of resting bids reserved the whole account while
// owning nothing.
function waitingLimitOrderRisk(trades) {
  return (Array.isArray(trades) ? trades : [])
    .filter((trade) => String(trade?.status || "") === "LIMIT_ORDER_WAITING")
    .reduce((sum, trade) => sum + Number(trade.maxLossUsdc || trade.stakeUsdc || 0), 0);
}

// The other half of openRisk: capital that really is in a position. This is what a fill has
// to be funded out of, because a fill is what turns a reservation into exposure.
function positionRisk(trades) {
  return (Array.isArray(trades) ? trades : [])
    .filter((trade) => OPEN_STATUSES.has(trade?.status) && String(trade?.status || "") !== "LIMIT_ORDER_WAITING")
    .reduce((sum, trade) => sum + Number(trade.maxLossUsdc || trade.stakeUsdc || 0), 0);
}

// What the next order may be sized against.
//
// For a portfolio buying at the market this is free capital as it always was: every open
// position is real exposure. For one resting limit orders it is free capital plus whatever
// those unfilled orders are holding, because they are not exposure yet and waiting on them
// is waiting on something that may never happen.
//
// The consequence is deliberate and worth naming: a portfolio can have more capital
// promised to resting orders than it owns, and if an unusual number of them fill at once it
// is committed beyond its balance. That is the trade being made -- an order that never
// fills costs nothing, so the alternative is an account that stops trading because of
// offers nobody took. Both figures are published, so the position is never hidden.
function deployableCapital(portfolioState, strategy, sizingCapital) {
  const committed = openRisk(portfolioState.trades || []);
  const resting = strategy?.useLimitOrders ? waitingLimitOrderRisk(portfolioState.trades || []) : 0;
  return Math.max(0, sizingCapital - committed + resting);
}

function alreadyOpen(trades, tokenId) {
  return trades.some((trade) => OPEN_STATUSES.has(trade.status) && trade.tokenId === tokenId);
}

// Correlation blocking exists to stop a portfolio losing twice on the same thing. Two
// alternatives of the same multi-outcome event cannot both win, so holding two of them is a
// spread and not a concentration -- refusing the second refuses a hedge.
//
// Reported: portfolios skipping with "no eligible non-correlated candidate" while free
// capital and candidates both existed. Measured over those skips: 25 of 32 blocks came from
// real positions rather than resting orders, and the keys were overwhelmingly one event's
// mutually exclusive alternatives -- nine of them on a single tweet-count bracket set, where
// one order on "400-419" blocked "280-299", "420-439" and "500+" at once.
//
// So an event-scoped overlap alone no longer blocks another alternative of the same
// multi-outcome field, up to a cap. The cap is the part that still matters: every bracket
// costs money and exactly one pays out, so buying the whole field is a guaranteed loss.
// Team, match and topic overlap still block outright, because those genuinely do lose
// together -- and a two-sided event keeps its strict one-position rule, since buying both
// sides of an either-or is just paying two spreads to hold nothing.
const EVENT_RISK_KEY_PREFIX = "event:";
const MAX_PER_MULTI_OUTCOME_EVENT = Math.max(1, envNumber("PAPER_MAX_PER_MULTI_EVENT", 3));

function riskBlock(candidate, trades) {
  const candidateKeys = new Set(Array.isArray(candidate.riskGroupKeys) ? candidate.riskGroupKeys : []);
  if (!candidateKeys.size) return null;
  const candidateIsField = reportMarketType(candidate) === "multi";

  let firstSpread = null;
  let spreadCount = 0;
  for (const trade of trades.filter((item) => OPEN_STATUSES.has(item.status))) {
    const tradeKeys = Array.isArray(trade.riskGroupKeys) ? trade.riskGroupKeys : [];
    const overlap = tradeKeys.filter((key) => candidateKeys.has(key));
    if (!overlap.length) continue;
    const block = { tradeId: trade.id, question: trade.question, outcome: trade.outcome, overlap };
    // Sharing the event itself -- not merely a team, a topic or anything else -- is what
    // makes this the same field rather than a coincidence.
    //
    // Reported: Conservative kept skipping with candidates on the book. Two exact-score
    // lines of one match ("Go Ahead Eagles 0-0" held, "1-0" offered) were blocked as real
    // correlation, because the overlap included team:go ahead eagles alongside the two
    // event keys -- and the old test required every overlapping key to be event-scoped.
    // But two alternatives of the same fixture will always also share the fixture's own
    // team names; that overlap is entailed by being the same event; it is not a second,
    // independent risk on top of it. Testing for "an event key is present" rather than
    // "only event keys are present" is what actually distinguishes the two cases: a shared
    // team or topic with NO shared event key is a different match or question entirely, and
    // that is the real correlation this block still has to catch.
    const sameEvent = overlap.some((key) => key.startsWith(EVENT_RISK_KEY_PREFIX));
    if (!sameEvent || !candidateIsField || reportMarketType(trade) !== "multi") return block;
    spreadCount += 1;
    if (!firstSpread) firstSpread = block;
  }

  if (firstSpread && spreadCount >= MAX_PER_MULTI_OUTCOME_EVENT) {
    return { ...firstSpread, sameEventCount: spreadCount, atCap: MAX_PER_MULTI_OUTCOME_EVENT };
  }
  return null;
}

function riskBlockReason(block) {
  const overlap = block?.overlap?.slice(0, 3).join(", ") || "risk group";
  if (block?.atCap) {
    return `already holding ${block.sameEventCount} alternatives of ${overlap},`
      + ` the most one multi-outcome event may carry`;
  }
  return `open correlated paper trade ${block.tradeId} already covers ${overlap}`;
}

function candidateSelectionDecision({ candidate, portfolioState, selected, action, reason }) {
  if (!candidate) return "not selected: missing candidate";
  if (selected && String(candidate.tokenId || "") === String(selected.tokenId || "")) {
    return "selected for trade";
  }
  const activeTrades = Array.isArray(portfolioState?.trades) ? portfolioState.trades : [];
  const duplicate = activeTrades.find((trade) => OPEN_STATUSES.has(trade.status) && trade.tokenId === candidate.tokenId);
  if (duplicate) return `not selected: same token already open in trade ${duplicate.id}`;
  const block = riskBlock(candidate, activeTrades);
  if (block) return `not selected: ${riskBlockReason(block)}`;
  if (String(action || "").toUpperCase() === "SKIP" && reason) return `not selected: batch skipped - ${reason}`;
  if (selected) return "not selected: lower priority than selected candidate after portfolio ranking";
  return "not selected: no selectable candidate was recorded";
}

function rewardRiskRatio(item) {
  const reward = Number(item.netGainIfWinUsdc ?? item.grossGainIfWinUsdc);
  const risk = Number(item.totalCostUsdc || item.maxLossUsdc || item.stakeUsdc || 0);
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || reward <= 0 || risk <= 0) return null;
  return reward / risk;
}

function remainingDaysValue(item) {
  const endTime = Date.parse(item.endDate || "");
  if (Number.isFinite(endTime)) return Math.max(1 / 24, (endTime - Date.now()) / 86400000);
  return Math.max(1 / 24, daysValue(item));
}

function tradeCurrentValue(trade) {
  const stored = Number(trade.currentValueUsdc);
  if (Number.isFinite(stored) && stored >= 0) return stored;
  const shares = Number(trade.shares);
  const price = Number(trade.currentPrice ?? trade.entryPrice);
  if (Number.isFinite(shares) && Number.isFinite(price) && shares >= 0 && price >= 0) {
    return shares * price;
  }
  return null;
}

function tradeContinuationEconomics(trade, strategy = PAPER_STRATEGIES.conservative) {
  const currentValue = tradeCurrentValue(trade);
  const shares = Number(trade.shares);
  const probability = Number(strategy.probabilitySource === "polymarket"
    ? (trade.marketProbability ?? trade.sourceEvaluation?.marketProbability ?? trade.entryPrice)
    : (trade.aiProbability ?? trade.sourceEvaluation?.aiProbability));
  const remainingDays = remainingDaysValue(trade);
  const reward = Number.isFinite(shares) && Number.isFinite(currentValue) ? Math.max(0, shares - currentValue) : null;
  const expectedValue = Number.isFinite(probability) && Number.isFinite(shares) && Number.isFinite(currentValue)
    ? (probability * shares) - currentValue
    : Number(strategy.probabilitySource === "polymarket"
      ? (trade.marketExpectedValueUsdc ?? trade.sourceEvaluation?.marketExpectedValueUsdc)
      : trade.expectedValueUsdc);
  const expectedRoi = Number.isFinite(expectedValue) && Number.isFinite(currentValue) && currentValue > 0
    ? expectedValue / currentValue
    : null;
  const annualizedReturn = Number.isFinite(expectedRoi)
    ? expectedRoi * (365 / remainingDays)
    : Number(strategy.probabilitySource === "polymarket"
      ? (trade.marketAnnualizedReturn ?? trade.sourceEvaluation?.marketAnnualizedReturn)
      : trade.annualizedReturn);
  const rewardRisk = Number.isFinite(reward) && Number.isFinite(currentValue) && currentValue > 0 ? reward / currentValue : null;
  const score = strategy.selectionOrder === "highest_reward_risk_first" ? rewardRisk : annualizedReturn;
  return {
    currentValue,
    reward,
    expectedValue,
    annualizedReturn,
    rewardRisk,
    score,
  };
}

function candidateRotationScore(candidate, strategy = PAPER_STRATEGIES.conservative) {
  return strategy.selectionOrder === "highest_reward_risk_first"
    ? rewardRiskRatio(candidate)
    : portfolioEconomics(candidate, strategy).annualizedReturn;
}

function openTrades(trades) {
  return trades.filter((trade) => OPEN_STATUSES.has(trade.status));
}

function openExposureProfile(portfolioStates = []) {
  const tagCounts = {};
  const categoryCounts = {};
  const riskCounts = {};
  const rows = [];
  for (const portfolioState of portfolioStates) {
    for (const trade of openTrades(portfolioState?.trades || [])) {
      const tags = Array.isArray(trade.tags) && trade.tags.length ? trade.tags : tagQuestion(trade.question || "");
      const category = trade.riskCategory || (tags.includes("sports") ? "sports" : tags[0] || "general");
      for (const tag of tags) {
        tagCounts[tag] = Number(tagCounts[tag] || 0) + 1;
      }
      categoryCounts[category] = Number(categoryCounts[category] || 0) + 1;
      const keys = Array.isArray(trade.riskGroupKeys) && trade.riskGroupKeys.length
        ? trade.riskGroupKeys
        : riskProfile({
            question: trade.question,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            outcome: trade.outcome,
            tags,
          }).keys;
      for (const key of keys) {
        riskCounts[key] = Number(riskCounts[key] || 0) + 1;
      }
      rows.push({
        strategyId: portfolioState?.id || trade.strategyId || "paper",
        tradeId: trade.id || null,
        question: trade.question || "",
        outcome: trade.outcome || "",
        tags,
        category,
        riskGroupKeys: keys,
      });
    }
  }
  return { tagCounts, categoryCounts, riskCounts, openTrades: rows };
}

function marketDiversificationScore(market, exposure) {
  const question = String(market?.question || "");
  const tags = tagQuestion(question);
  const eventSlug = marketEventSlug(market);
  const risk = riskProfile({ question, slug: market?.slug, eventSlug, outcome: "", tags });
  const category = risk.category || tags[0] || "general";
  let score = 0;
  const reasons = [];

  if (!Number(exposure.categoryCounts[category] || 0)) {
    score += 5;
    reasons.push(`new category ${category}`);
  }
  const newTags = tags.filter((tag) => !Number(exposure.tagCounts[tag] || 0));
  if (newTags.length) {
    score += Math.min(4, newTags.length * 2);
    reasons.push(`new tags ${newTags.slice(0, 3).join(", ")}`);
  }
  const topicKeys = risk.keys.filter((key) => key.startsWith("topic:"));
  const newTopics = topicKeys.filter((key) => !Number(exposure.riskCounts[key] || 0));
  if (newTopics.length) {
    score += Math.min(4, newTopics.length * 2);
    reasons.push(`new topics ${newTopics.slice(0, 3).join(", ")}`);
  }
  const overlapKeys = risk.keys.filter((key) => Number(exposure.riskCounts[key] || 0));
  if (overlapKeys.length) {
    score -= Math.min(6, overlapKeys.length * 2);
    reasons.push(`overlaps ${overlapKeys.slice(0, 3).join(", ")}`);
  }

  return {
    score,
    tags,
    category,
    riskGroupKeys: risk.keys,
    reasons,
  };
}

function heldHours(trade) {
  const opened = Date.parse(trade.openedAt || trade.date || "");
  if (!Number.isFinite(opened)) return Infinity;
  return Math.max(0, (Date.now() - opened) / 3600000);
}

function daysValue(item) {
  const days = Number(item.daysToResolution);
  return Number.isFinite(days) ? days : Infinity;
}

function compareShorterHorizon(a, b) {
  const delta = daysValue(a) - daysValue(b);
  return Number.isFinite(delta) ? delta : 0;
}

function isNoOutcome(item) {
  return /^no$/i.test(String(item?.outcome || "").trim());
}

function similarPolymarketProbability(a, b, tolerance = 0.03) {
  const aPrice = Number(a?.marketProbability ?? a?.marketPrice ?? a?.entryPrice ?? a?.currentPrice);
  const bPrice = Number(b?.marketProbability ?? b?.marketPrice ?? b?.entryPrice ?? b?.currentPrice);
  return Number.isFinite(aPrice) && Number.isFinite(bPrice) && Math.abs(aPrice - bPrice) <= tolerance;
}

function preferNoWhenComparable(a, b, scoreDelta = 0) {
  if (!similarPolymarketProbability(a, b)) return 0;
  if (Math.abs(scoreDelta) > 0.05) return 0;
  if (isNoOutcome(a) === isNoOutcome(b)) return 0;
  return isNoOutcome(a) ? -1 : 1;
}

function strategyMaxResolutionDays(strategy) {
  const days = Number(strategy.maxResolutionDays);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_MAX_RESOLUTION_DAYS;
}

function normalizeExecutionTrigger(value) {
  return String(value || "").trim().toLowerCase() === "after_scrape" ? "after_scrape" : "cron";
}

function lastRunAtForStrategy(state, strategy) {
  const strategyId = String(strategy?.id || "");
  const ownRows = Array.isArray(state?.paperPortfolios?.[strategyId]?.runLog)
    ? state.paperPortfolios[strategyId].runLog
    : [];
  const legacyRows = strategyId === "conservative" && Array.isArray(state?.runLog) ? state.runLog : [];
  const rows = [...ownRows, ...legacyRows];
  let latest = null;
  for (const row of rows) {
    if (String(row?.strategyId || strategyId) !== strategyId) continue;
    const time = Date.parse(row?.runAt || row?.generatedAt || "");
    if (!Number.isFinite(time)) continue;
    if (latest == null || time > latest) latest = time;
  }
  return latest == null ? null : new Date(latest).toISOString();
}

function dueExecutionStrategies(state) {
  return executionStrategies()
    .filter((strategy) => strategyMatchesExecutionTrigger(strategy))
    .filter((strategy) => strategyCadenceIsDue(strategy, lastRunAtForStrategy(state, strategy)));
}

function strategyEligibleCandidates(eligible, strategy) {
  const maxResolutionDays = strategyMaxResolutionDays(strategy);
  const requiredMarketType = normalizePortfolioMarketType(strategy.marketType, strategy.requireMostProbableOutcome);
  let rows = [...eligible].filter((item) => {
    const tokenId = String(item?.tokenId || item?.clobTokenId || item?.assetId || "");
    if (strategy.excludedCandidateTokenIds?.has(tokenId)) return false;
    if (!strategyAllowsTags(item, strategy)) return false;
    const minProbability = Number(strategy.minProbability);
    const selectedProbability = portfolioProbabilityForStrategy(item, strategy);
    if (Number.isFinite(minProbability) && (!Number.isFinite(selectedProbability) || selectedProbability < minProbability)) return false;
    if (daysValue(item) > maxResolutionDays) return false;
    const minLiquidityUsdc = Number(strategy.minLiquidityUsdc);
    if (Number.isFinite(minLiquidityUsdc) && rowVolumeUsdc(item) < minLiquidityUsdc) return false;
    const minimumNetYield = Math.max(0, Number(strategy.minNetYield) || 0);
    const candidateNetYield = netYieldAfterFees(item, strategy);
    if (!Number.isFinite(candidateNetYield) || candidateNetYield < minimumNetYield) return false;
    // Classified from the row, never read off item.marketType. A stored label was written
    // by whichever rule was live when the row was scraped, and the statistics always
    // recompute -- preferring the stored one is how a portfolio filter and the statistics
    // came to disagree about the same market.
    const marketType = reportMarketType(item);
    if (requiredMarketType !== "all" && marketType !== requiredMarketType) return false;
    if (strategy.equalRiskProtection) {
      const entry = paperEntryEconomics(item, strategy);
      const plan = equalRiskStopPlan({
        totalCostUsdc: entry.totalCostUsdc,
        netGainIfWinUsdc: entry.netGainIfWinUsdc,
        shares: entry.shares,
        entryPrice: entry.entryPrice,
        feeRate: item.feeRate,
        feesEnabled: item.feesEnabled,
        riskMultiplier: strategy.equalRiskMultiplier ?? 1,
      });
      if (!plan.protectable) return false;
      const protection = equalRiskEntryProtection({
        plan,
        bestBid: item.bestBid,
        shares: entry.shares,
        feeRate: item.feeRate,
        feesEnabled: item.feesEnabled,
      });
      if (!protection.eligible) return false;
    }
    return true;
  });
  return rows;
}

// Traded volume, which is the figure Polymarket itself shows on a market ("$37.9K Vol.").
// Gamma's `liquidity` is order-book depth and is a different number entirely -- comparing
// the two is what made the dashboard look wrong against the site.
function marketVolumeSnapshotUsdc(market = {}) {
  for (const candidate of [market.volumeNum, market.volume, market.volume24hr]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) return Number(numeric.toFixed(2));
  }
  return null;
}

function marketVolumeUsdc(market = {}) {
  return marketVolumeSnapshotUsdc(market) ?? 0;
}

// The same figure off an already-stored row. `liquidity` is the last fallback so rows
// scraped before volume was captured keep working until they are next refreshed, rather
// than dropping to zero and being filtered out en masse.
function rowVolumeUsdc(item = {}) {
  for (const candidate of [item.volumeUsdc, item.volume24hr, item.firstVolume24hr, item.liquidity]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

// Gamma returns tags both as plain strings and as {label,slug} objects, and a row carries
// them under more than one field depending on which pass recorded it. Category counts as a
// tag here: it is the field a row scraped before tags were captured has to be judged on.
function rowTagSlugs(item = {}) {
  const slugs = new Set();
  const slugify = (value) => String(value ?? "")
    .trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  for (const list of [item.polymarketTags, item.tags, item.firstTags]) {
    for (const raw of (Array.isArray(list) ? list : [])) {
      const tag = slugify(raw && typeof raw === "object" ? (raw.slug || raw.label || raw.name || "") : raw);
      if (tag) slugs.add(tag);
    }
  }
  for (const key of [item.riskCategory, item.category, item.firstCategory]) {
    const tag = slugify(key);
    if (tag) slugs.add(tag);
  }
  return slugs;
}

// Which of the strategy's excluded tags this row carries, so a rejection can name the tag
// that caused it. An empty setting excludes nothing and never reads the row's tags.
function excludedTagsOnRow(item, strategy) {
  const excluded = strategy?.excludedMarketTags;
  if (!excluded?.size) return [];
  const slugs = rowTagSlugs(item);
  return [...excluded].filter((tag) => slugs.has(tag));
}

function includedTagsOnRow(item, strategy) {
  const included = strategy?.includeOnlyMarketTags;
  if (!included?.size) return [];
  const slugs = rowTagSlugs(item);
  return [...included].filter((tag) => slugs.has(tag));
}

// A populated whitelist is the portfolio's tag policy. The exclusion list is retained
// for when the whitelist is cleared, but must not influence selection meanwhile.
function strategyAllowsTags(item, strategy) {
  if (strategy?.includeOnlyMarketTags?.size) return includedTagsOnRow(item, strategy).length > 0;
  return excludedTagsOnRow(item, strategy).length === 0;
}

// Number(null) and Number("") are 0, so the usual Number(x) turns an absent value
// into a real, confident zero. Anywhere that zero is itself a meaningful verdict,
// use this instead.
function numericOrNaN(value) {
  return value == null || value === "" ? NaN : Number(value);
}

// Gamma's outcome price is a useful reference quote, but it can be stale by the
// time an order is placed. A Polymarket-threshold portfolio must be judged by
// the executable CLOB price that is also used as the order entry, otherwise a
// 59% order can incorrectly pass a 75% threshold from an older 81% quote.
function portfolioProbabilityForStrategy(item = {}, strategy = {}) {
  if (strategy.probabilitySource === "polymarket") {
    return numericOrNaN(item.marketPrice);
  }
  return numericOrNaN(item.aiProbability);
}

function paperEntryEconomics(item = {}, strategy = null) {
  const stake = Number(item.stakeUsdc ?? item.filledStakeUsdc);
  const limitPrice = Number(item.bestBid);
  if (strategy?.useLimitOrders && Number.isFinite(stake) && stake > 0
    && Number.isFinite(limitPrice) && limitPrice > 0 && limitPrice < 1) {
    const shares = stake / limitPrice;
    return {
      executionMode: "LIMIT_BUY",
      entryPrice: limitPrice,
      shares,
      entryFeeUsdc: 0,
      totalCostUsdc: stake,
      netGainIfWinUsdc: shares - stake,
    };
  }

  return {
    executionMode: item.executionMode || "MARKET_BUY",
    entryPrice: Number(item.marketPrice),
    shares: Number(item.executableShares ?? item.shares),
    entryFeeUsdc: Number(item.takerFeeUsdc || 0),
    totalCostUsdc: Number(item.totalCostUsdc ?? item.stakeUsdc),
    netGainIfWinUsdc: Number(item.netGainIfWinUsdc),
  };
}

function netYieldAfterFees(item = {}, strategy = null) {
  const entry = paperEntryEconomics(item, strategy);
  if (strategy?.useLimitOrders && entry.executionMode === "LIMIT_BUY") {
    return entry.totalCostUsdc > 0 ? entry.netGainIfWinUsdc / entry.totalCostUsdc : null;
  }
  const stored = Number(item.netYield);
  if (Number.isFinite(stored)) return stored;
  const gain = entry.netGainIfWinUsdc;
  const cost = entry.totalCostUsdc;
  if (!Number.isFinite(gain) || !Number.isFinite(cost) || cost <= 0) return null;
  return gain / cost;
}

function portfolioEconomics(item, strategy = PAPER_STRATEGIES.conservative) {
  const probabilitySource = strategy.probabilitySource === "polymarket" ? "polymarket" : "ai";
  // A scraped evaluation does not persist netYield, so reading item.netYield
  // directly left every candidate with nothing to annualize. netYieldAfterFees
  // derives it from the net gain and the real cost, both of which the record does
  // carry.
  const netYield = netYieldAfterFees(item, strategy);
  // Recalculate instead of trusting an older persisted p.a. value. This keeps
  // stored rows made before the one-day annualization floor from dominating a
  // current portfolio shortlist.
  const potentialAnnualized = annualizedPotentialReturn(netYield, daysValue(item));
  // Number(null) is 0, not NaN. That turned "no p.a. could be computed" into an
  // exact break-even, which the filter then rejected as "Potential p.a. 0.0% is
  // non-profitable after fees" -- so missing data read as a hard, and wrong,
  // verdict, and no paper candidate could ever pass.
  const annualizedValue = numericOrNaN(probabilitySource === "polymarket" ? potentialAnnualized : item.annualizedReturn);
  const expectedValue = numericOrNaN(probabilitySource === "polymarket" ? item.netGainIfWinUsdc : item.expectedValueUsdc);
  return {
    probabilitySource,
    annualizedReturn: Number.isFinite(annualizedValue) ? annualizedValue : null,
    expectedValueUsdc: Number.isFinite(expectedValue) ? expectedValue : null,
  };
}

function portfolioFilterResult(item, strategy) {
  const reasons = [];
  const tokenId = String(item?.tokenId || item?.clobTokenId || item?.assetId || "");
  const status = String(item.status || "").toUpperCase();
  const selectionStatus = String(item.selectionStatus || "").toUpperCase();
  const minProbability = Number(strategy.minProbability);
  const maxResolutionDays = strategyMaxResolutionDays(strategy);
  const minLiquidityUsdc = Number(strategy.minLiquidityUsdc);
  const minNetYield = Math.max(0, Number(strategy.minNetYield) || 0);
  const probabilitySource = strategy.probabilitySource === "polymarket" ? "polymarket" : "ai";
  const selectedProbability = portfolioProbabilityForStrategy(item, strategy);
  const days = daysValue(item);
  const liquidity = Number(item.liquidity || 0);
  // The portfolio threshold is a traded-volume floor, which is what Polymarket shows.
  const candidateVolume = rowVolumeUsdc(item);
  // Classified from the row, not read off a label an older rule stored on it.
  const marketType = reportMarketType(item);
  const requiredMarketType = normalizePortfolioMarketType(strategy.marketType, strategy.requireMostProbableOutcome);
  const economics = portfolioEconomics(item, strategy);
  const annualizedReturn = economics.annualizedReturn;
  const returnMetric = probabilitySource === "polymarket" ? "Potential p.a." : "EV p.a.";

  if (binaryOutcomeQuotesAreBothZero(item)) reasons.push("binary YES/NO quotes are both 0%; market appears resolved");
  if (strategy.excludedCandidateTokenIds?.has(tokenId)) reasons.push("manually excluded from this paper portfolio");
  const includedTags = includedTagsOnRow(item, strategy);
  if (strategy?.includeOnlyMarketTags?.size && !includedTags.length) {
    reasons.push(`outside included tags (${[...strategy.includeOnlyMarketTags].join(", ")})`);
  } else {
    const excludedTags = excludedTagsOnRow(item, strategy);
    if (excludedTags.length) {
      reasons.push(`excluded tag${excludedTags.length > 1 ? "s" : ""} ${excludedTags.join(", ")}`);
    }
  }
  if (probabilitySource === "ai" && status !== "ELIGIBLE") reasons.push(`base status ${status || "UNKNOWN"} is not ELIGIBLE`);
  if (probabilitySource === "polymarket" && ["ERROR", "RESOLVED", "CLOSED", "FINALIZED", "SETTLED"].includes(status)) {
    reasons.push(`base status ${status || "UNKNOWN"} is not executable`);
  }
  // Retain a failed CLOB lookup for the audit trail, but never let an old
  // Gamma quote make it eligible again. This safeguard applies to both
  // Polymarket- and AI-probability portfolios.
  if (selectionStatus === "REVALIDATION_FAILED" || item.executionQuoteVerified === false) {
    reasons.push("current CLOB quote is unavailable after revalidation");
  }
  if (probabilitySource === "ai" && REQUIRE_GEMINI && !hasGroundedPublicMemo(item)) reasons.push("grounded Gemini analysis is pending");
  if (Number.isFinite(minProbability) && (!Number.isFinite(selectedProbability) || selectedProbability < minProbability)) {
    const label = probabilitySource === "polymarket" ? "Polymarket probability" : "AI probability";
    reasons.push(`${label} ${Number.isFinite(selectedProbability) ? (selectedProbability * 100).toFixed(1) : "-"}% below ${(minProbability * 100).toFixed(1)}%`);
  }
  if (!Number.isFinite(annualizedReturn)) {
    const label = probabilitySource === "polymarket" ? "Polymarket probability" : "AI probability";
    reasons.push(`missing ${label} ${returnMetric}`);
  } else if (annualizedReturn <= 0) {
    const label = probabilitySource === "polymarket" ? "Polymarket probability" : "AI probability";
    reasons.push(`${label} ${returnMetric} ${(annualizedReturn * 100).toFixed(1)}% is non-profitable after fees`);
  } else if (probabilitySource !== "polymarket" && annualizedReturn < MIN_ANNUAL_RETURN) {
    const label = probabilitySource === "polymarket" ? "Polymarket probability" : "AI probability";
    reasons.push(`${label} ${returnMetric} ${(annualizedReturn * 100).toFixed(1)}% below ${(MIN_ANNUAL_RETURN * 100).toFixed(1)}%`);
  }
  if (Number.isFinite(days) && days <= 0 && String(item.endDateSource || "") !== "sports-event-start") {
    // Already past its own resolution window, so it cannot be opened. scoreEconomics
    // rejects it with the same finding; keeping it listed only produced shortlists of
    // finished fixtures and runs that could do nothing but skip.
    //
    // A sports row dated by kickoff is excluded: past kickoff means in play, not over.
    reasons.push("event end date is in the past");
  } else if (days > maxResolutionDays) {
    reasons.push(`resolution ${Number.isFinite(days) ? days.toFixed(2) : "-"} days exceeds max ${maxResolutionDays}`);
  }
  if (Number.isFinite(minLiquidityUsdc) && candidateVolume < minLiquidityUsdc) {
    reasons.push(`volume ${candidateVolume.toFixed(2)} below ${minLiquidityUsdc.toFixed(2)} USDC`);
  }
  const candidateNetYield = netYieldAfterFees(item, strategy);
  if (!Number.isFinite(candidateNetYield) || candidateNetYield < minNetYield) {
    reasons.push(`net profit ${Number.isFinite(candidateNetYield) ? `${(candidateNetYield * 100).toFixed(1)}%` : "-"} below ${(minNetYield * 100).toFixed(1)}% after fees`);
  }
  if (requiredMarketType !== "all" && marketType !== requiredMarketType) {
    reasons.push(`market type ${marketType || "-"} does not match portfolio market type ${requiredMarketType}`);
  }
  if (strategy.equalRiskProtection) {
    const entry = paperEntryEconomics(item, strategy);
    const plan = equalRiskStopPlan({
      totalCostUsdc: entry.totalCostUsdc,
      netGainIfWinUsdc: entry.netGainIfWinUsdc,
      shares: entry.shares,
      entryPrice: entry.entryPrice,
      feeRate: item.feeRate,
      feesEnabled: item.feesEnabled,
      riskMultiplier: strategy.equalRiskMultiplier ?? 1,
    });
    if (!plan.protectable) reasons.push(`equal-risk protection unavailable: ${plan.reason}`);
    else {
      const protection = equalRiskEntryProtection({
        plan,
        bestBid: item.bestBid,
        shares: entry.shares,
        feeRate: item.feeRate,
        feesEnabled: item.feesEnabled,
      });
      if (!protection.eligible) reasons.push(`equal-risk protection unavailable: ${protection.reason}`);
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function incrementCount(counts, key) {
  counts[key] = Number(counts[key] || 0) + 1;
}

function sortEligibleForStrategy(eligible, strategy = PAPER_STRATEGIES.conservative) {
  const strategyRows = strategyEligibleCandidates(eligible, strategy);
  const rows = strategyRows;
  if (strategy.selectionOrder === "highest_reward_risk_first") {
    return rows.sort((a, b) => {
      const aRatio = rewardRiskRatio(a) ?? -Infinity;
      const bRatio = rewardRiskRatio(b) ?? -Infinity;
      if (bRatio !== aRatio) {
        const noPreference = preferNoWhenComparable(a, b, bRatio - aRatio);
        if (noPreference) return noPreference;
        return bRatio - aRatio;
      }
      const horizon = compareShorterHorizon(a, b);
      if (horizon !== 0) return horizon;
      const aEconomics = portfolioEconomics(a, strategy);
      const bEconomics = portfolioEconomics(b, strategy);
      if (bEconomics.annualizedReturn !== aEconomics.annualizedReturn) return bEconomics.annualizedReturn - aEconomics.annualizedReturn;
      return bEconomics.expectedValueUsdc - aEconomics.expectedValueUsdc;
    });
  }
  return rows.sort((a, b) => {
    const aEconomics = portfolioEconomics(a, strategy);
    const bEconomics = portfolioEconomics(b, strategy);
    if (bEconomics.annualizedReturn !== aEconomics.annualizedReturn) {
      const noPreference = preferNoWhenComparable(a, b, bEconomics.annualizedReturn - aEconomics.annualizedReturn);
      if (noPreference) return noPreference;
      return bEconomics.annualizedReturn - aEconomics.annualizedReturn;
    }
    const horizon = compareShorterHorizon(a, b);
    if (horizon !== 0) return horizon;
    return bEconomics.expectedValueUsdc - aEconomics.expectedValueUsdc;
  });
}

function scaledPaperEconomics(best, stake) {
  const baseStake = Number(best.stakeUsdc || best.filledStakeUsdc || 0);
  const targetStake = Number(stake);
  const scale = baseStake > 0 && Number.isFinite(targetStake) ? targetStake / baseStake : 1;
  const shares = Number(best.executableShares);
  const takerFee = Number(best.takerFeeUsdc || 0);
  const totalCost = Number(best.totalCostUsdc || baseStake + takerFee);
  const grossGain = Number(best.grossGainIfWinUsdc);
  const netGain = Number(best.netGainIfWinUsdc);
  const maxLoss = Number(best.maxLossUsdc || totalCost);
  const expectedValue = Number(best.expectedValueUsdc);
  const fills = Array.isArray(best.marketFills) ? best.marketFills.map((fill) => ({
    ...fill,
    size: Number((Number(fill.size || 0) * scale).toFixed(4)),
    costUsdc: Number((Number(fill.costUsdc || 0) * scale).toFixed(4)),
  })) : [];

  return {
    scale,
    shares: Number.isFinite(shares) ? Number((shares * scale).toFixed(4)) : shares,
    takerFeeUsdc: Number.isFinite(takerFee) ? Number((takerFee * scale).toFixed(5)) : takerFee,
    totalCostUsdc: Number.isFinite(totalCost) ? Number((totalCost * scale).toFixed(5)) : totalCost,
    grossGainIfWinUsdc: Number.isFinite(grossGain) ? Number((grossGain * scale).toFixed(4)) : grossGain,
    netGainIfWinUsdc: Number.isFinite(netGain) ? Number((netGain * scale).toFixed(4)) : netGain,
    maxLossUsdc: Number.isFinite(maxLoss) ? Number((maxLoss * scale).toFixed(5)) : maxLoss,
    expectedValueUsdc: Number.isFinite(expectedValue) ? Number((expectedValue * scale).toFixed(4)) : expectedValue,
    marketFills: fills,
  };
}

function paperTradeFromCandidate(best, strategy, today, stake) {
  const economics = scaledPaperEconomics(best, stake);
  const equalRiskPlan = strategy.equalRiskProtection
    ? equalRiskStopPlan({
      ...economics,
      entryPrice: best.marketPrice,
      feeRate: best.feeRate,
      feesEnabled: best.feesEnabled,
      riskMultiplier: strategy.equalRiskMultiplier ?? 1,
    })
    : null;
  const selectionEconomics = portfolioEconomics(best, strategy);
  const selectedExpectedValue = Number.isFinite(selectionEconomics.expectedValueUsdc)
    ? Number((selectionEconomics.expectedValueUsdc * economics.scale).toFixed(4))
    : null;
  return {
    id: `paper-${strategy.id}-${today}-${best.tokenId}`,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    selectionMetric: strategy.selectionMetric,
    openedAt: nowIso(),
    date: today,
    status: "OPEN",
    sourceEvaluationId: best.id,
    sourceEvaluation: {
      id: best.id,
      evaluatedAt: best.evaluatedAt,
      status: best.status,
      thesisType: best.thesisType,
      aiProbability: best.aiProbability,
      rawProbability: best.rawProbability,
      marketPrice: best.marketPrice,
      marketProbability: best.marketProbability,
      edge: best.edge,
      expectedValueUsdc: selectedExpectedValue,
      annualizedReturn: selectionEconomics.annualizedReturn,
      aiExpectedValueUsdc: Number.isFinite(Number(best.aiExpectedValueUsdc ?? best.expectedValueUsdc)) ? Number((Number(best.aiExpectedValueUsdc ?? best.expectedValueUsdc) * economics.scale).toFixed(4)) : null,
      aiAnnualizedReturn: best.aiAnnualizedReturn ?? best.annualizedReturn,
      marketExpectedValueUsdc: Number.isFinite(Number(best.marketExpectedValueUsdc)) ? Number((Number(best.marketExpectedValueUsdc) * economics.scale).toFixed(4)) : null,
      marketAnnualizedReturn: best.marketAnnualizedReturn ?? null,
      probabilitySource: strategy.probabilitySource,
      probabilityThesis: best.probabilityThesis,
      analysisSummary: best.analysisSummary,
      analysisModel: best.analysisModel,
      aiAnalysis: best.aiAnalysis,
      evidence: best.evidence,
    },
    question: best.question,
    slug: best.slug,
    eventSlug: best.eventSlug,
    outcome: best.outcome,
    tokenId: best.tokenId,
    tags: best.tags,
    riskCategory: best.riskCategory,
    riskPrimaryEntity: best.riskPrimaryEntity,
    riskGroupKeys: best.riskGroupKeys,
    riskGroupLabels: best.riskGroupLabels,
    executionMode: best.executionMode,
    entryPrice: best.marketPrice,
    bestAsk: best.bestAsk,
    bestBid: best.bestBid,
    spread: best.spread,
    slippage: best.slippage,
    liquidity: best.liquidity,
    volume24hr: best.volume24hr,
    daysToResolution: best.daysToResolution,
    aiProbability: best.aiProbability,
    rawProbability: best.rawProbability,
    marketProbability: best.marketProbability,
    thesisType: best.thesisType,
    probabilitySource: strategy.probabilitySource,
    annualizedReturn: selectionEconomics.annualizedReturn,
    expectedValueUsdc: selectedExpectedValue,
    aiExpectedValueUsdc: Number.isFinite(Number(best.aiExpectedValueUsdc ?? best.expectedValueUsdc)) ? Number((Number(best.aiExpectedValueUsdc ?? best.expectedValueUsdc) * economics.scale).toFixed(4)) : null,
    aiAnnualizedReturn: best.aiAnnualizedReturn ?? best.annualizedReturn,
    marketExpectedValueUsdc: Number.isFinite(Number(best.marketExpectedValueUsdc)) ? Number((Number(best.marketExpectedValueUsdc) * economics.scale).toFixed(4)) : null,
    marketAnnualizedReturn: best.marketAnnualizedReturn ?? null,
    stakeUsdc: Number(stake.toFixed(2)),
    shares: economics.shares,
    feesEnabled: best.feesEnabled,
    feeType: best.feeType,
    feeRate: best.feeRate,
    takerFeeUsdc: economics.takerFeeUsdc,
    totalCostUsdc: economics.totalCostUsdc,
    grossGainIfWinUsdc: economics.grossGainIfWinUsdc,
    netGainIfWinUsdc: economics.netGainIfWinUsdc,
    maxLossUsdc: economics.maxLossUsdc,
    currentPrice: best.marketPrice,
    currentValueUsdc: strategy.equalRiskProtection ? economics.totalCostUsdc : Number(stake.toFixed(2)),
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    equalRiskProtection: Boolean(strategy.equalRiskProtection),
    stopLossRiskMultiplier: equalRiskPlan?.stopLossRiskMultiplier ?? (strategy.equalRiskProtection ? normalizeStopLossRiskMultiplier(strategy.equalRiskMultiplier, 1) : null),
    riskTargetUsdc: equalRiskPlan?.riskTargetUsdc ?? null,
    stopLossPrice: equalRiskPlan?.stopPrice ?? null,
    stopLossStatus: equalRiskPlan?.requiresStop ? "ARMED" : (strategy.equalRiskProtection ? "NOT_REQUIRED" : null),
    stopLossMinimumExitUsdc: equalRiskPlan?.minimumExitValueUsdc ?? null,
    marketFills: economics.marketFills,
    aiAnalysis: best.aiAnalysis,
    probabilityThesis: best.probabilityThesis,
    analysisModel: best.analysisModel,
    analysisSummary: best.analysisSummary,
  };
}

// Reported: "use limit orders" saved for a paper portfolio, but every entry still
// filled at the market ask regardless -- the setting was read nowhere. A resting
// limit buy at the current best bid is cheaper than crossing the spread, but it is
// not guaranteed: it only becomes a real position if the market comes down to meet
// it before the event ends, mirroring what a real resting order on Polymarket would
// do. The shortlist uses the same maker entry economics; this record adds only the
// lifecycle state of an order that has not filled yet.
function openPaperTradeForStrategy(best, strategy, today, stake) {
  const trade = paperTradeFromCandidate(best, strategy, today, stake);
  if (!strategy.useLimitOrders) return trade;
  const limitPrice = Number(best.bestBid);
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) return trade;
  const shares = Number((stake / limitPrice).toFixed(4));
  // A limit order that rests at the bid is a maker fill. Polymarket charges the
  // taker, not the maker; rebates are conditional and are intentionally not credited.
  const takerFeeUsdc = 0;
  const totalCostUsdc = Number(stake.toFixed(5));
  const netGainIfWinUsdc = Number((shares - totalCostUsdc).toFixed(4));
  const equalRiskPlan = strategy.equalRiskProtection
    ? equalRiskStopPlan({
      totalCostUsdc,
      netGainIfWinUsdc,
      shares,
      entryPrice: limitPrice,
      feeRate: trade.feeRate,
      feesEnabled: trade.feesEnabled,
      riskMultiplier: strategy.equalRiskMultiplier ?? 1,
    })
    : null;
  return {
    ...trade,
    status: "LIMIT_ORDER_WAITING",
    executionMode: "LIMIT_BUY",
    entryPrice: limitPrice,
    bestAsk: best.bestAsk,
    bestBid: best.bestBid,
    slippage: 0,
    shares,
    takerFeeUsdc,
    totalCostUsdc,
    grossGainIfWinUsdc: Number((shares - stake).toFixed(4)),
    netGainIfWinUsdc,
    maxLossUsdc: totalCostUsdc,
    currentPrice: limitPrice,
    currentValueUsdc: Number(stake.toFixed(2)),
    stopLossRiskMultiplier: equalRiskPlan?.stopLossRiskMultiplier ?? trade.stopLossRiskMultiplier ?? null,
    riskTargetUsdc: equalRiskPlan?.riskTargetUsdc ?? null,
    stopLossPrice: equalRiskPlan?.stopPrice ?? null,
    stopLossStatus: equalRiskPlan?.requiresStop ? "ARMED" : (strategy.equalRiskProtection ? "NOT_REQUIRED" : null),
    stopLossMinimumExitUsdc: equalRiskPlan?.minimumExitValueUsdc ?? null,
    marketFills: [{ price: limitPrice, size: shares, costUsdc: Number(stake.toFixed(2)) }],
    statusNote: `Resting limit buy placed at ${limitPrice.toFixed(4)} (the best bid at selection); waiting for the market to fill it.`,
  };
}

function tradeBatchCandidateSummary(item, strategy = null) {
  if (!item) return null;
  const executionQuoteUnavailable = item.executionQuoteVerified === false
    || String(item.selectionStatus || "").toUpperCase() === "REVALIDATION_FAILED";
  const calculatedNetYield = netYieldAfterFees(item, strategy);
  const calculatedPotentialPa = executionQuoteUnavailable
    ? null
    : annualizedPotentialReturn(calculatedNetYield, item.daysToResolution);
  return {
    id: item.id || null,
    question: item.question || "",
    outcome: item.outcome || "",
    tokenId: item.tokenId || null,
    evaluatedAt: item.evaluatedAt || null,
    status: item.status || null,
    selectionStatus: item.selectionStatus || null,
    executionQuoteVerified: item.executionQuoteVerified === true
      ? true
      : (executionQuoteUnavailable ? false : null),
    executionQuoteStatus: item.executionQuoteStatus || (executionQuoteUnavailable ? "UNAVAILABLE" : null),
    aiProbability: Number.isFinite(Number(item.aiProbability)) ? Number(Number(item.aiProbability).toFixed(4)) : null,
    marketPrice: Number.isFinite(Number(item.marketPrice)) ? Number(Number(item.marketPrice).toFixed(4)) : null,
    marketProbability: Number.isFinite(Number(item.marketProbability)) ? Number(Number(item.marketProbability).toFixed(4)) : null,
    annualizedReturn: Number.isFinite(Number(item.annualizedReturn)) ? Number(Number(item.annualizedReturn).toFixed(4)) : null,
    expectedValueUsdc: Number.isFinite(Number(item.expectedValueUsdc)) ? Number(Number(item.expectedValueUsdc).toFixed(4)) : null,
    aiAnnualizedReturn: Number.isFinite(Number(item.aiAnnualizedReturn)) ? Number(Number(item.aiAnnualizedReturn).toFixed(4)) : null,
    aiExpectedValueUsdc: Number.isFinite(Number(item.aiExpectedValueUsdc)) ? Number(Number(item.aiExpectedValueUsdc).toFixed(4)) : null,
    marketAnnualizedReturn: Number.isFinite(Number(item.marketAnnualizedReturn)) ? Number(Number(item.marketAnnualizedReturn).toFixed(4)) : null,
    marketExpectedValueUsdc: Number.isFinite(Number(item.marketExpectedValueUsdc)) ? Number(Number(item.marketExpectedValueUsdc).toFixed(4)) : null,
    netGainIfWinUsdc: Number.isFinite(Number(item.netGainIfWinUsdc)) ? Number(Number(item.netGainIfWinUsdc).toFixed(4)) : null,
    netYield: !executionQuoteUnavailable && Number.isFinite(calculatedNetYield)
      ? Number(calculatedNetYield.toFixed(4))
      : null,
    potentialAnnualizedReturn: Number.isFinite(calculatedPotentialPa)
      ? Number(calculatedPotentialPa.toFixed(4))
      : null,
    riskReward: Number.isFinite(Number(rewardRiskRatio(item))) ? Number(Number(rewardRiskRatio(item)).toFixed(4)) : null,
    daysToResolution: Number.isFinite(Number(item.daysToResolution)) ? Number(Number(item.daysToResolution).toFixed(2)) : null,
    liquidity: Number.isFinite(Number(item.liquidity)) ? Number(Number(item.liquidity).toFixed(2)) : null,
    riskGroupLabels: Array.isArray(item.riskGroupLabels) ? item.riskGroupLabels.slice(0, 5) : [],
    rejectReasons: Array.isArray(item.rejectReasons) ? item.rejectReasons.slice(0, 6) : [],
    riskBlockedByTradeId: item.riskBlockedByTradeId || null,
    riskBlockedReason: item.riskBlockedReason || null,
    url: `https://polymarket.com/event/${item.eventSlug || item.slug || ""}`,
  };
}

function portfolioFilterDiagnostics(evaluations, strategy) {
  const rows = Array.isArray(evaluations) ? evaluations : [];
  const reasonCounts = {};
  const excludedSample = [];
  let baseEligible = 0;
  let portfolioEligible = 0;

  for (const item of rows) {
    if (String(item.status || "").toUpperCase() === "ELIGIBLE") baseEligible += 1;
    const result = portfolioFilterResult(item, strategy);
    if (result.eligible) {
      portfolioEligible += 1;
      continue;
    }
    for (const reason of result.reasons) incrementCount(reasonCounts, reason);
    if (excludedSample.length < 20) {
      excludedSample.push({
        ...tradeBatchCandidateSummary(item, strategy),
        portfolioRejectReasons: result.reasons,
      });
    }
  }

  return {
    totalEvaluated: rows.length,
    baseEligible,
    portfolioEligible,
    excludedCount: Math.max(0, rows.length - portfolioEligible),
    reasonCounts: compactReasonCounts(reasonCounts),
    excludedSample: compactCandidateLogRows(excludedSample, 8),
  };
}

function latestUniqueExecutionEvaluations(evaluations = []) {
  // The timestamp is read once per row instead of twice per comparison. evaluationUpdateTime
  // is four Date.parse calls, and a comparison sort over the catalogue makes on the order of
  // n log n of them -- tens of millions of date parses to order rows that each have one
  // fixed answer. Deciding the keys first and sorting on numbers is the same ordering by
  // the same comparator, minus the repetition.
  const keyed = (Array.isArray(evaluations) ? evaluations : [])
    .map((item) => ({ item, at: evaluationUpdateTime(item) }));
  keyed.sort((a, b) => b.at - a.at);
  const byKey = new Map();
  for (const { item } of keyed) {
    const key = evaluationKey(item);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  return [...byKey.values()];
}

// Rows a resolved market left behind cannot be opened, and holding one in the candidate
// pool actively costs a candidate.
//
// portfolioFilterResult rejects every one of them twice over -- a polymarket-probability
// portfolio on "base status RESOLVED is not executable", an AI-probability one on "base
// status RESOLVED is not ELIGIBLE", and both again on "event end date is in the past" --
// so no resolved row has ever been eligible for any portfolio. What they did do is
// outnumber the live catalogue several times over, and share a dedupe key with it: a
// market that is scanned again while its resolved twin is still in the archive collapses
// to whichever row carries the later timestamp, and if that is the resolved one, a
// perfectly tradable candidate silently disappears from the shortlist.
//
// Dropping them therefore removes work that could only ever be discarded, and removes it
// before it can shadow a candidate that could not.
function executionCandidateObservations(state) {
  const observations = Array.isArray(state.marketObservations) ? state.marketObservations : [];
  return observations.filter((item) => !observationIsResolved(item));
}

function executionRowsForStrategy(state, strategy, baseRows = []) {
  const rows = Array.isArray(baseRows) ? baseRows : [];
  if (strategy.probabilitySource !== "polymarket") return latestUniqueExecutionEvaluations(rows);
  return latestUniqueExecutionEvaluations([...cachedExecutionCandidatePool(state).scanned, ...rows]);
}

// The shortlist is built once per portfolio, and every portfolio starts from the same two
// collections. Expiring the stored evaluations, filtering the catalogue and deduplicating
// the union are all pure functions of those collections, so with seven portfolios the same
// answer was being computed seven times over tens of thousands of rows.
//
// Keyed on the arrays' identity, so any pass that replaces either one -- a scan, a
// resolution sync, an expiry -- gets a fresh answer rather than a stale cached one. Only
// probabilitySource selects between the two pools, so that is the rest of the key.
const executionCandidatePoolCache = new WeakMap();

function cachedExecutionCandidatePool(state, strategy = null) {
  const evaluations = Array.isArray(state.evaluations) ? state.evaluations : [];
  const observations = Array.isArray(state.marketObservations) ? state.marketObservations : [];
  let entry = executionCandidatePoolCache.get(state);
  if (!entry || entry.evaluations !== evaluations || entry.observations !== observations) {
    entry = {
      evaluations,
      observations,
      scanned: executionCandidateObservations(state),
      baseRows: expirePastEvaluations(evaluations).map(ensureEvaluationErrorMetadata),
      pools: new Map(),
    };
    executionCandidatePoolCache.set(state, entry);
  }
  if (!strategy) return entry;
  const pool = strategy.probabilitySource === "polymarket" ? "polymarket" : "ai";
  if (!entry.pools.has(pool)) {
    entry.pools.set(pool, executionRowsForStrategy(state, strategy, entry.baseRows));
  }
  return { ...entry, unique: entry.pools.get(pool) };
}

function storedExecutionShortlist(state, strategy) {
  const { unique, scanned } = cachedExecutionCandidatePool(state, strategy);
  const rejected = [];
  const passed = [];
  const reasonCounts = {};

  for (const item of unique) {
    const result = portfolioFilterResult(item, strategy);
    if (result.eligible) {
      passed.push(item);
      continue;
    }
    for (const reason of result.reasons) incrementCount(reasonCounts, reason);
    if (rejected.length < 20) {
      rejected.push({
        ...tradeBatchCandidateSummary(item, strategy),
        portfolioRejectReasons: result.reasons,
      });
    }
  }

  const rows = sortEligibleForStrategy(passed, strategy);
  return {
    rows,
    diagnostics: {
      source: "stored_execution_candidates",
      storedEvaluations: Array.isArray(state.evaluations) ? state.evaluations.length : 0,
      storedMarketObservations: Array.isArray(state.marketObservations) ? state.marketObservations.length : 0,
      // Stated beside the stored total so the drop between them reads as the resolved
      // archive being left out, rather than as candidates having gone missing.
      scannedMarketObservations: scanned.length,
      uniqueEvaluations: unique.length,
      prefilterPassed: rows.length,
      prefilterRejected: Math.max(0, unique.length - rows.length),
      scanLimit: MAX_EVALUATIONS_PER_RUN,
      reasonCounts,
      portfolioPrefilterPassed: rows.length,
      portfolioPrefilterRejected: Math.max(0, unique.length - rows.length),
      rejectedSample: rejected,
      executionShortlist: rows.slice(0, 30).map((item) => tradeBatchCandidateSummary(item, strategy)).filter(Boolean),
    },
  };
}

function marketFromStoredEvaluation(item) {
  const outcome = String(item.outcome || "Outcome 1");
  const tokenId = String(item.tokenId || item.clobTokenId || "");
  return {
    id: item.marketId || item.conditionId || item.slug || item.eventSlug || tokenId,
    question: item.question || "",
    slug: item.slug || item.eventSlug || "",
    eventSlug: item.eventSlug || item.slug || "",
    events: item.eventSlug ? [{ slug: item.eventSlug }] : [],
    endDate: item.endDate || null,
    createdAt: item.createdAt || item.firstEvaluatedAt || item.evaluatedAt || null,
    updatedAt: item.updatedAt || item.lastSeenAt || item.evaluatedAt || null,
    outcomes: JSON.stringify([outcome]),
    clobTokenIds: JSON.stringify([tokenId]),
    liquidity: Number(item.liquidity || 0),
    volume24hr: Number(item.volume24hr || 0),
    negRisk: item.negRisk,
    feeSchedule: item.feeSchedule,
    feesEnabled: item.feesEnabled,
    feeType: item.feeType,
    feeRate: item.feeRate,
  };
}

function revalidationFailureEvaluation(item, message, status = "REJECTED") {
  const reason = `execution shortlist revalidation failed: ${message}`;
  return normalizeEvaluationRisk({
    ...item,
    id: evaluationKey(item) || item.id,
    evaluatedAt: nowIso(),
    lastSeenAt: nowIso(),
    status,
    thesisType: status === "ERROR" ? "ERROR" : "REJECTED",
    selectionStatus: "REVALIDATION_FAILED",
    executionQuoteVerified: false,
    executionQuoteStatus: "UNAVAILABLE",
    rejectReasons: [reason, ...(Array.isArray(item.rejectReasons) ? item.rejectReasons : [])],
    analysisSummary: `${reason}. Candidate was removed from the current execution shortlist until a later evaluation makes it executable again.`,
  });
}

async function revalidateStoredExecutionCandidate(item, learningProfile) {
  const tokenId = String(item.tokenId || item.clobTokenId || "");
  if (!tokenId) {
    return revalidationFailureEvaluation(item, "missing token id");
  }
  if (REQUIRE_GEMINI && !hasGroundedPublicMemo(item)) {
    return markAiAnalysisDeferred(item, "Execution revalidation uses the stored grounded AI memo and never consumes a new Gemini request.");
  }

  try {
    const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
    const evaluation = evaluateCandidate({
      market: marketFromStoredEvaluation(item),
      outcomeIndex: 0,
      tokenId,
      book,
      learningProfile,
    });
    if (!evaluation) {
      return revalidationFailureEvaluation(item, "no executable ask/orderbook depth at current market");
    }
    const refreshed = normalizeEvaluationRisk({
      ...evaluation,
      revalidationSource: "stored_execution_candidates",
      executionQuoteVerified: true,
      executionQuoteStatus: "VERIFIED",
      previousEvaluatedAt: item.evaluatedAt || item.lastSeenAt || null,
      firstEvaluatedAt: item.firstEvaluatedAt || item.evaluatedAt || null,
    });
    return normalizeEvaluationRisk(refreshEvaluationAfterProbability(
      refreshed,
      Number(item.aiProbability),
      item.analysisModel || item.aiAnalysis?.model || GEMINI_MODEL,
      item.aiAnalysis || {},
    ));
  } catch (error) {
    const message = cleanEvaluationErrorMessage(error?.message || String(error || "unknown error"));
    return ensureEvaluationErrorMetadata(revalidationFailureEvaluation(item, message, "ERROR"));
  }
}

async function revalidateStoredExecutionShortlist(shortlist, learningProfile, state = null) {
  // This is the step between picking a candidate and placing the order, so its latency is
  // the delay the user actually feels. Each candidate is an independent quote lookup and
  // the results are ranked afterwards, so they are fetched together; input order is
  // preserved, which keeps the ranking's tie-breaks identical to the sequential version.
  const raw = await mapWithConcurrency(
    shortlist,
    (item) => revalidateStoredExecutionCandidate(item, learningProfile),
  );
  // Execution verifies price, liquidity and diversification only. AI research
  // belongs to the background evaluation budget, never to order execution.
  return raw.map(normalizeEvaluationRisk);
}

function buildTradeBatchLog({ portfolioState, strategy, evaluations = [], eligible, rankedEligible, action, reason, available, stake, selected = null, skippedForRisk = 0, insufficientCapital = false, rotationReview = null, diversificationDiagnostics = null, prevalidationFilter = null }) {
  const evaluated = Array.isArray(eligible) ? eligible : [];
  const ranked = Array.isArray(rankedEligible) ? rankedEligible : evaluated;
  const blocked = ranked.filter((item) => item.selectionStatus === "RISK_BLOCKED" || item.riskBlockedReason);
  const eligibleCandidates = ranked
    .slice(0, TRADE_BATCH_CANDIDATE_LOG_LIMIT)
    .map((item) => ({
      ...tradeBatchCandidateSummary(item, strategy),
      selectionDecision: candidateSelectionDecision({ candidate: item, portfolioState, selected, action, reason }),
    }))
    .filter(Boolean);
  return {
    id: `trade-batch-${strategy.id}-${nowIso()}`,
    runAt: nowIso(),
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    selectionMetric: strategy.selectionMetric,
    action,
    reason,
    explanation: selected
      ? `Opened ${selected.outcome || "selected outcome"} because it was the first non-duplicate, non-correlated candidate after ${strategy.label} rules.`
      : `No ${strategy.label} trade was opened: ${reason}.`,
    settings: {
      minProbability: strategy.minProbability,
      stakeUsdc: Number(stake.toFixed(2)),
      maxFraction: strategy.maxFraction ?? null,
      maxResolutionDays: strategyMaxResolutionDays(strategy),
      minLiquidityUsdc: strategy.minLiquidityUsdc ?? null,
      minNetYield: Math.max(0, Number(strategy.minNetYield) || 0),
      selectionOrder: strategy.selectionOrder,
      marketType: normalizePortfolioMarketType(strategy.marketType, strategy.requireMostProbableOutcome),
      requireMostProbableOutcome: Boolean(strategy.requireMostProbableOutcome),
      probabilitySource: strategy.probabilitySource,
      executionTrigger: normalizeExecutionTrigger(strategy.executionTrigger),
      manualRunOnce: MANUAL_RUN_ONCE,
      requestedStrategyId: PAPER_STRATEGY_ID || null,
      maxStakeUsdc: Number(stake.toFixed(2)),
    },
    capital: {
      availableUsdc: Number(available.toFixed(4)),
      requiredStakeUsdc: Number(stake.toFixed(4)),
      insufficientCapital: Boolean(insufficientCapital),
    },
    counts: {
      rankedEligible: ranked.length,
      skippedForRisk,
      riskBlocked: blocked.length,
      openTrades: openTrades(portfolioState.trades || []).length,
    },
    portfolioFilter: portfolioFilterDiagnostics(evaluations, strategy),
    selected: tradeBatchCandidateSummary(selected, strategy),
    eligibleCandidates,
    topCandidates: ranked.slice(0, 8).map((item) => tradeBatchCandidateSummary(item, strategy)).filter(Boolean),
    revalidatedCandidates: compactCandidateLogRows(prevalidationFilter?.revalidatedCandidates, 8),
    topRejected: compactCandidateLogRows(prevalidationFilter?.revalidatedRejectedSample, 8),
    riskBlocked: blocked.slice(0, 8).map((item) => tradeBatchCandidateSummary(item, strategy)).filter(Boolean),
    rotationReview: rotationReview || null,
    // Recorded so the log says which rule decided, rather than leaving a reader to work
    // out from a ROTATED_OPENED row whether the portfolio had the cash to just buy.
    freeCapitalPriority: true,
    freeCapitalCoversStake: Number(available) >= Number(stake),
    diversificationDiagnostics: diversificationDiagnostics || null,
    prevalidationFilter: compactPrevalidationFilter(prevalidationFilter),
  };
}

function findFirstOpenCandidate(portfolioState, eligible, excludedTradeId = null) {
  let skippedForRisk = 0;
  const activeTrades = excludedTradeId
    ? portfolioState.trades.filter((trade) => trade.id !== excludedTradeId)
    : portfolioState.trades;

  const best = eligible.find((item) => {
    if (alreadyOpen(activeTrades, item.tokenId)) return false;
    const block = riskBlock(item, activeTrades);
    if (!block) return true;
    skippedForRisk += 1;
    item.selectionStatus = "RISK_BLOCKED";
    item.riskBlockedByTradeId = block.tradeId;
    item.riskBlockedReason = riskBlockReason(block);
    return false;
  });

  return { best: best || null, skippedForRisk };
}

// Always answers, even when it decides against rotating.
//
// Reported on Paper 75: rotation is switched on, and the run log showed only "SKIP: not
// enough free paper capital" with nothing about rotation at all -- so from the log it was
// impossible to tell a rule declining from the logic never running. It had run. Returning
// a bare null threw away every reason it had collected, and the caller's skip path logged
// none of it.
//
// So each exit carries a reason, in the same {action, reason, reviews} shape the live
// portfolio's rotation block already renders.
function rotationReview(portfolioState, eligible, strategy, available, stake) {
  const declined = (reason, reviews = []) => ({ best: null, action: "NO_ROTATION_CANDIDATE", reason, reviews });

  // Free capital first. Rotation is what a portfolio does when it cannot fund the better
  // candidate any other way -- selling a position to buy one it could have bought outright
  // gives up a holding for nothing. This was missing entirely: rotation was evaluated
  // before the capital check below it, and its only capital test was whether the stake
  // would fit *after* an exit, which is trivially true when it already fits without one.
  // The live executor has had the rule from the start ("use free cash for a direct
  // candidate before touching existing orders or positions"); the paper side had not.
  if (available >= stake) {
    return declined(`free capital of ${available.toFixed(2)} USDC already covers the ${stake.toFixed(2)} USDC stake, so no holding needs to be sold`);
  }

  const allOpen = openTrades(portfolioState.trades).filter((trade) => trade.status === "OPEN");
  const openRows = allOpen.filter((trade) => heldHours(trade) >= ROTATION_MIN_HOLD_HOURS);
  if (!openRows.length) {
    return declined(allOpen.length
      ? `all ${allOpen.length} open trade(s) are still inside the ${ROTATION_MIN_HOLD_HOURS}h minimum hold`
      : "this portfolio holds no open paper trade to rotate out of");
  }

  // Every holding that was looked at, and what happened to it. Without this the run log
  // named the replacement candidate and nothing else -- not which position was being sold,
  // and nothing at all about why that one rather than any other.
  const reviews = [];
  const note = (trade, action, reason, extra = {}) => {
    reviews.push({ position: rotationPositionSummary(trade), action, reason, ...extra });
  };
  for (const trade of allOpen) {
    if (heldHours(trade) < ROTATION_MIN_HOLD_HOURS) {
      note(trade, "HOLD", `held ${heldHours(trade).toFixed(1)}h, below the ${ROTATION_MIN_HOLD_HOURS}h minimum`);
    }
  }

  let bestReview = null;
  for (const trade of openRows) {
    const candidate = findFirstOpenCandidate(portfolioState, eligible, trade.id).best;
    if (!candidate) {
      note(trade, "HOLD", "no eligible candidate could replace it");
      continue;
    }
    if (String(candidate.tokenId || "") === String(trade.tokenId || "")) {
      note(trade, "HOLD", "the best candidate is this same market");
      continue;
    }
    const capitalAfterExit = available + Number(trade.maxLossUsdc || trade.stakeUsdc || 0);
    if (capitalAfterExit < stake) {
      note(trade, "HOLD", `exiting frees ${capitalAfterExit.toFixed(2)} USDC, still under the ${stake.toFixed(2)} USDC stake`,
        { cashAfterExitUsdc: Number(capitalAfterExit.toFixed(4)) });
      continue;
    }

    const hold = tradeContinuationEconomics(trade, strategy);
    const candidateScore = candidateRotationScore(candidate, strategy);
    const candidateEv = Number(portfolioEconomics(candidate, strategy).expectedValueUsdc);
    const holdEv = Number(hold.expectedValue);
    if (!Number.isFinite(candidateScore) || !Number.isFinite(hold.score)) {
      note(trade, "HOLD", "the hold or the candidate has no usable score");
      continue;
    }
    if (!Number.isFinite(candidateEv) || !Number.isFinite(holdEv)) {
      note(trade, "HOLD", "the hold or the candidate has no usable expected value");
      continue;
    }

    const scoreDelta = candidateScore - hold.score;
    const evDelta = candidateEv - holdEv;
    const shared = {
      candidate: rotationCandidateSummary(candidate, candidateEv),
      cashAfterExitUsdc: Number(capitalAfterExit.toFixed(4)),
      evDeltaUsdc: Number(evDelta.toFixed(4)),
      scoreDeltaValue: Number(scoreDelta.toFixed(6)),
      holdExpectedPnlUsdc: Number(holdEv.toFixed(4)),
      rotatedExpectedPnlUsdc: Number(candidateEv.toFixed(4)),
    };
    if (scoreDelta < ROTATION_MIN_SCORE_IMPROVEMENT || evDelta < ROTATION_MIN_EV_USDC_IMPROVEMENT) {
      note(trade, "HOLD",
        `improvement too small: ${strategy.selectionMetric} ${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(4)}`
        + ` (needs ${ROTATION_MIN_SCORE_IMPROVEMENT}), EV ${evDelta >= 0 ? "+" : ""}${evDelta.toFixed(4)} USDC`
        + ` (needs ${ROTATION_MIN_EV_USDC_IMPROVEMENT})`, shared);
      continue;
    }

    note(trade, "ROTATE_CANDIDATE",
      `clears both bars: ${strategy.selectionMetric} +${scoreDelta.toFixed(4)}, EV +${evDelta.toFixed(4)} USDC`, shared);
    const review = {
      trade,
      candidate,
      hold,
      candidateScore,
      candidateEv,
      scoreDelta,
      evDelta,
      capitalAfterExit,
    };
    if (!bestReview || review.scoreDelta > bestReview.scoreDelta || (review.scoreDelta === bestReview.scoreDelta && review.evDelta > bestReview.evDelta)) {
      bestReview = review;
    }
  }
  if (bestReview) return { ...bestReview, best: bestReview, action: "ROTATION_AVAILABLE", reviews };
  // Every holding was looked at and none qualified. The per-holding reasons above are the
  // answer, so they travel with the verdict instead of being dropped on the floor.
  return declined(`none of the ${openRows.length} reviewable holding(s) cleared the rotation bars`, reviews);
}

// The shapes the run-log detail already knows how to render. It was written for the live
// executor's rotation review, and the paper side emitted a different shape entirely -- so
// the section rendered "Action: -", "Reason: -" and stopped.
function rotationPositionSummary(trade = {}) {
  const exitValue = Number(trade.currentValueUsdc ?? trade.stakeUsdc ?? 0);
  return {
    tokenId: trade.tokenId || null,
    outcome: trade.outcome || "-",
    question: trade.question || "-",
    url: trade.url || `https://polymarket.com/event/${trade.eventSlug || trade.slug || ""}`,
    estimatedExitValueUsdc: Number(exitValue.toFixed(4)),
    unrealizedPnlUsdc: Number(Number(trade.unrealizedPnlUsdc || 0).toFixed(4)),
    realizedPnlIfExitUsdc: Number((exitValue - Number(trade.totalCostUsdc || trade.stakeUsdc || 0)).toFixed(4)),
    heldHours: Number(heldHours(trade).toFixed(1)),
  };
}

function rotationCandidateSummary(candidate = {}, expectedValueUsdc = null) {
  return {
    tokenId: candidate.tokenId || null,
    outcome: candidate.outcome || "-",
    question: candidate.question || "-",
    url: candidate.url || `https://polymarket.com/event/${candidate.eventSlug || candidate.slug || ""}`,
    expectedValueUsdc: Number.isFinite(Number(expectedValueUsdc)) ? Number(Number(expectedValueUsdc).toFixed(4)) : null,
    marketProbability: Number.isFinite(Number(candidate.marketProbability)) ? Number(Number(candidate.marketProbability).toFixed(4)) : null,
    netYield: Number.isFinite(Number(candidate.netYield)) ? Number(Number(candidate.netYield).toFixed(4)) : null,
    daysToResolution: Number.isFinite(Number(candidate.daysToResolution)) ? Number(Number(candidate.daysToResolution).toFixed(2)) : null,
  };
}

function closeTradeForRotation(trade, review, strategy) {
  const closedAt = nowIso();
  const currentValue = Number(review.hold.currentValue || 0);
  const cost = Number(trade.totalCostUsdc || trade.maxLossUsdc || trade.stakeUsdc || 0);
  const realizedPnl = Number((currentValue - cost).toFixed(4));
  const realizedPnlPct = pnlPercent(realizedPnl, cost);
  const metric = strategy.selectionMetric;
  const note = [
    `Predcasne uzavreno pred vyhodnocenim kvuli lepsi paper prilezitosti.`,
    `Nova prilezitost ma ${metric} ${strategy.selectionOrder === "highest_reward_risk_first" ? review.candidateScore.toFixed(2) : `${(review.candidateScore * 100).toFixed(1)}%`} oproti drzeni ${strategy.selectionOrder === "highest_reward_risk_first" ? review.hold.score.toFixed(2) : `${(review.hold.score * 100).toFixed(1)}%`}.`,
    `Realizovany P/L pri vystupu je ${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(4)} USDC; ocekavane EV se zlepsuje o ${review.evDelta >= 0 ? "+" : ""}${review.evDelta.toFixed(4)} USDC.`,
  ].join(" ");

  return {
    ...trade,
    status: "SOLD",
    closedAt,
    resolvedAt: closedAt,
    exitReason: "ROTATED_TO_BETTER_CANDIDATE",
    exitPrice: Number(trade.currentPrice ?? trade.entryPrice ?? 0),
    currentValueUsdc: Number(currentValue.toFixed(4)),
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    realizedPnlUsdc: realizedPnl,
    realizedPnlPct,
    statusNote: note,
    rotationReview: {
      strategyId: strategy.id,
      strategyMetric: strategy.selectionMetric,
      // The shape the run-log detail renders: which holding is being sold, which
      // candidate replaces it, and every other holding that was weighed against it.
      // Without these the section could only say "Action: -" and "Reason: -".
      action: "ROTATE",
      reason: `sold the holding whose ${strategy.selectionMetric} trailed the best candidate by the widest margin`,
      best: {
        position: rotationPositionSummary(trade),
        candidate: rotationCandidateSummary(review.candidate, review.candidateEv),
        evDeltaUsdc: Number(review.evDelta.toFixed(4)),
      },
      reviews: Array.isArray(review.reviews) ? review.reviews : [],
      closedForQuestion: review.candidate.question,
      closedForOutcome: review.candidate.outcome,
      closedForTokenId: review.candidate.tokenId,
      previousScore: Number(review.hold.score.toFixed(6)),
      newScore: Number(review.candidateScore.toFixed(6)),
      scoreDelta: Number(review.scoreDelta.toFixed(6)),
      previousExpectedValueUsdc: Number(review.hold.expectedValue.toFixed(4)),
      newExpectedValueUsdc: Number(review.candidateEv.toFixed(4)),
      expectedValueDeltaUsdc: Number(review.evDelta.toFixed(4)),
      realizedPnlUsdc: realizedPnl,
      note,
    },
  };
}

function maybeOpenScheduledTrade(portfolioState, eligible, strategy = PAPER_STRATEGIES.conservative, evaluations = [], options = {}) {
  const today = pragueDateKey();
  const currentHour = pragueHourKey();
  const realizedPnl = portfolioState.trades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
  // Mirrors updatePaperPortfolio()'s baseline: a portfolio carrying a manual capital
  // adjustment must size its next trade off the same equity the dashboard shows, or it
  // skips (and undersizes) trades it can actually afford -- the dashboard's free capital
  // moves with the adjustment while this decision kept comparing against the un-adjusted
  // constant alone.
  const capitalAdjustment = Number(portfolioState.capitalAdjustmentUsdc) || 0;
  const sizingCapital = Math.max(0, PORTFOLIO_USDC + capitalAdjustment + realizedPnl);
  // Resting limit orders do not block the next one; see deployableCapital.
  const restingCapital = strategy.useLimitOrders ? waitingLimitOrderRisk(portfolioState.trades) : 0;
  const available = deployableCapital(portfolioState, strategy, sizingCapital);
  const maxFraction = Number(strategy.maxFraction ?? portfolioState.portfolio?.maxFraction ?? MAX_FRACTION);
  const configuredStake = Number(strategy.stakeUsdc ?? portfolioState.stakeUsdc ?? portfolioState.portfolio?.stakeUsdc);
  const stake = Number.isFinite(configuredStake) && configuredStake > 0
    ? configuredStake
    : sizingCapital * maxFraction;

  // Switched off is itself a reason worth logging: "rotation is off" and "rotation ran and
  // declined" look identical in a log that records neither.
  const rotationOutcome = strategy.allowRotation === false
    ? { best: null, action: "ROTATION_DISABLED", reason: "position rotation is switched off for this portfolio", reviews: [] }
    : rotationReview(portfolioState, eligible, strategy, available, stake);
  const rotation = rotationOutcome.best;
  if (rotation) {
    const closedTrade = closeTradeForRotation(rotation.trade, rotation, strategy);
    portfolioState.trades = portfolioState.trades.map((trade) => trade.id === closedTrade.id ? closedTrade : trade);
    const newTrade = openPaperTradeForStrategy(rotation.candidate, strategy, today, stake);
    newTrade.openedAfterRotationOfTradeId = closedTrade.id;
    newTrade.rotationEntryReason = closedTrade.rotationReview?.note || "";
    portfolioState.trades.unshift(newTrade);
    portfolioState.lastTradeDate = today;
    portfolioState.lastTradeHour = currentHour;
    return {
      action: "ROTATED_OPENED",
      reason: `closed weaker open paper trade and opened better ${strategy.selectionMetric} candidate`,
      trade: newTrade,
      closedTrade,
      available: rotation.capitalAfterExit - stake,
      requiredStake: stake,
      skippedForRisk: 0,
      rotationReview: closedTrade.rotationReview,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "ROTATED_OPENED",
        reason: `closed weaker open paper trade and opened better ${strategy.selectionMetric} candidate`,
        available: rotation.capitalAfterExit,
        stake,
        selected: rotation.candidate,
        rotationReview: closedTrade.rotationReview,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
      }),
    };
  }

  if (available < stake) {
    // The resting total is named when there is one, or the available figure cannot be
    // reconciled with the free capital the dashboard shows -- they differ by exactly this.
    const restingNote = restingCapital > 0
      ? `; ${restingCapital.toFixed(2)} USDC of unfilled limit orders is not counted against this`
      : "";
    const reason = `not enough free paper capital for next ${strategy.label} trade: ${available.toFixed(2)} USDC available, ${stake.toFixed(2)} USDC fixed stake required${restingNote}`;
    return {
      action: "SKIP",
      reason,
      available,
      requiredStake: stake,
      insufficientCapital: true,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "SKIP",
        reason,
        available,
        stake,
        insufficientCapital: true,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
        rotationReview: rotationOutcome,
      }),
    };
  }

  if (!eligible.length) {
    const reason = `no candidates passed ${strategy.label} portfolio filters`;
    return {
      action: "SKIP",
      reason,
      available,
      requiredStake: stake,
      skippedForRisk: 0,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "SKIP",
        reason,
        available,
        stake,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
        rotationReview: rotationOutcome,
      }),
    };
  }

  const { best, skippedForRisk } = findFirstOpenCandidate(portfolioState, eligible);
  if (!best) {
    const reason = skippedForRisk > 0
      ? "no eligible non-correlated candidate"
      : "no eligible non-duplicate candidate";
    return {
      action: "SKIP",
      reason,
      available,
      requiredStake: stake,
      skippedForRisk,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "SKIP",
        reason,
        available,
        stake,
        skippedForRisk,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
        rotationReview: rotationOutcome,
      }),
    };
  }

  const trade = openPaperTradeForStrategy(best, strategy, today, stake);

  portfolioState.trades.unshift(trade);
  portfolioState.lastTradeDate = today;
  portfolioState.lastTradeHour = currentHour;
  const reason = `best ${strategy.selectionMetric} non-correlated candidate within max ${strategyMaxResolutionDays(strategy)} day resolution`;
  return {
    action: "OPENED",
    reason,
    trade,
    available: available - stake,
    requiredStake: stake,
    skippedForRisk,
    strategyId: strategy.id,
    batchLog: buildTradeBatchLog({
      portfolioState,
      strategy,
      evaluations,
      eligible,
      rankedEligible: eligible,
      action: "OPENED",
      reason,
      available,
      stake,
      selected: best,
      skippedForRisk,
      diversificationDiagnostics: options.diversificationDiagnostics || null,
      prevalidationFilter: options.prevalidationFilter || null,
    }),
  };
}

function recoveryEvaluation(state, anchor) {
  const evaluations = Array.isArray(state.evaluations) ? state.evaluations : [];
  const candidates = evaluations.filter((item) => String(item.tokenId || "") === String(anchor.tokenId));
  if (!candidates.length) return null;
  const targetTime = Date.parse(anchor.openedAt || "");
  return candidates.sort((a, b) => {
    if (a.id === anchor.sourceEvaluationId) return -1;
    if (b.id === anchor.sourceEvaluationId) return 1;
    const aDistance = Math.abs((Date.parse(a.evaluatedAt || "") || targetTime || 0) - (targetTime || 0));
    const bDistance = Math.abs((Date.parse(b.evaluatedAt || "") || targetTime || 0) - (targetTime || 0));
    return aDistance - bDistance;
  })[0];
}

function recoveredTradeFromAnchor(state, anchor) {
  const evaluation = recoveryEvaluation(state, anchor) || {};
  const entryPrice = Number(anchor.entryPrice ?? evaluation.marketPrice);
  const stake = Number(evaluation.stakeUsdc || PORTFOLIO_USDC * MAX_FRACTION);
  const shares = Number(anchor.shares ?? evaluation.executableShares ?? (Number.isFinite(entryPrice) && entryPrice > 0 ? stake / entryPrice : 0));
  const takerFee = Number(anchor.takerFeeUsdc ?? evaluation.takerFeeUsdc ?? 0);
  const totalCostUsdc = Number(anchor.totalCostUsdc ?? evaluation.totalCostUsdc ?? (stake + takerFee));
  const netGainIfWin = Number(anchor.netGainIfWinUsdc ?? evaluation.netGainIfWinUsdc ?? (shares - totalCostUsdc));
  const sourceEvaluation = {
    id: anchor.sourceEvaluationId || evaluation.id || null,
    evaluatedAt: evaluation.evaluatedAt || null,
    status: evaluation.status || "ELIGIBLE",
    thesisType: evaluation.thesisType || null,
    aiProbability: evaluation.aiProbability ?? null,
    rawProbability: evaluation.rawProbability ?? null,
    marketPrice: Number.isFinite(entryPrice) ? entryPrice : evaluation.marketPrice,
    edge: evaluation.edge ?? null,
    expectedValueUsdc: evaluation.expectedValueUsdc ?? null,
    annualizedReturn: evaluation.annualizedReturn ?? null,
    probabilityThesis: evaluation.probabilityThesis || "",
    analysisSummary: evaluation.analysisSummary || "",
    aiAnalysis: evaluation.aiAnalysis || null,
    evidence: evaluation.evidence || [],
  };

  return normalizeTrade({
    id: anchor.id,
    openedAt: anchor.openedAt,
    date: anchor.date,
    status: "OPEN",
    recoveredAt: nowIso(),
    recoveryReason: anchor.reason,
    sourceEvaluationId: sourceEvaluation.id,
    sourceEvaluation,
    question: anchor.question || evaluation.question,
    slug: anchor.slug || evaluation.slug,
    eventSlug: anchor.eventSlug || evaluation.eventSlug,
    outcome: anchor.outcome || evaluation.outcome,
    tokenId: anchor.tokenId,
    tags: evaluation.tags || [],
    riskCategory: evaluation.riskCategory,
    riskPrimaryEntity: evaluation.riskPrimaryEntity,
    riskGroupKeys: evaluation.riskGroupKeys,
    riskGroupLabels: evaluation.riskGroupLabels,
    executionMode: evaluation.executionMode || "MARKET_BUY",
    entryPrice,
    bestAsk: Number(anchor.entryPrice ?? evaluation.bestAsk ?? evaluation.marketPrice),
    bestBid: evaluation.bestBid,
    spread: evaluation.spread,
    slippage: evaluation.slippage ?? 0,
    liquidity: evaluation.liquidity,
    volume24hr: evaluation.volume24hr,
    daysToResolution: evaluation.daysToResolution,
    aiProbability: evaluation.aiProbability,
    rawProbability: evaluation.rawProbability,
    thesisType: evaluation.thesisType,
    annualizedReturn: evaluation.annualizedReturn,
    expectedValueUsdc: evaluation.expectedValueUsdc,
    stakeUsdc: Number(stake.toFixed(2)),
    shares: Number(shares.toFixed(4)),
    feesEnabled: evaluation.feesEnabled ?? takerFee > 0,
    feeType: evaluation.feeType || (takerFee > 0 ? "sports_fees_v2" : "fee_free"),
    feeRate: evaluation.feeRate ?? 0,
    takerFeeUsdc: takerFee,
    totalCostUsdc,
    grossGainIfWinUsdc: Number((shares - stake).toFixed(4)),
    netGainIfWinUsdc: netGainIfWin,
    maxLossUsdc: Number(anchor.maxLossUsdc ?? evaluation.maxLossUsdc ?? totalCostUsdc),
    currentPrice: entryPrice,
    currentValueUsdc: Number(stake.toFixed(2)),
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    marketFills: evaluation.marketFills || [{ price: entryPrice, size: Number(shares.toFixed(4)), costUsdc: Number(stake.toFixed(2)) }],
    aiAnalysis: evaluation.aiAnalysis,
    probabilityThesis: evaluation.probabilityThesis,
    analysisModel: evaluation.analysisModel,
    analysisSummary: evaluation.analysisSummary,
    statusNote: "Recovered into ledger before market refresh.",
  });
}

function recoverLedgerGaps(state) {
  let recovered = 0;
  for (const anchor of LEDGER_RECOVERY_ANCHORS) {
    const exists = state.trades.some((trade) => trade.id === anchor.id || String(trade.tokenId || "") === String(anchor.tokenId));
    if (exists) continue;
    state.trades.unshift(recoveredTradeFromAnchor(state, anchor));
    recovered += 1;
  }
  if (recovered > 0) {
    state.runLog = [
      {
        runAt: nowIso(),
        evaluatedCount: 0,
        eligibleCount: 0,
        action: "RECOVER_LEDGER",
        reason: `recovered ${recovered} paper trade(s) missing after state regression`,
        riskSkippedCount: 0,
        refreshOnly: true,
      },
      ...state.runLog,
    ].slice(0, 120);
  }
  return recovered;
}

function closedOutcome(trade) {
  const status = String(trade.status || "").toUpperCase();
  if (status === "WON") return 1;
  if (status === "LOST") return 0;
  return null;
}

function deterministicPostMortem(trade) {
  const actual = closedOutcome(trade);
  const predicted = Number(trade.aiProbability);
  const error = Number.isFinite(predicted) && actual != null ? actual - predicted : null;
  const absoluteError = error == null ? null : Math.abs(error);
  const overconfidentLoss = trade.status === "LOST" && predicted >= 0.8;
  const underpricedWin = trade.status === "WON" && Number(trade.entryPrice) <= 0.8;
  const conclusion = trade.status === "WON"
    ? "Puvodni teze byla podporena vysledkem."
    : "Puvodni teze selhala proti vysledku trhu.";
  const lessons = [
    overconfidentLoss ? "Snizit duveru u podobnych near-certain vstupu, dokud neni vice nez jen trzni konsensus." : "",
    underpricedWin ? "Podobne edge opportunity si zaslouzi vyssi prioritu, pokud zustane kladne EV po fees a slippage." : "",
    trade.thesisType === "EDGE_OPPORTUNITY" ? "Sledovat, zda nizsi pravdepodobnost kompenzuje vyssi vyplatu v realne kalibraci." : "",
    Array.isArray(trade.riskGroupLabels) && trade.riskGroupLabels.length ? `Rizikova skupina: ${trade.riskGroupLabels.slice(0, 3).join(", ")}.` : "",
  ].filter(Boolean);

  return {
    reviewedAt: nowIso(),
    model: (GEMINI_API_KEY || OPENAI_API_KEY) ? "heuristic-fallback-after-ai-error" : "heuristic-postmortem-v1",
    result: trade.status,
    actualOutcome: actual,
    predictedProbability: Number.isFinite(predicted) ? Number(predicted.toFixed(4)) : null,
    predictionError: error == null ? null : Number(error.toFixed(4)),
    absoluteError: absoluteError == null ? null : Number(absoluteError.toFixed(4)),
    conclusion,
    thesisReview: trade.probabilityThesis || trade.analysisSummary || "No stored thesis.",
    lessons,
    optimizationSignals: {
      overconfidentLoss,
      underpricedWin,
      thesisType: trade.thesisType || "UNKNOWN",
      probabilityBucket: probabilityBucket(predicted),
      factorKeys: analysisFactorKeys({
        probability: Number.isFinite(predicted) ? predicted : 0.5,
        outcome: trade.outcome,
        tags: trade.tags || [trade.riskCategory || "general"],
        spread: trade.spread,
        liquidity: trade.liquidity,
        volume24hr: trade.volume24hr,
        days: trade.daysToResolution,
        market: { negRisk: trade.feeType === "negative_risk" },
      }),
    },
  };
}

async function reviewClosedTradesWithAi(trades, state = null) {
  const reviewed = [];
  let remaining = AI_POSTMORTEM_LIMIT;

  for (const trade of trades) {
    if (!["WON", "LOST"].includes(String(trade.status || "").toUpperCase()) || trade.postMortem) {
      reviewed.push(trade);
      continue;
    }

    const fallback = deterministicPostMortem(trade);
    if ((!GEMINI_API_KEY && !OPENAI_API_KEY) || remaining <= 0) {
      reviewed.push({ ...trade, postMortem: fallback });
      continue;
    }

    remaining -= 1;
    const prompt = {
      task: "Review a resolved Polymarket paper trade. Compare the initial thesis and probability against the actual result. Produce a concise conclusion and optimization signals for future initial analysis. Use only supplied data.",
      trade: {
        question: trade.question,
        outcome: trade.outcome,
        result: trade.status,
        entryPrice: trade.entryPrice,
        aiProbability: trade.aiProbability,
        rawProbability: trade.rawProbability,
        thesisType: trade.thesisType,
        probabilityThesis: trade.probabilityThesis,
        analysisSummary: trade.analysisSummary,
        realizedPnlUsdc: trade.realizedPnlUsdc,
        realizedPnlPct: trade.realizedPnlPct,
        riskGroupLabels: trade.riskGroupLabels,
      },
      requiredJson: {
        conclusion: "short Czech sentence",
        thesisReview: "short Czech paragraph",
        lessons: ["short Czech bullet"],
        probabilityAdjustmentHint: "increase | decrease | neutral",
        factorKeysToReward: ["factor:key"],
        factorKeysToPenalize: ["factor:key"],
      },
    };
    const messages = [
      { role: "system", content: "You are a prediction-market calibration reviewer. Return only valid JSON." },
      { role: "user", content: JSON.stringify(prompt) },
    ];
    let result;
    if (GEMINI_API_KEY) {
      const estimatedInputTokens = Math.ceil(messagesToGeminiText(messages).length / 4) + 128;
      const slot = state ? aiSlotAvailability(state, estimatedInputTokens) : { allowed: true };
      if (!slot.allowed) {
        if (state) deferAiRun(state, `post-mortem deferred: ${slot.reason}`);
        reviewed.push({ ...trade, postMortem: { ...fallback, aiModelError: `Gemini post-mortem deferred: ${slot.reason}` } });
        continue;
      }
      const requestId = state ? reserveAiRequest(state, estimatedInputTokens, {
        evaluationKey: trade.sourceEvaluationId || trade.tokenId || trade.id,
        phase: "postmortem",
      }) : null;
      result = await callGeminiJson(messages);
      if (!result || result.error) {
        const message = result?.error || "Gemini post-mortem unavailable";
        const quotaLimited = isQuotaError(result);
        if (requestId) finishAiRequest(state, requestId, quotaLimited ? "QUOTA_LIMITED" : "ERROR", message);
        if (quotaLimited) recordAiQuotaBackoff(state, message);
        reviewed.push({ ...trade, postMortem: { ...fallback, aiModelError: message } });
        continue;
      }
      if (requestId) finishAiRequest(state, requestId, "SUCCESS", "", result._usage);
      result = { ...result, _model: GEMINI_MODEL, _provider: "gemini" };
    } else {
      result = await callAiJson(messages);
    }
    if (!result || result.error) {
      reviewed.push({ ...trade, postMortem: { ...fallback, aiModelError: result?.error || "OpenAI post-mortem unavailable" } });
      continue;
    }
    reviewed.push({
      ...trade,
      postMortem: {
        ...fallback,
        model: result._model || OPENAI_MODEL,
        provider: result._provider || null,
        conclusion: result.conclusion || fallback.conclusion,
        thesisReview: result.thesisReview || fallback.thesisReview,
        lessons: Array.isArray(result.lessons) && result.lessons.length ? result.lessons.slice(0, 6) : fallback.lessons,
        probabilityAdjustmentHint: result.probabilityAdjustmentHint || "neutral",
        factorKeysToReward: Array.isArray(result.factorKeysToReward) ? result.factorKeysToReward.slice(0, 8) : [],
        factorKeysToPenalize: Array.isArray(result.factorKeysToPenalize) ? result.factorKeysToPenalize.slice(0, 8) : [],
      },
    });
  }

  return reviewed;
}

function buildLearningProfile(trades, previousProfile = {}) {
  const closed = trades.filter((trade) => closedOutcome(trade) != null && Number.isFinite(Number(trade.aiProbability)));
  const profile = normalizeLearningProfile(previousProfile);
  if (!closed.length) {
    return {
      ...profile,
      updatedAt: nowIso(),
      promptRules: [
        "Prefer candidates with positive EV after fees, slippage, and market-buy execution.",
        "Do not treat market consensus alone as proof; require explicit liquidity, spread, and resolution clarity checks.",
        "Allow edge-opportunity candidates below 95% only when EV and edge are materially positive.",
      ],
    };
  }

  const buckets = {};
  const factors = new Map();
  let brier = 0;
  let bias = 0;

  for (const trade of closed) {
    const predicted = Number(trade.aiProbability);
    const actual = closedOutcome(trade);
    const error = actual - predicted;
    brier += (predicted - actual) ** 2;
    bias += error;

    const bucketKey = probabilityBucket(predicted);
    buckets[bucketKey] ||= { count: 0, predictedSum: 0, actualSum: 0 };
    buckets[bucketKey].count += 1;
    buckets[bucketKey].predictedSum += predicted;
    buckets[bucketKey].actualSum += actual;

    const postFactors = [
      ...(trade.postMortem?.optimizationSignals?.factorKeys || []),
      ...(trade.postMortem?.factorKeysToReward || []),
      ...(trade.postMortem?.factorKeysToPenalize || []),
    ];
    const keys = postFactors.length ? postFactors : analysisFactorKeys({
      probability: predicted,
      outcome: trade.outcome,
      tags: trade.tags || [trade.riskCategory || "general"],
      spread: trade.spread,
      liquidity: trade.liquidity,
      volume24hr: trade.volume24hr,
      days: trade.daysToResolution,
      market: { negRisk: false },
    });

    for (const key of new Set(keys)) {
      if (!factors.has(key)) factors.set(key, { count: 0, predictedSum: 0, actualSum: 0 });
      const record = factors.get(key);
      record.count += 1;
      record.predictedSum += predicted;
      record.actualSum += actual;
    }
  }

  const bucketCalibration = {};
  for (const [key, record] of Object.entries(buckets)) {
    const avgPredicted = record.predictedSum / record.count;
    const winRate = record.actualSum / record.count;
    bucketCalibration[key] = {
      count: record.count,
      avgPredicted: Number(avgPredicted.toFixed(4)),
      winRate: Number(winRate.toFixed(4)),
      calibrationError: Number((winRate - avgPredicted).toFixed(4)),
    };
  }

  const factorAdjustments = {};
  for (const [key, record] of factors) {
    if (record.count < 2) continue;
    const avgPredicted = record.predictedSum / record.count;
    const winRate = record.actualSum / record.count;
    const adjustment = clamp((winRate - avgPredicted) * 0.2, -0.05, 0.05);
    factorAdjustments[key] = {
      count: record.count,
      avgPredicted: Number(avgPredicted.toFixed(4)),
      winRate: Number(winRate.toFixed(4)),
      adjustment: Number(adjustment.toFixed(4)),
    };
  }

  const brierScore = brier / closed.length;
  const calibrationBias = bias / closed.length;
  const promptRules = [
    calibrationBias < -0.05 ? "Recent predictions were overconfident; penalize market-consensus-only theses." : "",
    calibrationBias > 0.05 ? "Recent predictions were too conservative; promote positive-edge opportunities with acceptable liquidity." : "",
    "Estimate AI probability from independent public evidence only; never use Polymarket price, odds, order book, volume, liquidity, or betting consensus as evidence.",
    "Use market-buy price only after the independent probability is set, solely for EV, edge, and sizing calculations.",
    "Prefer lower-probability opportunities only when edge, EV p.a., and post-fee payout all remain positive.",
    "After a loss, avoid multiplying exposure to the same event, team, or risk group until resolved.",
  ].filter(Boolean);

  return {
    version: 1,
    updatedAt: nowIso(),
    sampleSize: closed.length,
    brierScore: Number(brierScore.toFixed(4)),
    calibrationBias: Number(calibrationBias.toFixed(4)),
    bucketCalibration,
    factorAdjustments,
    promptRules,
    aiLastRun: (GEMINI_API_KEY || OPENAI_API_KEY) ? nowIso() : profile.aiLastRun,
    aiModel: (GEMINI_API_KEY || OPENAI_API_KEY) ? (GEMINI_API_KEY ? GEMINI_MODEL : OPENAI_MODEL) : profile.aiModel,
    aiProvider: (GEMINI_API_KEY || OPENAI_API_KEY) ? (GEMINI_API_KEY ? "gemini" : "openai") : profile.aiProvider,
  };
}

function marketIdentity(market = {}) {
  return String(market.conditionId || market.id || market.slug || market.question || "").trim().toLowerCase();
}

function marketScanEventIdentity(market = {}) {
  const events = Array.isArray(market.events) ? market.events : [];
  const event = events.find((item) => item && typeof item === "object") || null;
  const eventId = String(event?.id || market.eventId || market.gameId || "").trim();
  if (eventId) return `event-id:${eventId.toLowerCase()}`;

  const eventSlug = String(event?.slug || market.eventSlug || "").trim().toLowerCase();
  if (eventSlug) return `event-slug:${eventSlug}`;

  const risk = riskProfile({
    question: market.question || "",
    slug: market.slug || "",
    eventSlug: marketEventSlug(market),
    outcome: "",
    tags: tagQuestion(market.question || ""),
  });
  const matchKey = (risk.keys || []).find((key) => key.startsWith("match:"));
  if (matchKey) return matchKey;
  return `market:${marketIdentity(market)}`;
}

function mergeMarketLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const market of Array.isArray(list) ? list : []) {
      const key = marketIdentity(market);
      if (!key) continue;
      if (!byId.has(key)) byId.set(key, market);
    }
  }
  return [...byId.values()];
}

function gammaResourceUrl(resource, params = {}) {
  const url = new URL(`https://gamma-api.polymarket.com/${resource}`);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function gammaMarketsUrl(params = {}) {
  return gammaResourceUrl("markets", params);
}

function gammaEventsKeysetUrl(params = {}) {
  return gammaResourceUrl("events/keyset", params);
}

async function fetchGammaResource(url, audit = null) {
  const auditCalls = Array.isArray(audit?.calls) ? audit.calls : null;
  const auditRow = auditCalls
    ? {
      sequence: auditCalls.length + 1,
      scope: String(audit.scope || "market_scan"),
      label: String(audit.label || "Polymarket Gamma API"),
      category: audit.category ? String(audit.category) : null,
      url: url.toString(),
      parameters: Object.fromEntries(url.searchParams.entries()),
      startedAt: nowIso(),
      status: "PENDING",
      returnedCount: 0,
      error: null,
    }
    : null;
  if (auditRow) auditCalls.push(auditRow);

  try {
    const markets = await fetchJson(url);
    if (auditRow) {
      auditRow.status = "SUCCESS";
      auditRow.returnedCount = Array.isArray(markets) ? markets.length : 0;
      auditRow.completedAt = nowIso();
    }
    return markets;
  } catch (error) {
    if (auditRow) {
      auditRow.status = "ERROR";
      auditRow.error = error?.message || String(error);
      auditRow.completedAt = nowIso();
    }
    throw error;
  }
}

async function fetchGammaMarkets(params = {}, audit = null) {
  return fetchGammaResource(gammaMarketsUrl(params), audit);
}

async function fetchGammaEventsKeyset(params = {}, audit = null) {
  const page = await fetchGammaResource(gammaEventsKeysetUrl(params), audit);
  if (!page || typeof page !== "object" || !Array.isArray(page.events)) {
    throw new Error("Gamma events/keyset returned an invalid page payload");
  }
  return page;
}

function scanEventRequestParams(params = {}) {
  const endDateMax = MARKET_SCAN_MAX_DAYS == null
    ? null
    : new Date(Date.now() + MARKET_SCAN_MAX_DAYS * 86400000).toISOString();
  // Without a lower bound, ordering by endDate ascending starts every page on events
  // that ended months ago and are already closed, which retention then throws away.
  // See the note on MARKET_SCAN_LIVE_ENABLED for the measurement. A caller that has
  // already set its own bound keeps it.
  const endDateMin = new Date(Date.now() - MARKET_SCAN_END_DATE_GRACE_HOURS * 3600000).toISOString();
  return {
    end_date_min: endDateMin,
    ...params,
    ...(MARKET_SCAN_LIQUIDITY_MIN > 0 ? { liquidity_min: MARKET_SCAN_LIQUIDITY_MIN } : {}),
    ...(endDateMax && !params.end_date_max ? { end_date_max: endDateMax } : {}),
  };
}

function marketScanLiveTags() {
  return MARKET_SCAN_CATEGORY_TAGS.filter((tag) => MARKET_SCAN_LIVE_TAG_SLUGS.includes(tag.slug));
}

// One bounded request per live tag, fetched in full on every run. The live set is small
// enough that this needs no cursor: the whole point is that a match in progress cannot
// wait for the round-robin to come back round to sports.
async function loadLiveMarketScanBatch({ auditCalls = null } = {}) {
  const endDateMax = new Date(Date.now() + MARKET_SCAN_LIVE_WINDOW_HOURS * 3600000).toISOString();
  const markets = [];
  const perTag = {};
  for (const tag of marketScanLiveTags()) {
    const batch = await loadEventMarketScanBatch({
      limit: MARKET_SCAN_EVENT_BATCH_LIMIT,
      tag_id: tag.id,
      order: "endDate",
      ascending: "true",
      live: "true",
      end_date_max: endDateMax,
    }, {
      calls: auditCalls,
      scope: "live",
      label: `Live: ${tag.slug}`,
      category: tag.slug,
    });
    const annotated = annotateCategoryScanMarkets(batch, tag);
    perTag[tag.slug] = annotated.length;
    markets.push(...annotated);
  }
  return { markets, perTag };
}

function flattenEventMarkets(events = [], auditCalls = null) {
  const sourceEvents = Array.isArray(events) ? events : [];
  const markets = [];
  for (const event of sourceEvents) {
    if (!event || typeof event !== "object") continue;
    const eventContext = {
      id: event.id,
      slug: event.slug,
      title: event.title,
      category: event.category,
      categorySlug: event.categorySlug,
      categories: event.categories,
      tags: event.tags,
      endDate: event.endDate || event.end_date,
    };
    const eventMarkets = parseJsonField(event.markets);
    for (const market of Array.isArray(eventMarkets) ? eventMarkets : []) {
      if (!market || typeof market !== "object") continue;
      const nestedEvents = Array.isArray(market.events)
        ? market.events.filter((item) => item && typeof item === "object")
        : [];
      const hasSameEvent = nestedEvents.some((item) => String(item.id || item.slug || "") === String(eventContext.id || eventContext.slug || ""));
      markets.push({
        ...market,
        endDate: market.endDate || market.end_date || eventContext.endDate,
        category: market.category || eventContext.category,
        categorySlug: market.categorySlug || eventContext.categorySlug,
        categories: [
          ...(Array.isArray(eventContext.categories) ? eventContext.categories : []),
          ...(Array.isArray(market.categories) ? market.categories : []),
        ],
        tags: [
          ...(Array.isArray(eventContext.tags) ? eventContext.tags : []),
          ...(Array.isArray(market.tags) ? market.tags : []),
        ],
        events: hasSameEvent ? nestedEvents : [eventContext, ...nestedEvents],
      });
    }
  }
  const auditRow = Array.isArray(auditCalls) ? auditCalls[auditCalls.length - 1] : null;
  if (auditRow && typeof auditRow === "object") {
    auditRow.returnedCount = sourceEvents.length;
    auditRow.returnedEventCount = sourceEvents.length;
    auditRow.returnedMarketCount = markets.length;
  }
  return markets;
}

async function loadEventMarketScanBatch(params = {}, audit = null) {
  const page = await fetchGammaEventsKeyset(scanEventRequestParams(params), audit);
  const markets = flattenEventMarkets(page.events, audit?.calls);
  Object.defineProperty(markets, "__scanNextCursor", {
    value: typeof page.next_cursor === "string" && page.next_cursor.trim() ? page.next_cursor : null,
    enumerable: false,
  });
  Object.defineProperty(markets, "__scanEventCount", {
    value: Array.isArray(page.events) ? page.events.length : 0,
    enumerable: false,
  });
  Object.defineProperty(markets, "__scanLastEndDate", {
    value: String(page.events?.[page.events.length - 1]?.endDate || page.events?.[page.events.length - 1]?.end_date || "") || null,
    enumerable: false,
  });
  return markets;
}

function marketDaysLeft(market = {}) {
  return daysToEnd(marketDateContext(market, market.createdAt || market.updatedAt).endDate);
}

function marketScanMinimumDays() {
  return Math.max(0, Number(MARKET_SCAN_MIN_RESOLUTION_MINUTES) || 0) / (24 * 60);
}

function marketIsResolvedForScan(market = {}) {
  return Boolean(
    market.closed
    || market.acceptingOrders === false
  );
}

function marketScanRetentionReason(market = {}, observedAt = nowIso()) {
  if (marketIsResolvedForScan(market)) return "resolved_or_closed";

  const rawPrices = parseJsonField(market?.outcomePrices)
    .map((value) => Number(value))
    .filter(Number.isFinite);
  if (rawPrices.length && rawPrices.every((price) => price <= 0 || price >= EFFECTIVELY_CERTAIN_MARKET_PROBABILITY)) {
    return "settled_outcome_probability";
  }

  const observation = preferredMarketObservation(market, observedAt);
  if (!observation) return "no_valid_preferred_outcome_or_quote";

  const probability = Number(observation.marketProbability);
  if (!Number.isFinite(probability) || probability <= 0 || probability >= EFFECTIVELY_CERTAIN_MARKET_PROBABILITY) {
    return "settled_outcome_probability";
  }
  return null;
}

function incrementMarketScanReason(counts, reason) {
  if (!reason) return;
  counts[reason] = Number(counts[reason] || 0) + 1;
}

function sortedMarketScanReasonCounts(counts = {}) {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0])),
  );
}

function marketScanReasonText(reason) {
  const labels = {
    resolved_or_closed: "market is already resolved, closed, or no longer accepting orders",
    settled_outcome_probability: "outcome probability is already settled or effectively certain, rounding to 0% or 100%",
    no_valid_preferred_outcome_or_quote: "no executable outcome with a current quote was available",
    scan_failed_before_retention: "scan stopped before this market could be retained",
  };
  return labels[reason] || String(reason || "not retained").replace(/_/g, " ");
}

function marketScanAuditUrl(market = {}) {
  const slug = String(market.slug || market.eventSlug || "").trim();
  return slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : null;
}

function marketScanAuditRows({
  fetchedMarkets = [],
  observations = [],
  previousKeys = new Set(),
  observedAt = nowIso(),
} = {}) {
  const retainedByKey = new Map(
    observations
      .map((item) => [marketObservationKey(item), item])
      .filter(([key]) => Boolean(key)),
  );
  return fetchedMarkets.slice(0, MARKET_SCAN_AUDIT_ROW_LIMIT).map((market) => {
    const dateContext = marketDateContext(market, market.createdAt || market.updatedAt);
    const daysLeft = daysToEnd(dateContext.endDate);
    const reasonCode = marketScanRetentionReason(market, observedAt);
    const candidate = reasonCode ? null : preferredMarketObservation(market, observedAt);
    const candidateKey = candidate ? marketObservationKey(candidate) : "";
    const observation = candidateKey ? retainedByKey.get(candidateKey) : null;
    let action = "NOT_SAVED";
    let reason = reasonCode ? marketScanReasonText(reasonCode) : "no preferred outcome was retained";
    let outcome = candidate?.outcome || "";
    let probability = candidate?.marketProbability;

    if (observation) {
      action = previousKeys.has(candidateKey) ? "UPDATE" : "INSERT";
      reason = action === "INSERT"
        ? "new preferred outcome saved to the scraped catalogue"
        : "existing scraped opportunity refreshed with current market data";
      outcome = observation.outcome || outcome;
      probability = observation.marketProbability ?? probability;
    }

    return {
      marketId: String(market.conditionId || market.id || ""),
      slug: String(market.slug || ""),
      question: String(market.question || market.title || "Untitled Polymarket market"),
      url: marketScanAuditUrl(market),
      outcome: String(outcome || ""),
      marketProbability: Number.isFinite(Number(probability)) ? Number(probability) : null,
      endDate: dateContext.endDate || null,
      daysToEnd: Number.isFinite(daysLeft) ? Number(daysLeft.toFixed(2)) : null,
      liquidityUsdc: Number.isFinite(Number(market.liquidity)) ? Number(market.liquidity) : null,
      categories: marketCategoryKeys(market),
      action,
      reason,
    };
  });
}

function compareMarketsForShortHorizon(a, b) {
  const preferredDays = Math.max(1, Number(MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS) || DEFAULT_MAX_RESOLUTION_DAYS);
  const minimumDays = marketScanMinimumDays();
  const aDays = marketDaysLeft(a);
  const bDays = marketDaysLeft(b);
  const aBucket = Number.isFinite(aDays) && aDays >= minimumDays && aDays <= preferredDays ? 0 : Number.isFinite(aDays) && aDays > 0 ? 1 : 2;
  const bBucket = Number.isFinite(bDays) && bDays >= minimumDays && bDays <= preferredDays ? 0 : Number.isFinite(bDays) && bDays > 0 ? 1 : 2;
  if (aBucket !== bBucket) return aBucket - bBucket;
  if (Number.isFinite(aDays) && Number.isFinite(bDays) && aDays !== bDays) return aDays - bDays;
  return Number(b.volume24hr || 0) - Number(a.volume24hr || 0);
}

function normalizedMarketCategory(value) {
  const text = typeof value === "object" && value !== null
    ? (value.slug || value.name || value.label || value.title || "")
    : value;
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizedPolymarketTaxonomy(...sources) {
  const values = new Set();
  const add = (value) => {
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value === "string" && /[,|]/.test(value)) {
      value.split(/[,|]/).forEach(add);
      return;
    }
    const normalized = normalizedMarketCategory(value);
    if (normalized && !/^\d+$/.test(normalized)) values.add(normalized);
  };
  sources.forEach(add);
  return [...values];
}

// Gamma exposes categories and tags as distinct relations. Keep only explicit API
// category fields here; never substitute an inferred risk group or the first tag.
function marketPolymarketCategories(market = {}) {
  return normalizedPolymarketTaxonomy(
    market.category,
    market.categorySlug,
    market.categories,
    ...(Array.isArray(market.events)
      ? market.events.flatMap((event) => [event?.category, event?.categorySlug, event?.categories])
      : []),
  );
}

function marketPolymarketTags(market = {}) {
  return normalizedPolymarketTaxonomy(
    market.__scanCategoryTags,
    market.tags,
    ...(Array.isArray(market.events) ? market.events.map((event) => event?.tags) : []),
  );
}

function marketCategoryKeys(market = {}) {
  const categories = new Set();
  const add = (value) => {
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value === "string" && /[,|]/.test(value)) {
      value.split(/[,|]/).forEach(add);
      return;
    }
    const normalized = normalizedMarketCategory(value);
    if (normalized && !/^\d+$/.test(normalized)) categories.add(normalized);
  };

  add(marketPolymarketCategories(market));
  add(marketPolymarketTags(market));

  const inferred = tagQuestion(market.question || "").filter((tag) => tag !== "clear-resolution");
  inferred.forEach(add);
  return categories.size ? [...categories] : ["general"];
}

function marketScanPriority(market = {}) {
  const days = marketDaysLeft(market);
  const preferredDays = Math.max(1, Number(MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS) || DEFAULT_MAX_RESOLUTION_DAYS);
  const minimumDays = marketScanMinimumDays();
  const shortHorizon = Number.isFinite(days) && days >= minimumDays && days <= preferredDays;
  const liquid = Number(market.liquidity || 0) >= MARKET_SCAN_DIVERSITY_LIQUIDITY_USDC;
  if (shortHorizon && liquid) return 0;
  if (shortHorizon) return 1;
  if (liquid) return 2;
  return 3;
}

function compareMarketsForDiverseScan(a, b) {
  const priorityDifference = marketScanPriority(a) - marketScanPriority(b);
  if (priorityDifference !== 0) return priorityDifference;
  const horizonDifference = compareMarketsForShortHorizon(a, b);
  if (horizonDifference !== 0) return horizonDifference;
  return Number(b.liquidity || 0) - Number(a.liquidity || 0);
}

function marketCategoryCounts(markets = []) {
  const counts = {};
  for (const market of markets) {
    for (const category of marketCategoryKeys(market)) {
      counts[category] = Number(counts[category] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 32));
}

function marketTagCounts(markets = []) {
  const counts = {};
  for (const market of markets) {
    const tags = new Set();
    const add = (value) => {
      if (Array.isArray(value)) {
        value.forEach(add);
        return;
      }
      if (typeof value === "string" && /[,|]/.test(value)) {
        value.split(/[,|]/).forEach(add);
        return;
      }
      const normalized = normalizedMarketCategory(value);
      if (normalized && !/^\d+$/.test(normalized)) tags.add(normalized);
    };
    add(market.tags);
    add(market.__scanCategoryTags);
    for (const event of Array.isArray(market.events) ? market.events : []) add(event?.tags);
    for (const tag of tagQuestion(market.question || "")) {
      if (tag !== "clear-resolution") add(tag);
    }
    for (const tag of tags) counts[tag] = Number(counts[tag] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 32));
}

function diversifyMarketScanOrder(markets = []) {
  const ordered = mergeMarketLists(markets).sort(compareMarketsForDiverseScan);
  const buckets = new Map();
  for (const market of ordered) {
    for (const category of marketCategoryKeys(market)) {
      if (!buckets.has(category)) buckets.set(category, []);
      buckets.get(category).push(market);
    }
  }

  const categoryFirstRows = [...buckets.entries()]
    .sort((a, b) => compareMarketsForDiverseScan(a[1][0], b[1][0]) || a[0].localeCompare(b[0]))
    .map(([, rows]) => rows[0]);
  const firstByCategory = [];
  const firstMarketKeys = new Set();
  for (const market of categoryFirstRows) {
    const key = marketIdentity(market);
    if (!key || firstMarketKeys.has(key)) continue;
    firstMarketKeys.add(key);
    firstByCategory.push(market);
  }
  const selected = new Set(firstByCategory.map(marketIdentity));
  return [...firstByCategory, ...ordered.filter((market) => !selected.has(marketIdentity(market)))];
}

function activeScanEventKeys(observations = []) {
  const keys = new Set();
  for (const observation of observations) {
    const status = String(observation?.status || observation?.selectionStatus || "").toUpperCase();
    if (status === "RESOLVED") continue;
    const key = marketScanEventIdentity(observation);
    if (key) keys.add(key);
  }
  return keys;
}

function unseenScanEventCount(markets = [], knownEventKeys = new Set()) {
  const unseen = new Set();
  for (const market of markets) {
    const key = marketScanEventIdentity(market);
    if (key && !knownEventKeys.has(key)) unseen.add(key);
  }
  return unseen.size;
}

async function loadMarkets() {
  const preferred = await fetchGammaMarkets({
    limit: "60",
    order: "endDate",
    ascending: "true",
  });
  const broad = await fetchGammaMarkets({
    limit: "60",
    order: "volume24hr",
    ascending: "false",
  });
  return mergeMarketLists(preferred, broad)
    .filter((market) => !marketIsResolvedForScan(market))
    .sort(compareMarketsForShortHorizon);
}

function scanBatchNextCursor(batch = []) {
  const cursor = String(batch?.__scanNextCursor || "").trim();
  return cursor || null;
}

async function loadPreferredMarketScanBatch({ afterCursor = null, auditCalls = null } = {}) {
  const params = {
    limit: MARKET_SCAN_EVENT_BATCH_LIMIT,
    order: "endDate",
    ascending: "true",
    ...(afterCursor ? { after_cursor: afterCursor } : {}),
  };
  return loadEventMarketScanBatch(params, {
    calls: auditCalls,
    scope: "preferred_horizon",
    label: "Preferred near-resolution events",
  });
}

function scanCategoriesForRun(previousScan = {}) {
  if (MARKET_SCAN_TAG && MARKET_SCAN_TAG !== "all") {
    const selected = MARKET_SCAN_CATEGORY_TAGS.find((tag) => tag.slug === MARKET_SCAN_TAG);
    return selected ? [selected] : [];
  }
  return MARKET_SCAN_CATEGORY_TAGS;
}

function annotateCategoryScanMarkets(markets, tag) {
  const annotated = (Array.isArray(markets) ? markets : []).map((market) => ({
    ...market,
    __scanCategoryTags: [...new Set([...(Array.isArray(market.__scanCategoryTags) ? market.__scanCategoryTags : []), tag.slug])],
  }));
  Object.defineProperty(annotated, "__scanNextCursor", {
    value: scanBatchNextCursor(markets),
    enumerable: false,
  });
  Object.defineProperty(annotated, "__scanEventCount", {
    value: Number(markets?.__scanEventCount || 0),
    enumerable: false,
  });
  Object.defineProperty(annotated, "__scanLastEndDate", {
    value: markets?.__scanLastEndDate || null,
    enumerable: false,
  });
  return annotated;
}

async function loadCategoryMarketScanBatch(tag, { afterCursor = null, auditCalls = null } = {}) {
  const params = {
    limit: MARKET_SCAN_EVENT_BATCH_LIMIT,
    tag_id: tag.id,
    order: "endDate",
    ascending: "true",
    ...(afterCursor ? { after_cursor: afterCursor } : {}),
  };
  const markets = await loadEventMarketScanBatch(params, {
    calls: auditCalls,
    scope: "category",
    label: `Category: ${tag.slug}`,
    category: tag.slug,
  });
  return annotateCategoryScanMarkets(markets, tag);
}

function compareObservationsForMarketScan(a, b) {
  const preferredDays = Math.max(1, Number(MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS) || DEFAULT_MAX_RESOLUTION_DAYS);
  const minimumDays = marketScanMinimumDays();
  const aDays = daysToEnd(a?.endDate);
  const bDays = daysToEnd(b?.endDate);
  const aBucket = Number.isFinite(aDays) && aDays >= minimumDays && aDays <= preferredDays ? 0 : Number.isFinite(aDays) && aDays > 0 ? 1 : 2;
  const bBucket = Number.isFinite(bDays) && bDays >= minimumDays && bDays <= preferredDays ? 0 : Number.isFinite(bDays) && bDays > 0 ? 1 : 2;
  if (aBucket !== bBucket) return aBucket - bBucket;
  if (Number.isFinite(aDays) && Number.isFinite(bDays) && aDays !== bDays) return aDays - bDays;
  if (Number(b.marketProbability || 0) !== Number(a.marketProbability || 0)) return Number(b.marketProbability || 0) - Number(a.marketProbability || 0);
  return Number(b.volume24hr || 0) - Number(a.volume24hr || 0);
}

function validMarketProbability(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric < 1 ? numeric : null;
}

function finalOutcomePriceValue(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : null;
}

function binaryOutcomeQuotesAreBothZero(item = {}) {
  // Each CLOB market has a two-sided book, even when its parent Polymarket event is
  // semantically multi-outcome. `outcomeCount` is therefore only a legacy settlement
  // fallback here; portfolio market type is classified separately by reportMarketType().
  const hasBinaryMetadata = Boolean(item?.binaryYesTokenId || item?.binaryNoTokenId)
    || String(item?.marketType || "").toLowerCase() === "binary"
    || Number(item?.outcomeCount) === 2;
  if (!hasBinaryMetadata) return false;
  const yesRaw = item?.binaryYesMarketProbability;
  const noRaw = item?.binaryNoMarketProbability;
  if (yesRaw == null || noRaw == null || yesRaw === "" || noRaw === "") return false;
  const yes = Number(yesRaw);
  const no = Number(noRaw);
  return Number.isFinite(yes) && Number.isFinite(no) && yes === 0 && no === 0;
}

function annualizationDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return null;
  return Math.max(MIN_ANNUALIZATION_DAYS, days);
}

function annualizeReturn(value, days) {
  if (!Number.isFinite(value)) return null;
  const horizon = annualizationDays(days);
  return horizon == null ? value : value * (365 / horizon);
}

function annualizedPotentialReturn(netYield, days) {
  return annualizeReturn(netYield, days);
}

function normalizeMarketObservationEconomics(observation) {
  if (binaryOutcomeQuotesAreBothZero(observation)) {
    return {
      ...observation,
      status: "RESOLVED",
      selectionStatus: "RESOLVED",
      resolutionStatus: observation.resolutionStatus || "PENDING_RESULT",
      resolvedAt: observation.resolvedAt || observation.endDate || nowIso(),
      resolvedDetectedAt: observation.resolvedDetectedAt || nowIso(),
    };
  }
  const price = validMarketProbability(observation?.marketPrice ?? observation?.marketProbability);
  const probability = validMarketProbability(observation?.marketProbability);
  const stake = Number(observation?.stakeUsdc);
  if (!Number.isFinite(price) || !Number.isFinite(probability) || !Number.isFinite(stake) || stake <= 0) return observation;

  const shares = stake / price;
  const feeRate = Math.max(0, Number(observation?.feeRate) || 0);
  const takerFee = takerFeeForFills([{ price, size: shares }], feeRate);
  const totalCost = stake + takerFee;
  const netGainIfWin = shares - totalCost;
  const netYield = totalCost > 0 ? netGainIfWin / totalCost : null;
  const expectedValue = probability * shares - totalCost;
  const expectedRoi = totalCost > 0 ? expectedValue / totalCost : null;
  const days = daysToEnd(observation.endDate);
  const marketAnnualizedReturn = Number.isFinite(expectedRoi)
    ? annualizeReturn(expectedRoi, days)
    : null;
  const potentialAnnualizedReturn = annualizedPotentialReturn(netYield, days);

  return {
    ...observation,
    marketPrice: Number(price.toFixed(4)),
    marketProbability: Number(probability.toFixed(4)),
    daysToResolution: Number.isFinite(days) ? Number(days.toFixed(2)) : observation.daysToResolution ?? null,
    executableShares: Number(shares.toFixed(4)),
    takerFeeUsdc: Number(takerFee.toFixed(5)),
    totalCostUsdc: Number(totalCost.toFixed(5)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    riskReward: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    potentialAnnualizedReturn: Number.isFinite(potentialAnnualizedReturn) ? Number(potentialAnnualizedReturn.toFixed(4)) : null,
    marketExpectedValueUsdc: Number(expectedValue.toFixed(4)),
    marketExpectedRoi: Number.isFinite(expectedRoi) ? Number(expectedRoi.toFixed(4)) : null,
    marketAnnualizedReturn: Number.isFinite(marketAnnualizedReturn) ? Number(marketAnnualizedReturn.toFixed(4)) : null,
    expectedValueUsdc: Number(expectedValue.toFixed(4)),
    annualizedReturn: Number.isFinite(marketAnnualizedReturn) ? Number(marketAnnualizedReturn.toFixed(4)) : null,
  };
}

function preferredMarketObservation(market, observedAt = nowIso()) {
  const outcomes = parseJsonField(market?.outcomes).map((outcome) => String(outcome || ""));
  const prices = parseJsonField(market?.outcomePrices).map(validMarketProbability);
  const tokenIds = parseJsonField(market?.clobTokenIds).map((tokenId) => String(tokenId || ""));
  const binary = binaryYesNoOutcomeIndexes(outcomes);
  let outcomeIndex = -1;
  let binaryYesPrice = null;
  let binaryNoPrice = null;

  if (binary) {
    binaryYesPrice = prices[binary.yesIndex];
    binaryNoPrice = prices[binary.noIndex] ?? (binaryYesPrice == null ? null : 1 - binaryYesPrice);
    if (binaryYesPrice == null && binaryNoPrice == null) return null;
    outcomeIndex = binaryYesPrice != null && (binaryNoPrice == null || binaryYesPrice >= binaryNoPrice)
      ? binary.yesIndex
      : binary.noIndex;
  } else {
    let best = -1;
    for (let index = 0; index < Math.min(outcomes.length, prices.length, tokenIds.length); index += 1) {
      if (prices[index] != null && prices[index] > best) {
        best = prices[index];
        outcomeIndex = index;
      }
    }
  }

  const probability = binary && outcomeIndex === binary.noIndex ? binaryNoPrice : prices[outcomeIndex];
  const tokenId = tokenIds[outcomeIndex];
  if (outcomeIndex < 0 || probability == null || probability < 0.5 || !tokenId) return null;

  const marketKey = binary
    ? binaryMarketKeyFromMarket(market)
    : `token:${tokenId}`;
  if (!marketKey) return null;
  const dateContext = marketDateContext(market, market.createdAt || market.updatedAt);
  const endDate = dateContext.endDate;
  const days = daysToEnd(endDate);
  const stake = PORTFOLIO_USDC * MAX_FRACTION;
  const fees = feeConfig(market);
  const shares = stake / probability;
  const takerFee = takerFeeForFills([{ price: probability, size: shares }], fees.feeRate);
  const totalCost = stake + takerFee;
  const netGainIfWin = shares - stake - takerFee;
  const netYield = totalCost > 0 ? netGainIfWin / totalCost : null;
  const riskReward = totalCost > 0 ? netGainIfWin / totalCost : null;
  const marketExpectedValue = probability * shares - stake - takerFee;
  const marketExpectedRoi = totalCost > 0 ? marketExpectedValue / totalCost : null;
  const marketAnnualizedReturn = Number.isFinite(marketExpectedRoi)
    ? annualizeReturn(marketExpectedRoi, days)
    : marketExpectedRoi;
  const potentialAnnualizedReturn = annualizedPotentialReturn(netYield, days);
  const tags = tagQuestion(market.question || "");
  const polymarketCategories = marketPolymarketCategories(market);
  const polymarketTags = marketPolymarketTags(market);
  const risk = riskProfile({
    question: market.question || "",
    slug: market.slug,
    eventSlug: marketEventSlug(market),
    outcome: outcomes[outcomeIndex],
    tags,
  });
  return {
    id: marketKey,
    marketKey,
    marketId: String(market.conditionId || market.id || ""),
    question: String(market.question || ""),
    slug: String(market.slug || ""),
    eventSlug: marketEventSlug(market),
    outcome: outcomes[outcomeIndex],
    tokenId,
    status: market.closed || market.acceptingOrders === false ? "RESOLVED" : "SCRAPED",
    selectionStatus: market.closed || market.acceptingOrders === false ? "RESOLVED" : "SCRAPED",
    marketType: reportMarketType({ question: market.question || "", slug: market.slug, eventSlug: marketEventSlug(market), outcome: outcomes[outcomeIndex], outcomeCount: outcomes.length }),
    tags,
    polymarketCategories,
    polymarketTags,
    riskCategory: risk.category,
    riskPrimaryEntity: risk.primaryEntity,
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    marketPrice: Number(probability.toFixed(4)),
    marketProbability: Number(probability.toFixed(4)),
    binaryYesMarketProbability: binary && binaryYesPrice != null ? Number(binaryYesPrice.toFixed(4)) : null,
    binaryNoMarketProbability: binary && binaryNoPrice != null ? Number(binaryNoPrice.toFixed(4)) : null,
    binaryYesTokenId: binary ? tokenIds[binary.yesIndex] || "" : "",
    binaryNoTokenId: binary ? tokenIds[binary.noIndex] || "" : "",
    outcomeCount: outcomes.length,
    endDate,
    scheduledEventDate: dateContext.scheduledEventDate,
    resolutionEndDate: dateContext.resolutionEndDate,
    endDateSource: dateContext.endDateSource,
    daysToResolution: days == null ? null : Number(days.toFixed(2)),
    liquidity: Number(market.liquidity || 0),
    volume24hr: Number(market.volume24hr || 0),
    volumeUsdc: Number(marketVolumeUsdc(market).toFixed(2)),
    stakeUsdc: Number(stake.toFixed(2)),
    executableShares: Number(shares.toFixed(4)),
    takerFeeUsdc: Number(takerFee.toFixed(5)),
    totalCostUsdc: Number(totalCost.toFixed(5)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    riskReward: Number.isFinite(riskReward) ? Number(riskReward.toFixed(4)) : null,
    potentialAnnualizedReturn: Number.isFinite(potentialAnnualizedReturn) ? Number(potentialAnnualizedReturn.toFixed(4)) : null,
    marketExpectedValueUsdc: Number(marketExpectedValue.toFixed(4)),
    marketExpectedRoi: Number.isFinite(marketExpectedRoi) ? Number(marketExpectedRoi.toFixed(4)) : null,
    marketAnnualizedReturn: Number.isFinite(marketAnnualizedReturn) ? Number(marketAnnualizedReturn.toFixed(4)) : null,
    annualizedReturn: Number.isFinite(marketAnnualizedReturn) ? Number(marketAnnualizedReturn.toFixed(4)) : null,
    expectedValueUsdc: Number(marketExpectedValue.toFixed(4)),
    feesEnabled: fees.feesEnabled,
    feeType: fees.feeType,
    feeRate: fees.feeRate,
    marketDataUpdatedAt: observedAt,
    observedAt,
    firstObservedAt: observedAt,
    firstMarketProbability: Number(probability.toFixed(4)),
    firstLiquidity: Number(Number(market.liquidity || 0).toFixed(2)),
    firstVolumeUsdc: Number(marketVolumeUsdc(market).toFixed(2)),
    firstVolume24hr: Number(Number(market.volume24hr || 0).toFixed(2)),
    firstDaysToResolution: days == null ? null : Number(days.toFixed(2)),
    firstFeeRate: fees.feeRate,
    firstOutcome: outcomes[outcomeIndex],
    firstTokenId: tokenId,
    firstCategory: risk.category,
    firstTags: tags,
    firstPolymarketCategories: polymarketCategories,
    firstPolymarketTags: polymarketTags,
    source: "polymarket-gamma",
  };
}

function marketScanQuerySignature() {
  return JSON.stringify({
    tag: MARKET_SCAN_TAG || "all",
    liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
    maxDays: MARKET_SCAN_MAX_DAYS,
    batchEvents: MARKET_SCAN_EVENT_BATCH_LIMIT,
  });
}

// Sports and esports carry the short-lived fixtures this portfolio actually trades, but
// the catalogue rotation has 24 scopes, so each tag's full pass came round only every few
// hours. The live pass covers what resolves within MARKET_SCAN_LIVE_WINDOW_HOURS on every
// run; anything further out waited for the rotation. These two tags now get a guaranteed
// slot instead: if one has not had a full pass within the interval, it is scanned next.
const MARKET_SCAN_HOURLY_TAG_SLUGS = ["sports", "esports"];
const MARKET_SCAN_HOURLY_INTERVAL_MINUTES = Math.max(
  0,
  envNumber("PAPER_MARKET_SCAN_HOURLY_INTERVAL_MINUTES", 60),
);

// Which of the guaranteed tags is most overdue, or null when none is due. Picking the
// oldest keeps the two from starving each other when both come due at once.
function overdueHourlyScanScope(scopes = [], previousScan = {}, now = Date.now()) {
  if (MARKET_SCAN_HOURLY_INTERVAL_MINUTES <= 0) return null;
  if (MARKET_SCAN_TAG && MARKET_SCAN_TAG !== "all") return null;
  const scannedAt = previousScan?.tagScannedAt && typeof previousScan.tagScannedAt === "object"
    ? previousScan.tagScannedAt
    : {};
  const dueBefore = now - MARKET_SCAN_HOURLY_INTERVAL_MINUTES * 60000;
  let oldest = null;
  for (const slug of MARKET_SCAN_HOURLY_TAG_SLUGS) {
    const index = scopes.findIndex((scope) => scope.tag?.slug === slug);
    if (index < 0) continue;
    // Never scanned is treated as infinitely overdue, so a fresh state starts with these.
    const last = Date.parse(scannedAt[scopes[index].key] || "") || 0;
    if (last > dueBefore) continue;
    if (!oldest || last < oldest.last) oldest = { index, last };
  }
  return oldest ? oldest.index : null;
}

// Gamma answers a tag lookup either as the tag object itself or as a one-element list,
// depending on the route, so both shapes are accepted and the slug is re-checked before
// the id is trusted.
function gammaTagRecord(payload, slug) {
  const candidates = Array.isArray(payload) ? payload : [payload];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const candidateSlug = String(candidate.slug || "").trim().toLowerCase();
    const id = String(candidate.id ?? "").trim();
    if (!id || (candidateSlug && candidateSlug !== slug)) continue;
    return { id, slug: candidateSlug || slug };
  }
  return null;
}

// The catalogue below carries Polymarket's broad navigation tags, but the dashboard's tag
// picker is built from the tags observed on stored markets — a far wider set. Asking for
// one of those (say `clf`) used to abort the scan before it could record anything, so the
// run published nothing and still exited 0. Look the slug up on Gamma instead; the scan
// itself needs the numeric tag_id, which only this endpoint can supply.
async function fetchGammaTagBySlug(slug, auditCalls = null) {
  const routes = [`tags/slug/${encodeURIComponent(slug)}`, `tags?slug=${encodeURIComponent(slug)}`];
  let lastError = null;
  for (const route of routes) {
    const url = new URL(`https://gamma-api.polymarket.com/${route}`);
    try {
      const payload = await fetchGammaResource(url, {
        calls: auditCalls,
        scope: "tag_lookup",
        label: `Tag lookup: ${slug}`,
        category: slug,
      });
      const tag = gammaTagRecord(payload, slug);
      if (tag) return tag;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

// A resolved id is written back into the caller's map so it can be persisted with the
// scan state: repeat scans of the same tag then cost no extra request, and a Gamma outage
// cannot take away a tag that already scanned once.
async function resolveMarketScanTag(slug, resolvedTagIds = {}, auditCalls = null) {
  const known = MARKET_SCAN_CATEGORY_TAGS.find((tag) => tag.slug === slug);
  if (known) return known;
  const cached = String(resolvedTagIds?.[slug] || "").trim();
  if (cached) return { id: cached, slug };
  const resolved = await fetchGammaTagBySlug(slug, auditCalls);
  if (!resolved) throw new Error(`Polymarket has no tag with slug "${slug}"`);
  if (resolvedTagIds && typeof resolvedTagIds === "object") resolvedTagIds[slug] = resolved.id;
  return resolved;
}

async function marketScanScopes(resolvedTagIds = {}, auditCalls = null) {
  if (MARKET_SCAN_TAG && MARKET_SCAN_TAG !== "all") {
    const selected = await resolveMarketScanTag(MARKET_SCAN_TAG, resolvedTagIds, auditCalls);
    return [{ key: `tag:${selected.slug}`, label: `Category: ${selected.slug}`, tag: selected }];
  }
  return [
    { key: "all", label: "All active events", tag: null },
    ...MARKET_SCAN_CATEGORY_TAGS.map((tag) => ({ key: `tag:${tag.slug}`, label: `Category: ${tag.slug}`, tag })),
  ];
}

async function refreshMarketObservations(state) {
  const previousScan = normalizeMarketScan(state.marketScan);
  const focusedRefresh = REFRESH_TOKEN_ID !== "" || REFRESH_MARKET_SLUG !== "";
  if (focusedRefresh) {
    const stored = [
      ...(Array.isArray(state.marketObservations) ? state.marketObservations : []),
      ...(Array.isArray(state.evaluations) ? state.evaluations : []),
    ].find((item) => String(item?.tokenId || "") === REFRESH_TOKEN_ID
      || (REFRESH_MARKET_SLUG !== "" && String(item?.slug || item?.eventSlug || "") === REFRESH_MARKET_SLUG));
    const slug = REFRESH_MARKET_SLUG || String(stored?.slug || stored?.eventSlug || "");
    const market = await fetchMarketBySlug(slug);
    if (!market) throw new Error("selected scraped market was not found on Polymarket");

    const observedAt = nowIso();
    let observation = preferredMarketObservation(market, observedAt);
    const marketIsResolved = marketIsResolvedForScan(market);
    if (observation && marketIsResolved) {
      observation = {
        ...observation,
        status: "RESOLVED",
        selectionStatus: "RESOLVED",
        resolutionStatus: "PENDING_RESULT",
        resolvedAt: market.closedTime || observedAt,
        resolvedDetectedAt: observedAt,
      };
    }
    if (!observation && stored && marketIsResolved) {
      observation = {
        ...stored,
        status: "RESOLVED",
        selectionStatus: "RESOLVED",
        resolutionStatus: stored.resolutionStatus || "PENDING_RESULT",
        resolvedAt: stored.resolvedAt || market.closedTime || observedAt,
        resolvedDetectedAt: observedAt,
        marketDataUpdatedAt: observedAt,
        observedAt,
      };
    }
    if (!observation) throw new Error("selected scraped market has no current executable Polymarket quote");
    state.marketObservations = retainMarketObservations(
      mergeMarketObservationLists([observation], state.marketObservations || []).map(normalizeMarketObservationEconomics),
    );
    state.marketScan = { ...previousScan, lastScanError: null };
    return [observation];
  }

  const scanRunAt = nowIso();
  const scanTrigger = String(process.env.PAPER_MARKET_SCAN_TRIGGER || (MANUAL_RUN_ONCE ? "MANUAL" : "AUTO")).toUpperCase();
  const querySignature = marketScanQuerySignature();
  const savedCursors = previousScan.scanQuerySignature === querySignature ? { ...previousScan.scanCursors } : {};
  const resolvedTagIds = { ...previousScan.resolvedTagIds };
  const apiCallAudit = [];
  // The scope is picked inside the try so that a scan which cannot even choose one still
  // records a run. Resolving it beforehand meant an unknown tag threw past the catch: no
  // history row was written, nothing was published, and the workflow still reported
  // success -- a manual scan that looked like it had worked and left no log behind.
  let scope = null;
  let afterCursor = null;
  let usedHourlySlot = false;

  try {
    const scopes = await marketScanScopes(resolvedTagIds, apiCallAudit);
    if (!scopes.length) throw new Error(`unknown Polymarket scan tag: ${MARKET_SCAN_TAG}`);
    const rotationIndex = Math.max(0, previousScan.scanScopeCursor % scopes.length);
    // An overdue guaranteed tag takes this run's slot. The rotation cursor is left where it
    // was, so the borrowed slot delays the rotation by one run rather than skipping a scope.
    const hourlyIndex = overdueHourlyScanScope(scopes, previousScan);
    const scopeIndex = hourlyIndex == null ? rotationIndex : hourlyIndex;
    usedHourlySlot = hourlyIndex != null && hourlyIndex !== rotationIndex;
    scope = scopes[scopeIndex];
    afterCursor = savedCursors[scope.key] || null;
    const batch = scope.tag
      ? await loadCategoryMarketScanBatch(scope.tag, { afterCursor, auditCalls: apiCallAudit })
      : await loadPreferredMarketScanBatch({ afterCursor, auditCalls: apiCallAudit });
    const nextCursor = scanBatchNextCursor(batch);
    if (nextCursor) savedCursors[scope.key] = nextCursor;
    else delete savedCursors[scope.key];

    // Live events are fetched in addition to the rotating scope, never instead of it.
    // A failure here is logged and dropped: the catalogue scan is the job that must
    // keep working, and losing one live batch costs nothing the next run cannot redo.
    let liveMarkets = [];
    let liveScanPerTag = {};
    let liveScanError = null;
    if (MARKET_SCAN_LIVE_ENABLED) {
      try {
        const live = await loadLiveMarketScanBatch({ auditCalls: apiCallAudit });
        liveMarkets = live.markets;
        liveScanPerTag = live.perTag;
      } catch (error) {
        liveScanError = error?.message || String(error);
        console.warn(`Live event scan failed (${liveScanError}); continuing with the rotating scope only.`);
      }
    }

    // Live rows go first so that if anything downstream is bounded, the events that are
    // happening right now are the ones that survive.
    const fetchedMarkets = [...liveMarkets, ...diversifyMarketScanOrder(batch)];
    const knownEventKeys = activeScanEventKeys(state.marketObservations || []);
    const unseenEventCount = unseenScanEventCount(fetchedMarkets, knownEventKeys);
    const scanReasonCounts = {};
    const markets = [];
    for (const market of fetchedMarkets) {
      const reason = marketScanRetentionReason(market, scanRunAt);
      if (reason) incrementMarketScanReason(scanReasonCounts, reason);
      else markets.push(market);
    }
    const observations = markets
      .map((market) => preferredMarketObservation(market, scanRunAt))
      .filter((item) => {
        const probability = Number(item?.marketProbability);
        const status = String(item?.status || item?.selectionStatus || "").toUpperCase();
        return item && Number.isFinite(probability) && probability > 0 && probability < 1 && status !== "RESOLVED";
      })
      .sort(compareObservationsForMarketScan);
    const previousKeys = new Set((state.marketObservations || []).map(marketObservationKey).filter(Boolean));
    const observationKeys = observations.map(marketObservationKey).filter(Boolean);
    const newObservationCount = observationKeys.filter((key) => !previousKeys.has(key)).length;
    const updatedObservationCount = observationKeys.filter((key) => previousKeys.has(key)).length;
    const categoryCounts = marketCategoryCounts(markets);
    const tagCounts = marketTagCounts(markets);
    const shortHorizonCount = observations.filter((item) => {
      const days = daysToEnd(item.endDate);
      return Number.isFinite(days) && days > 0 && days <= MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS;
    }).length;
    const resolvedObservationCount = Number(scanReasonCounts.resolved_or_closed || 0);
    const notRetainedReasonCounts = { ...scanReasonCounts };
    delete notRetainedReasonCounts.resolved_or_closed;
    const sortedNotRetainedReasonCounts = sortedMarketScanReasonCounts(notRetainedReasonCounts);
    const auditRows = marketScanAuditRows({ fetchedMarkets, observations, previousKeys, observedAt: scanRunAt });

    state.marketObservations = retainMarketObservations(
      mergeMarketObservationLists(observations, state.marketObservations || []).map(normalizeMarketObservationEconomics),
    );
    state.marketScan = {
      ...previousScan,
      scanCursors: savedCursors,
      resolvedTagIds,
      scanScopeCursor: usedHourlySlot ? rotationIndex : (scopeIndex + 1) % scopes.length,
      // When each scope last had a full catalogue pass, which is what the guaranteed
      // hourly slot is measured against.
      tagScannedAt: { ...(previousScan.tagScannedAt || {}), [scope.key]: scanRunAt },
      hourlyScanTagSlugs: MARKET_SCAN_HOURLY_TAG_SLUGS,
      hourlyScanIntervalMinutes: MARKET_SCAN_HOURLY_INTERVAL_MINUTES,
      usedHourlyScanSlot: usedHourlySlot,
      scanQuerySignature: querySignature,
      lastScope: scope.label,
      lastScopeCursor: afterCursor,
      lastScopeNextCursor: nextCursor,
      lastBatchEventCount: Number(batch?.__scanEventCount || 0),
      lastBatchEndDate: batch?.__scanLastEndDate || null,
      lastScanAt: scanRunAt,
      lastBatchCount: fetchedMarkets.length,
      lastPreferredCount: scope.tag ? 0 : fetchedMarkets.length,
      lastShortHorizonCount: shortHorizonCount,
      preferredMaxResolutionDays: MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS,
      minResolutionMinutes: MARKET_SCAN_MIN_RESOLUTION_MINUTES,
      minResolutionHours: MARKET_SCAN_MIN_RESOLUTION_HOURS,
      lastCategoryCount: Object.keys(categoryCounts).length,
      lastCategoryCounts: categoryCounts,
      lastRequestedCategories: [scope.tag?.slug || "all"],
      lastUnseenEventCount: unseenEventCount,
      lastEventDuplicatesSkippedCount: 0,
      priorityLiquidityUsdc: MARKET_SCAN_DIVERSITY_LIQUIDITY_USDC,
      liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
      maxDays: MARKET_SCAN_MAX_DAYS,
      lastTag: MARKET_SCAN_TAG,
      liveScanEnabled: MARKET_SCAN_LIVE_ENABLED,
      liveScanWindowHours: MARKET_SCAN_LIVE_WINDOW_HOURS,
      liveScanCount: liveMarkets.length,
      liveScanCounts: liveScanPerTag,
      liveScanError,
      endDateGraceHours: MARKET_SCAN_END_DATE_GRACE_HOURS,
      lastScanError: null,
    };
    state.marketScanHistory = trimMarketScanHistory([
      {
        id: `scan-${scanRunAt}`,
        runAt: scanRunAt,
        trigger: scanTrigger,
        status: "SUCCESS",
        apiCalls: apiCallAudit.length || 1,
        requestedBatches: 1,
        preferredMarketCount: scope.tag ? 0 : fetchedMarkets.length,
        categoryMarketCount: scope.tag ? fetchedMarkets.length : 0,
        categoryApiCalls: scope.tag ? 1 : 0,
        categoryErrors: [],
        requestedCategories: [scope.tag?.slug || "all"],
        preferredCursor: scope.tag ? 0 : 1,
        categoryOffsets: {},
        scanScope: scope.label,
        scanScopeCursor: afterCursor,
        scanScopeNextCursor: nextCursor,
        scanScopeComplete: !nextCursor,
        batchEventCount: Number(batch?.__scanEventCount || 0),
        batchEndDate: batch?.__scanLastEndDate || null,
        unseenEventCount,
        rawMarketCount: fetchedMarkets.length,
        loadedMarketCount: fetchedMarkets.length,
        retainedObservationCount: observations.length,
        newObservationCount,
        updatedObservationCount,
        resolvedObservationCount,
        resolvedSkippedCount: resolvedObservationCount,
        notRetainedCount: Object.values(sortedNotRetainedReasonCounts).reduce((total, count) => total + Number(count || 0), 0),
        notRetainedReasonCounts: sortedNotRetainedReasonCounts,
        sameEventSkippedCount: 0,
        minResolutionMinutes: MARKET_SCAN_MIN_RESOLUTION_MINUTES,
        liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
        maxDays: MARKET_SCAN_MAX_DAYS,
        scanTag: MARKET_SCAN_TAG || null,
        tagMatchedCount: fetchedMarkets.length,
        tagFilteredOutCount: 0,
        shortHorizonCount,
        categoryCounts,
        tagCounts,
        audit: {
          apiCalls: apiCallAudit,
          totalMarkets: fetchedMarkets.length,
          truncatedCount: Math.max(0, fetchedMarkets.length - auditRows.length),
          markets: auditRows,
        },
        error: null,
      },
      ...normalizeMarketScanHistory(state.marketScanHistory),
    ]);
    return observations;
  } catch (error) {
    const message = error?.message || String(error);
    // `scope` is null when the run failed before one could be chosen -- an unknown tag, or
    // a tag lookup Gamma refused. The requested tag still names the attempt, so the run is
    // reported under it rather than being dropped for want of a scope.
    const scopeLabel = scope?.label || (MARKET_SCAN_TAG ? `Category: ${MARKET_SCAN_TAG}` : "All active events");
    const scopeTagSlug = scope ? scope.tag?.slug || "all" : MARKET_SCAN_TAG || "all";
    state.marketScan = {
      ...previousScan,
      resolvedTagIds,
      lastScanAt: scanRunAt,
      lastScope: scopeLabel,
      lastScopeCursor: afterCursor,
      lastScanError: message,
      liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
      maxDays: MARKET_SCAN_MAX_DAYS,
      lastTag: MARKET_SCAN_TAG,
    };
    state.marketScanHistory = trimMarketScanHistory([
      {
        id: `scan-${scanRunAt}`,
        runAt: scanRunAt,
        trigger: scanTrigger,
        status: "ERROR",
        apiCalls: apiCallAudit.length || 1,
        requestedBatches: 1,
        preferredMarketCount: 0,
        categoryMarketCount: 0,
        categoryApiCalls: scopeTagSlug === "all" ? 0 : 1,
        categoryErrors: [{ tag: scopeTagSlug, error: message }],
        requestedCategories: [scopeTagSlug],
        scanScope: scopeLabel,
        scanScopeCursor: afterCursor,
        rawMarketCount: 0,
        loadedMarketCount: 0,
        retainedObservationCount: 0,
        newObservationCount: 0,
        updatedObservationCount: 0,
        resolvedObservationCount: 0,
        resolvedSkippedCount: 0,
        notRetainedCount: 0,
        notRetainedReasonCounts: {},
        minResolutionMinutes: MARKET_SCAN_MIN_RESOLUTION_MINUTES,
        liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
        maxDays: MARKET_SCAN_MAX_DAYS,
        scanTag: MARKET_SCAN_TAG || null,
        tagMatchedCount: 0,
        tagFilteredOutCount: 0,
        shortHorizonCount: 0,
        categoryCounts: {},
        tagCounts: {},
        audit: { apiCalls: apiCallAudit, totalMarkets: 0, truncatedCount: 0, markets: [] },
        error: message,
      },
      ...normalizeMarketScanHistory(state.marketScanHistory),
    ]);
    return [];
  }
}

async function refreshMarketObservationsLegacyFullSweep(state) {
  const previousScan = normalizeMarketScan(state.marketScan);
  const focusedRefresh = REFRESH_TOKEN_ID !== "" || REFRESH_MARKET_SLUG !== "";
  if (focusedRefresh) {
    const stored = [
      ...(Array.isArray(state.marketObservations) ? state.marketObservations : []),
      ...(Array.isArray(state.evaluations) ? state.evaluations : []),
    ].find((item) => String(item?.tokenId || "") === REFRESH_TOKEN_ID
      || (REFRESH_MARKET_SLUG !== "" && String(item?.slug || item?.eventSlug || "") === REFRESH_MARKET_SLUG));
    const slug = REFRESH_MARKET_SLUG || String(stored?.slug || stored?.eventSlug || "");
    const market = await fetchMarketBySlug(slug);
    if (!market) {
      throw new Error("selected scraped market was not found on Polymarket");
    }

    const observedAt = nowIso();
    let observation = preferredMarketObservation(market, observedAt);
    const marketIsResolved = marketIsResolvedForScan(market);

    if (observation && marketIsResolved) {
      observation = {
        ...observation,
        status: "RESOLVED",
        selectionStatus: "RESOLVED",
        resolutionStatus: "PENDING_RESULT",
        resolvedAt: market.closedTime || observedAt,
        resolvedDetectedAt: observedAt,
      };
    }
    if (!observation && stored && marketIsResolved) {
      observation = {
        ...stored,
        status: "RESOLVED",
        selectionStatus: "RESOLVED",
        resolutionStatus: stored.resolutionStatus || "PENDING_RESULT",
        resolvedAt: stored.resolvedAt || market.closedTime || observedAt,
        resolvedDetectedAt: observedAt,
        marketDataUpdatedAt: observedAt,
        observedAt,
      };
    }
    if (!observation) {
      throw new Error("selected scraped market has no current executable Polymarket quote");
    }

    state.marketObservations = mergeMarketObservationLists([observation], state.marketObservations || [])
      .map(normalizeMarketObservationEconomics);
    state.marketScan = {
      ...previousScan,
      lastScanError: null,
    };
    return [observation];
  }

  const scanRunAt = nowIso();
  const scanTrigger = String(process.env.PAPER_MARKET_SCAN_TRIGGER || (MANUAL_RUN_ONCE ? "MANUAL" : "AUTO")).toUpperCase();
  let attemptedApiCalls = 0;
  const apiCallAudit = [];
  let preferredMarkets = [];
  const categoryBatches = [];
  const categoryErrors = [];
  let preferredCursor = 0;
  const categoryOffsets = {};
  const requestedCategories = scanCategoriesForRun(previousScan);
  const knownEventKeys = activeScanEventKeys(state.marketObservations || []);
  let unseenEventCount = 0;
  const hasDirectTagScope = Boolean(MARKET_SCAN_TAG && MARKET_SCAN_TAG !== "all" && requestedCategories.length);
  const collectAllPages = async (loadPage) => {
    const markets = [];
    let afterCursor = null;
    const cursors = new Set();
    while (true) {
      attemptedApiCalls += 1;
      const page = await loadPage(afterCursor);
      if (Array.isArray(page)) markets.push(...page);
      const nextCursor = scanBatchNextCursor(page);
      if (!nextCursor || cursors.has(nextCursor)) return markets;
      cursors.add(nextCursor);
      afterCursor = nextCursor;
    }
  };
  try {
    if (!hasDirectTagScope) {
      preferredMarkets = await collectAllPages((afterCursor) => loadPreferredMarketScanBatch({
        afterCursor,
        auditCalls: apiCallAudit,
      }));
    }
    for (const category of requestedCategories) {
      try {
        const markets = await collectAllPages((afterCursor) => loadCategoryMarketScanBatch(category, {
          afterCursor,
          auditCalls: apiCallAudit,
        }));
        categoryBatches.push({ tag: category, markets });
        categoryOffsets[category.slug] = 0;
      } catch (error) {
        categoryErrors.push({ tag: category.slug, error: error?.message || String(error) });
      }
    }
    unseenEventCount = unseenScanEventCount(
      [...preferredMarkets, ...categoryBatches.flatMap((batch) => batch.markets)],
      knownEventKeys,
    );
    const categoryMarkets = categoryBatches.flatMap((batch) => batch.markets);
    const fetchedMarkets = diversifyMarketScanOrder([...preferredMarkets, ...categoryMarkets]);
    // Keep already stored RESOLVED observations for history and the Resolved
    // UI tab, but never add them to the active scrape batch again.
    const scanReasonCounts = {};
    const eligibleMarkets = [];
    for (const market of fetchedMarkets) {
      const reason = marketScanRetentionReason(market, scanRunAt);
      if (reason) incrementMarketScanReason(scanReasonCounts, reason);
      else eligibleMarkets.push(market);
    }
    // Store every active market quote. Event-level diversification belongs to
    // a portfolio's execution shortlist, not to the shared market catalogue.
    const markets = eligibleMarkets;
    const categoryCounts = marketCategoryCounts(markets);
    const tagCounts = marketTagCounts(markets);
    const observations = (Array.isArray(markets) ? markets : [])
      .map((market) => preferredMarketObservation(market, scanRunAt))
      .filter((item) => {
        if (!item) return false;
        const probability = Number(item.marketProbability);
        const status = String(item.status || item.selectionStatus || "").toUpperCase();
        return Number.isFinite(probability)
          && probability > 0
          && probability < 1
          && status !== "RESOLVED";
      })
      .sort(compareObservationsForMarketScan);
    const shortHorizonCount = observations.filter((item) => {
      const days = daysToEnd(item.endDate);
      const status = String(item.status || item.selectionStatus || "").toUpperCase();
      return status !== "RESOLVED" && Number.isFinite(days) && days > 0 && days <= MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS;
    }).length;
    const resolvedReasonCount = Number(scanReasonCounts.resolved_or_closed || 0);
    const notRetainedReasonCounts = { ...scanReasonCounts };
    delete notRetainedReasonCounts.resolved_or_closed;
    const sortedNotRetainedReasonCounts = sortedMarketScanReasonCounts(notRetainedReasonCounts);
    const previousKeys = new Set((state.marketObservations || []).map(marketObservationKey).filter(Boolean));
    const observationKeys = observations.map(marketObservationKey).filter(Boolean);
    const newObservationCount = observationKeys.filter((key) => !previousKeys.has(key)).length;
    const updatedObservationCount = observationKeys.filter((key) => previousKeys.has(key)).length;
    const resolvedObservationCount = resolvedReasonCount;
    const notRetainedCount = Object.values(sortedNotRetainedReasonCounts)
      .reduce((total, count) => total + Number(count || 0), 0);
    const auditRows = marketScanAuditRows({
      fetchedMarkets,
      observations,
      previousKeys,
      observedAt: scanRunAt,
    });
    state.marketObservations = mergeMarketObservationLists(observations, state.marketObservations || [])
      .map(normalizeMarketObservationEconomics);
    state.marketScan = {
      cursor: 0,
      preferredCursor,
      categoryCursor: 0,
      categoryOffsets,
      lastScanAt: scanRunAt,
      lastBatchCount: Array.isArray(fetchedMarkets) ? fetchedMarkets.length : 0,
      lastPreferredCount: Array.isArray(preferredMarkets) ? preferredMarkets.length : 0,
      lastShortHorizonCount: shortHorizonCount,
      preferredMaxResolutionDays: MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS,
      minResolutionMinutes: MARKET_SCAN_MIN_RESOLUTION_MINUTES,
      minResolutionHours: MARKET_SCAN_MIN_RESOLUTION_HOURS,
      lastCategoryCount: Object.keys(categoryCounts).length,
      lastCategoryCounts: categoryCounts,
      lastRequestedCategories: requestedCategories.map((category) => category.slug),
      lastUnseenEventCount: unseenEventCount,
      lastEventDuplicatesSkippedCount: 0,
      priorityLiquidityUsdc: MARKET_SCAN_DIVERSITY_LIQUIDITY_USDC,
      liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
      maxDays: MARKET_SCAN_MAX_DAYS,
      lastTag: MARKET_SCAN_TAG,
      lastScanError: categoryErrors.length
        ? categoryErrors.map((item) => `${item.tag}: ${item.error}`).join("; ")
        : null,
    };
    state.marketScanHistory = trimMarketScanHistory([
      {
        id: `scan-${scanRunAt}`,
        runAt: scanRunAt,
        trigger: scanTrigger,
        status: categoryErrors.length ? "PARTIAL" : "SUCCESS",
        apiCalls: apiCallAudit.length || attemptedApiCalls,
        requestedBatches: attemptedApiCalls,
        preferredMarketCount: preferredMarkets.length,
        categoryMarketCount: categoryMarkets.length,
        categoryApiCalls: categoryBatches.length,
        categoryErrors,
        requestedCategories: requestedCategories.map((category) => category.slug),
        preferredCursor,
        categoryOffsets,
        unseenEventCount,
        rawMarketCount: fetchedMarkets.length,
        loadedMarketCount: fetchedMarkets.length,
        retainedObservationCount: observations.length,
        newObservationCount,
        updatedObservationCount,
        resolvedObservationCount,
        resolvedSkippedCount: resolvedObservationCount,
        notRetainedCount,
        notRetainedReasonCounts: sortedNotRetainedReasonCounts,
        sameEventSkippedCount: 0,
        minResolutionMinutes: MARKET_SCAN_MIN_RESOLUTION_MINUTES,
        liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
        maxDays: MARKET_SCAN_MAX_DAYS,
        scanTag: MARKET_SCAN_TAG || null,
        tagMatchedCount: fetchedMarkets.length,
        tagFilteredOutCount: 0,
        shortHorizonCount,
        categoryCounts,
        tagCounts,
        audit: {
          apiCalls: apiCallAudit,
          markets: auditRows,
        },
        error: categoryErrors.length
          ? categoryErrors.map((item) => `${item.tag}: ${item.error}`).join("; ")
          : null,
      },
      ...normalizeMarketScanHistory(state.marketScanHistory),
    ]);
    return observations;
  } catch (error) {
    const categoryMarkets = categoryBatches.flatMap((batch) => batch.markets);
    const partialMarkets = diversifyMarketScanOrder([...preferredMarkets, ...categoryMarkets]);
    const resolvedSkippedMarkets = partialMarkets.filter(marketIsResolvedForScan);
    const categoryCounts = marketCategoryCounts(partialMarkets);
    const tagCounts = marketTagCounts(partialMarkets);
    const message = error?.message || String(error);
    const errorReasonCounts = partialMarkets.length ? { scan_failed_before_retention: partialMarkets.length } : {};
    state.marketScan = {
      ...previousScan,
      lastScanAt: scanRunAt,
      categoryCursor: 0,
      lastBatchCount: partialMarkets.length,
      lastPreferredCount: preferredMarkets.length,
      lastRequestedCategories: requestedCategories.map((category) => category.slug),
      lastCategoryCount: Object.keys(categoryCounts).length,
      lastCategoryCounts: categoryCounts,
      liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
      maxDays: MARKET_SCAN_MAX_DAYS,
      lastTag: MARKET_SCAN_TAG,
      lastScanError: message,
    };
    const errorAuditRows = partialMarkets.map((market) => ({
      marketId: String(market.conditionId || market.id || ""),
      slug: String(market.slug || ""),
      question: String(market.question || market.title || "Untitled Polymarket market"),
      url: marketScanAuditUrl(market),
      outcome: "",
      marketProbability: null,
      categories: marketCategoryKeys(market),
      action: "NOT_SAVED",
      reason: marketScanReasonText("scan_failed_before_retention"),
    }));
    state.marketScanHistory = trimMarketScanHistory([
      {
        id: `scan-${scanRunAt}`,
        runAt: scanRunAt,
        trigger: scanTrigger,
        status: "ERROR",
        apiCalls: apiCallAudit.length || attemptedApiCalls,
        requestedBatches: Math.max(1, attemptedApiCalls),
        preferredMarketCount: preferredMarkets.length,
        categoryMarketCount: categoryMarkets.length,
        categoryApiCalls: categoryBatches.length,
        categoryErrors,
        requestedCategories: requestedCategories.map((category) => category.slug),
        rawMarketCount: preferredMarkets.length + categoryMarkets.length,
        loadedMarketCount: partialMarkets.length,
        retainedObservationCount: 0,
        newObservationCount: 0,
        updatedObservationCount: 0,
        resolvedObservationCount: resolvedSkippedMarkets.length,
        resolvedSkippedCount: resolvedSkippedMarkets.length,
        notRetainedCount: partialMarkets.length,
        notRetainedReasonCounts: errorReasonCounts,
        minResolutionMinutes: MARKET_SCAN_MIN_RESOLUTION_MINUTES,
        liquidityMin: MARKET_SCAN_LIQUIDITY_MIN,
        maxDays: MARKET_SCAN_MAX_DAYS,
        scanTag: MARKET_SCAN_TAG || null,
        tagMatchedCount: partialMarkets.length,
        tagFilteredOutCount: 0,
        shortHorizonCount: 0,
        categoryCounts,
        tagCounts,
        audit: {
          apiCalls: apiCallAudit,
          markets: errorAuditRows,
        },
        error: message,
      },
      ...normalizeMarketScanHistory(state.marketScanHistory),
    ]);
    return [];
  }
}

function snapshotMatchesEvaluation(snapshot, evaluation) {
  if (!snapshot || !evaluation) return false;
  if (snapshot.marketKey.startsWith("binary:")) {
    if (binaryEvaluationMarketKey(evaluation) === snapshot.marketKey) return true;
    // Keep compatibility with evaluations written before binary metadata was
    // persisted. Slugs identify the same binary contract across both sources.
    return String(snapshot.slug || "").trim().toLowerCase() === String(evaluation.slug || "").trim().toLowerCase();
  }
  return String(snapshot.tokenId || "") === String(evaluation.tokenId || "");
}

function quoteEconomicsForStoredEvaluation(evaluation, marketPrice, probability) {
  const previousTotalCost = Number(evaluation.totalCostUsdc ?? evaluation.stakeUsdc);
  const previousFee = Number(evaluation.takerFeeUsdc ?? 0);
  const stake = Number(evaluation.stakeUsdc ?? evaluation.filledStakeUsdc ?? (previousTotalCost - previousFee));
  const days = Number(evaluation.daysToResolution);
  const feeRate = Number(evaluation.feeRate ?? 0);
  if (!Number.isFinite(stake) || stake <= 0 || !Number.isFinite(marketPrice) || marketPrice <= 0 || marketPrice >= 1 || !Number.isFinite(probability)) {
    return null;
  }

  // A binary YES/NO flip changes the actual token being bought. Rebuild every
  // quote-dependent value from that token's price; retaining previous shares
  // would combine the new side's probability with the old side's payoff.
  const shares = stake / marketPrice;
  const takerFee = takerFeeForFills([{ price: marketPrice, size: shares }], feeRate);
  const totalCost = stake + takerFee;
  const expectedValue = probability * shares - totalCost;
  const expectedRoi = totalCost > 0 ? expectedValue / totalCost : null;
  const annualizedReturn = annualizeReturn(expectedRoi, days);
  const netGainIfWin = shares - totalCost;
  const netYield = totalCost > 0 ? netGainIfWin / totalCost : null;

  return {
    stakeUsdc: Number(stake.toFixed(2)),
    executableShares: Number(shares.toFixed(4)),
    filledStakeUsdc: Number(stake.toFixed(4)),
    totalCostUsdc: Number(totalCost.toFixed(5)),
    takerFeeUsdc: Number(takerFee.toFixed(5)),
    grossGainIfWinUsdc: Number((shares - stake).toFixed(4)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    riskReward: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    expectedValueUsdc: Number(expectedValue.toFixed(4)),
    expectedRoi: Number.isFinite(expectedRoi) ? Number(expectedRoi.toFixed(4)) : null,
    annualizedReturn: Number.isFinite(annualizedReturn) ? Number(annualizedReturn.toFixed(4)) : null,
    marketFills: [{
      price: Number(marketPrice.toFixed(4)),
      size: Number(shares.toFixed(4)),
      costUsdc: Number(stake.toFixed(4)),
    }],
  };
}

function binarySideQuoteIsStale(item) {
  const hasBinaryMetadata = Boolean(item?.binaryYesTokenId || item?.binaryNoTokenId)
    || (validMarketProbability(item?.binaryYesMarketProbability) != null && validMarketProbability(item?.binaryNoMarketProbability) != null);
  if (!hasBinaryMetadata) return false;
  const entry = validMarketProbability(item.marketPrice);
  const selectedMarketProbability = validMarketProbability(item.marketProbability);
  return entry != null && selectedMarketProbability != null && Math.abs(entry - selectedMarketProbability) >= 0.1;
}

function repriceEvaluationForSelectedMarketQuote(evaluation, marketPrice, aiProbability = evaluation.aiProbability) {
  const price = validMarketProbability(marketPrice);
  const probability = Number(aiProbability);
  const aiEconomics = quoteEconomicsForStoredEvaluation(evaluation, price, probability);
  const marketEconomics = quoteEconomicsForStoredEvaluation(evaluation, price, price);
  if (!aiEconomics || !marketEconomics) return evaluation;

  return {
    ...evaluation,
    marketPrice: Number(price.toFixed(4)),
    bestAsk: Number(price.toFixed(4)),
    executableDepthUsdc: null,
    ...aiEconomics,
    aiExpectedValueUsdc: aiEconomics.expectedValueUsdc,
    aiAnnualizedReturn: aiEconomics.annualizedReturn,
    marketExpectedValueUsdc: marketEconomics.expectedValueUsdc,
    marketExpectedRoi: marketEconomics.expectedRoi,
    marketAnnualizedReturn: marketEconomics.annualizedReturn,
    edge: Number((probability - price).toFixed(4)),
    marketQuoteSource: "polymarket-gamma-selected-token",
  };
}

function recordEvaluationUpdate(previous, next, source, changedAt) {
  const changes = changedEvaluationFields(previous, next);
  if (!changes.length) return previous;
  return {
    ...next,
    updateHistory: [{
      changedAt,
      previousEvaluatedAt: previous.evaluatedAt || previous.lastSeenAt || null,
      source,
      changes,
    }, ...(Array.isArray(previous.updateHistory) ? previous.updateHistory : [])].slice(0, 30),
    lastChanges: changes,
  };
}

function repairStaleBinarySideQuotes(evaluations = []) {
  return evaluations.map((evaluation) => {
    if (!binarySideQuoteIsStale(evaluation)) return evaluation;
    const repaired = repriceEvaluationForSelectedMarketQuote(evaluation, evaluation.marketProbability, evaluation.aiProbability);
    return recordEvaluationUpdate(
      evaluation,
      {
        ...repaired,
        marketSideQuoteRepairedAt: nowIso(),
        marketSideQuoteRepairNote: "Rebuilt quote economics after a YES/NO token flip so entry, shares, fee, EV and R/R all use the selected outcome.",
      },
      "binary-side-quote-repair",
      nowIso(),
    );
  });
}

function applyMarketObservationsToEvaluations(evaluations, observations) {
  if (!observations.length || !evaluations.length) return evaluations;
  return evaluations.map((evaluation) => {
    const snapshot = observations.find((item) => snapshotMatchesEvaluation(item, evaluation));
    if (!snapshot) return evaluation;
    const outcomeChanged = String(snapshot.tokenId) !== String(evaluation.tokenId || "");
    const storedProbability = Number(evaluation.aiProbability);
    const yesProbability = Number.isFinite(Number(evaluation.binaryYesProbability))
      ? Number(evaluation.binaryYesProbability)
      : (Number.isFinite(storedProbability)
        ? (String(evaluation.outcome || "").toLowerCase() === "yes" ? storedProbability : 1 - storedProbability)
        : null);
    const nextAiProbability = Number.isFinite(yesProbability)
      ? Number((String(snapshot.outcome).toLowerCase() === "yes" ? yesProbability : 1 - yesProbability).toFixed(4))
      : evaluation.aiProbability;
    const next = normalizeEvaluationRisk({
      ...evaluation,
      id: outcomeChanged ? `token:${snapshot.tokenId}` : evaluation.id,
      tokenId: snapshot.tokenId,
      outcome: snapshot.outcome,
      marketProbability: snapshot.marketProbability,
      marketDataUpdatedAt: snapshot.marketDataUpdatedAt,
      binaryYesMarketProbability: snapshot.binaryYesMarketProbability,
      binaryNoMarketProbability: snapshot.binaryNoMarketProbability,
      binaryYesTokenId: snapshot.binaryYesTokenId || evaluation.binaryYesTokenId,
      binaryNoTokenId: snapshot.binaryNoTokenId || evaluation.binaryNoTokenId,
      marketOutcomeFlipped: outcomeChanged,
      marketOutcomeFlipAt: outcomeChanged ? snapshot.marketDataUpdatedAt : evaluation.marketOutcomeFlipAt || null,
      marketOutcomeFlipNote: outcomeChanged
        ? `Polymarket probability crossed 50%; stored outcome switched to ${snapshot.outcome} at ${(snapshot.marketProbability * 100).toFixed(1)}%.`
        : evaluation.marketOutcomeFlipNote || null,
      aiProbability: nextAiProbability,
      binaryYesProbability: Number.isFinite(yesProbability) ? Number(yesProbability.toFixed(4)) : evaluation.binaryYesProbability,
      rawProbability: Number.isFinite(yesProbability)
        ? Number((String(snapshot.outcome).toLowerCase() === "yes" ? yesProbability : 1 - yesProbability).toFixed(4))
        : evaluation.rawProbability,
      lastSeenAt: snapshot.marketDataUpdatedAt,
    });
    // Gamma's outcome price is a current quote for the selected token. It is
    // especially important after a YES/NO preference flip, when the old price
    // and share count belong to the opposite token.
    const repriced = repriceEvaluationForSelectedMarketQuote(next, snapshot.marketProbability, nextAiProbability);
    return recordEvaluationUpdate(evaluation, repriced, "polymarket-market-scan", snapshot.marketDataUpdatedAt);
  });
}

async function loadFocusedEvaluationMarkets(state) {
  let market = EVALUATION_MARKET_SLUG ? await fetchMarketBySlug(EVALUATION_MARKET_SLUG) : null;
  if (!market && EVALUATION_TOKEN_ID) {
    const stored = (state.evaluations || []).find((item) => String(item.tokenId || "") === EVALUATION_TOKEN_ID);
    if (stored?.slug) market = await fetchMarketBySlug(stored.slug);
  }
  if (!market) {
    throw new Error("manual evaluation market was not found on Polymarket");
  }
  return [market];
}

function marketHasNewOutcome(market, knownEvaluationKeys, knownBinaryMarketKeys = new Set()) {
  const binaryKey = binaryMarketKeyFromMarket(market);
  if (binaryKey) return !knownBinaryMarketKeys.has(binaryKey);
  return parseJsonField(market.clobTokenIds).some((tokenId) => tokenId && !knownEvaluationKeys.has(`token:${tokenId}`));
}

// What separates the two kinds is the shape of the *event*, not the shape of one market.
//
// Reported: the app had this backwards. Yes/No is any two-sided either-or -- one team beats
// the other, the total lands over or under, a plain proposition holds or does not -- and a
// football result that can be home, draw or away does not stop being two-sided, because it
// is still one fixture between two sides rather than a field of contenders. Multi-outcome
// is a field of mutually exclusive alternatives of which exactly one can win: an election,
// an award, a correct-score set. Every candidate in an election has its own Yes/No book,
// which is precisely why counting outcomes on a single market cannot tell them apart --
// measured on 3000 resolved rows, every single one had outcomeCount 2.
//
// So multi-outcome is the case that has to be positively recognised, and everything else is
// two-sided. The old rule did the opposite: it fell through to "multi", and treated a bare
// "winner" or a "who" as proof of a field. That made 1656 of 1688 over/under rows and 1396
// of 1682 team-versus-team rows multi-outcome, which is how a "Multi-outcome" statistics
// row came to be mostly football totals.

// A bracket set is a field too: "280-299 tweets", "400-419", "500+" are mutually exclusive
// ranges of one quantity, and exactly one of them happens. Measured on the reported skips,
// these were the single biggest source of correlation blocking -- one holding on "400-419"
// blocked "280-299", "420-439" and "500+" at once -- and every one of them was being called
// two-sided, because the question opens with "Will".
//
// Tested against the question alone and never the slug, and the lookarounds matter: a slug
// like nba-2026-08-21-spread and a question like "Will Arsenal FC win on 2026-08-21?" both
// contain "08-21", which is a date and not a range. Requiring that neither side touches
// another digit or dash rules those out while keeping "280-299".
const BRACKET_RANGE_QUESTION = /(?<![\d-])\d{1,3}\s?-\s?\d{1,3}(?![\d-])|(?<![\d-])\d{1,4}\+/;

// A field of alternatives: exactly one member can win, each is quoted separately.
const MULTI_OUTCOME_FIELD = new RegExp([
  "(exact|correct)[-\\s]?score",
  "\\belections?\\b", "\\bprimary\\b", "\\bcaucus\\b", "\\bballot\\b", "\\breferend",
  "\\bnominee\\b", "\\bnomination\\b", "\\baward\\b", "\\boscars?\\b", "\\bgrammys?\\b",
  "\\bnobel\\b", "\\bballon\\b", "\\bmvp\\b",
  "group[-\\s]winner", "\\btop[-\\s]scorer\\b", "\\boutright\\b", "winner[-\\s]of\\b",
  "\\bnext\\s+(president|prime\\s+minister|pope|chancellor|leader|ceo)\\b",
].join("|"), "i");

// Two sides set against each other. A fixture, a handicap, a spread or a total is an
// either-or however its outcome happens to be labelled.
const TWO_SIDED_EVENT = new RegExp([
  "\\bvs\\.?\\b", "\\bv\\.\\b", "\\s@\\s",
  "\\bhandicap\\b", "\\bspread\\b", "\\bmoneyline\\b", "\\bpuck\\s?line\\b", "\\brun\\s?line\\b",
  "over\\s?/\\s?under", "\\bo\\s?/\\s?u\\b",
].join("|"), "i");

// Labels that name one side of a pair, so the market is two-sided by construction.
const TWO_SIDED_OUTCOMES = new Set([
  "yes", "no", "over", "under", "up", "down", "even", "odd", "home", "away", "draw", "tie",
]);

function reportMarketType(item) {
  const question = String(item?.question || "");
  const slug = String(item?.eventSlug || item?.slug || "");
  const haystack = `${slug} ${question}`;
  const outcome = String(item?.outcome || "").trim().toLowerCase();
  const outcomeCount = Number(item?.outcomeCount);

  // A field of alternatives, whatever one member's book looks like. First, because an
  // election candidate and a correct-score line are both quoted Yes/No.
  if (MULTI_OUTCOME_FIELD.test(haystack)) return "multi";
  if (BRACKET_RANGE_QUESTION.test(question)) return "multi";
  // Two named sides settle it before any question-word guess: in "Team Spirit vs Team
  // Liquid - Game 2 Winner", "winner" means one of these two and nothing else.
  if (TWO_SIDED_EVENT.test(haystack)) return "binary";
  if (TWO_SIDED_OUTCOMES.has(outcome)) return "binary";
  // Only now can more than two outcomes mean a field. Deliberately after the two-sided
  // tests: a home/draw/away result carries three outcomes and is still one fixture.
  if (Number.isFinite(outcomeCount) && outcomeCount > 2) return "multi";
  // One entity named against a competition instead of an opponent.
  if (/^(which|who|what|how many)\b/i.test(question)) return "multi";
  if (/\bwins?\b[^?]*\b(cup|league|championship|title|tournament|final|open|series|medal|division|conference|playoffs?)\b/i.test(question)) {
    return "multi";
  }
  // A plain proposition about one thing happening or not.
  if (/^(will|is|are|can|does|do|did|has|have|was|were)\b/i.test(question)) return "binary";
  // Left over: a single named outcome with no opponent and none of the pair vocabulary is
  // one member of a field. A Yes/No label with none of the above is still a proposition.
  return outcomeKind(item?.outcome) === "OUTCOME" ? "multi" : "binary";
}

function reportPolymarketProbability(item) {
  const value = Number(item?.marketProbability ?? item?.entryPrice ?? item?.marketPrice ?? item?.currentPrice);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
}

function reportProbability(item, source) {
  const ai = Number(item?.aiProbability);
  const poly = reportPolymarketProbability(item);
  if (source === "ai") return Number.isFinite(ai) ? ai : null;
  if (source === "polymarket") return poly;
  if (Number.isFinite(ai) && Number.isFinite(poly)) return (ai + poly) / 2;
  return null;
}

// The one price a scraped row is counted at, everywhere. The statistics simulate entering
// at the first live quote and holding to resolution, so that quote is what a row's tag
// bucket, its ROI and the list behind the link all have to agree on.
//
// Reported: the trade count in Tag performance does not match the number of rows its own
// link shows. It could not. This used `?? ` over three fields, the list used the current
// price falling back to lastLiveMarketProbability, and firstObservationMetadata used a
// fourth order again -- so a market first seen at 0.85 and last quoted at 0.55 sat in the
// >=60 bucket and was filtered out of the list at the same threshold. Now there is one
// order, and it is firstLiveProbability's: a settlement print of 0 or 1 is not a quote,
// so any genuinely live number on the row beats it, whichever field it sits in.
function scrapedSimulationProbability(item) {
  return firstLiveProbability(
    item?.firstMarketProbability,
    item?.lastLiveMarketProbability,
    item?.marketProbability,
    item?.marketPrice,
  );
}

function scrapedSimulationDays(item) {
  const value = Number(item?.firstDaysToResolution ?? item?.daysToResolution);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// Risk labels/keys are namespaced dedup identifiers for one specific market, event,
// fixture or pairing -- "market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5" and
// the like. They are what the overlap check needs, but as report rows they are noise:
// each one groups a single opportunity, so it can never carry a comparable sample.
// Only the real taxonomy (sports, esports, politics, geopolitics, crypto, ...) belongs
// in this table, so anything wearing a risk namespace is dropped.
const RISK_NAMESPACE_TAG = /^(market|event|team|match|topic|entity)\s*:/i;
// A slug carrying a calendar date is one fixture, not a category.
const DATED_FIXTURE_SLUG_TAG = /-(?:19|20)\d{2}-\d{2}-\d{2}(?:-|$)/;

function isPerFixtureLabel(value) {
  const text = String(value || "");
  return RISK_NAMESPACE_TAG.test(text) || DATED_FIXTURE_SLUG_TAG.test(text);
}

function scrapedSimulationTaxonomy(item, firstField, currentField) {
  const first = Array.isArray(item?.[firstField]) ? item[firstField] : [];
  const current = Array.isArray(item?.[currentField]) ? item[currentField] : [];
  // Scrape-time taxonomy wins because this simulation evaluates the opportunity as it
  // first appeared. Older rows do not have the immutable field, so the current explicit
  // Gamma relation remains a compatible fallback.
  const sources = first.length ? [first] : [current];
  const seen = new Set();
  const labels = [];
  for (const source of sources) {
    for (const raw of source) {
      // Gamma returns tags both as plain strings and as {label,slug} objects.
      const text = String(
        raw && typeof raw === "object" ? (raw.slug || raw.label || raw.name || "") : (raw ?? ""),
      ).trim().toLowerCase();
      if (!text || text.length > 60) continue;
      // Legacy rows stored risk labels in `tags` too, and a raw per-fixture slug is
      // just as useless as a namespaced one: it groups exactly one opportunity.
      if (isPerFixtureLabel(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      labels.push(text);
      if (labels.length >= SCRAPED_SIMULATION_TAGS_PER_TRADE) return labels;
    }
  }
  return labels;
}

function scrapedSimulationCategories(item) {
  return scrapedSimulationTaxonomy(item, "firstPolymarketCategories", "polymarketCategories");
}

function scrapedSimulationTags(item) {
  return scrapedSimulationTaxonomy(item, "firstPolymarketTags", "polymarketTags");
}

// The report measures volume at resolution for settled markets, rather than a quote
// from discovery that could be materially older. Earlier archive rows have no second
// snapshot, so they deliberately fall back to their first scraped volume.
function scrapedSimulationVolumeUsdc(item = {}) {
  const resolvedCandidates = scrapedSimulationOutcome(item) != null
    ? [item.resolvedVolumeUsdc, item.resolvedVolume24hr]
    : [];
  for (const candidate of [...resolvedCandidates,
    item.firstVolumeUsdc,
    item.volumeUsdc,
    item.firstVolume24hr,
    item.volume24hr,
    item.firstLiquidity,
    item.liquidity,
  ]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

// Won, lost, or neither. A contract settles to 1 or 0; anything else is not a settlement.
//
// Reported: rows in the Resolved view reading "Final 50.0%", which is what a voided market
// looks like -- a sports prop on a game that was never played, refunded at 0.5 a side. Those
// were every one of them counted as a full win, because `value >= 0.5 ? 1 : 0` puts the void
// exactly on the winning edge. At a 5 USDC stake and a 0.55 entry that books roughly +80%
// of pure fiction per row, and it books it as accuracy too.
//
// The band is not invented here. The dashboard has always decided this same question the
// same way: closedTradeWon() and finalOutcomeCell() both read >= 0.995 as a win, <= 0.005 as
// a loss, and everything between as no result. The bot was the one place using a different
// rule, and it was the one place feeding the statistics tabs.
//
// Measured over the 3,000 most recent resolved rows: 2,929 settled at exactly 0 or 1, 71 at
// exactly 0.5, and not one row anywhere in between. So this drops the voids and reclassifies
// nothing else.
function scrapedSimulationOutcome(item) {
  const value = finalOutcomePriceValue(item?.finalOutcomePrice);
  if (value == null) return null;
  if (value >= 0.995) return 1;
  if (value <= 0.005) return 0;
  return null;
}

function scrapedSimulationTrade(item) {
  const entry = scrapedSimulationProbability(item);
  if (!Number.isFinite(entry)) return null;
  const stake = Math.max(0, SCRAPED_SIMULATION_STAKE_USDC);
  const shares = stake / entry;
  const feeRate = Math.max(0, Number(item?.firstFeeRate ?? item?.feeRate) || 0);
  const fee = takerFeeForFills([{ price: entry, size: shares }], feeRate);
  const total = stake + fee;
  const outcome = scrapedSimulationOutcome(item);
  const pnl = outcome == null ? null : (outcome ? shares - total : -total);
  return {
    item,
    entry,
    stake,
    shares,
    fee,
    total,
    outcome,
    pnl: Number.isFinite(pnl) ? Number(pnl.toFixed(4)) : null,
    categories: scrapedSimulationCategories(item),
    tags: scrapedSimulationTags(item),
    marketType: reportMarketType(item),
    days: scrapedSimulationDays(item),
    volumeUsdc: scrapedSimulationVolumeUsdc(item),
    firstObservedAt: item.firstObservedAt || item.observedAt || null,
  };
}

function summarizeScrapedSimulationRows(rows) {
  const resolved = rows.filter((row) => row.outcome != null);
  const wins = resolved.filter((row) => row.outcome === 1).length;
  const resolvedCost = resolved.reduce((sum, row) => sum + row.total, 0);
  const deployedCost = rows.reduce((sum, row) => sum + row.total, 0);
  const pnl = resolved.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const avgProbability = average(rows.map((row) => row.entry));
  const avgVolumeUsdc = average(rows.map((row) => row.volumeUsdc).filter(Number.isFinite));
  const avgDays = average(rows.map((row) => row.days).filter(Number.isFinite));
  const observationTimes = resolved
    .map((row) => Date.parse(row.firstObservedAt || row.item?.firstObservedAt || row.item?.observedAt || ""))
    .filter(Number.isFinite);
  const resolutionTimes = resolved
    .map((row) => Date.parse(row.item?.resolvedAt || row.item?.endDate || ""))
    .filter(Number.isFinite);
  // P/L p.a. describes the result the historical sample produced over calendar time,
  // not a fictional sequence where every trade is reinvested after its own average
  // hold. The former is comparable across a 1,300-row tag and a small category;
  // the latter is what caused the misleading multi-thousand-percent values.
  const sampleStartedAt = observationTimes.length ? Math.min(...observationTimes) : null;
  const sampleResolvedAt = resolutionTimes.length ? Math.max(...resolutionTimes) : null;
  const sampleDays = sampleStartedAt != null && sampleResolvedAt != null && sampleResolvedAt >= sampleStartedAt
    ? Math.max(MIN_ANNUALIZATION_DAYS, (sampleResolvedAt - sampleStartedAt) / (24 * 60 * 60 * 1000))
    : null;
  // A few older retained observations predate `firstObservedAt`. Their p.a. column
  // remains useful, but is explicitly a fallback based on the measured holding time;
  // every newly scraped row uses the true calendar sample window above.
  const performanceWindowDays = sampleDays ?? (Number.isFinite(avgDays) ? annualizationDays(avgDays) : null);
  // Net yield per trade at the simulated stake: what one win pays on what it cost.
  const avgNetYield = average(rows
    .map((row) => (row.total > 0 ? (row.shares - row.total) / row.total : null))
    .filter(Number.isFinite));
  const roi = resolvedCost > 0 ? pnl / resolvedCost : null;
  // A group with no start/end window cannot report an annualized result at all.
  const annualizedRoi = roi == null || !Number.isFinite(performanceWindowDays)
    ? null
    : annualizeReturn(roi, performanceWindowDays);
  // A total P/L grows with the number of observations, so it cannot compare two
  // parameter rules fairly. This is the annualized net dollar result of one fixed
  // simulation slot (5 USDC stake), based on the rule's average realized P/L and
  // average time between entry and resolution.
  const pnlPerTradeUsdc = resolved.length ? pnl / resolved.length : null;
  const annualizedPnlPerTradeUsdc = pnlPerTradeUsdc == null || !Number.isFinite(performanceWindowDays)
    ? null
    : annualizeReturn(pnlPerTradeUsdc, performanceWindowDays);
  return {
    trades: rows.length,
    resolved: resolved.length,
    pending: rows.length - resolved.length,
    wins,
    losses: resolved.length - wins,
    stakeUsdc: Number(deployedCost.toFixed(4)),
    resolvedStakeUsdc: Number(resolvedCost.toFixed(4)),
    pnlUsdc: Number(pnl.toFixed(4)),
    roi: roi == null ? null : Number(roi.toFixed(4)),
    annualizedRoi: annualizedRoi == null ? null : Number(annualizedRoi.toFixed(4)),
    pnlPerTradeUsdc: pnlPerTradeUsdc == null ? null : Number(pnlPerTradeUsdc.toFixed(4)),
    annualizedPnlPerTradeUsdc: annualizedPnlPerTradeUsdc == null
      ? null
      : Number(annualizedPnlPerTradeUsdc.toFixed(4)),
    winRate: resolved.length ? Number((wins / resolved.length).toFixed(4)) : null,
    avgProbability: avgProbability == null ? null : Number(avgProbability.toFixed(4)),
    avgVolumeUsdc: avgVolumeUsdc == null ? null : Number(avgVolumeUsdc.toFixed(2)),
    avgDaysToResolution: avgDays == null ? null : Number(avgDays.toFixed(3)),
    sampleDays: sampleDays == null ? null : Number(sampleDays.toFixed(3)),
    performanceWindowDays: performanceWindowDays == null ? null : Number(performanceWindowDays.toFixed(3)),
    sampleStartedAt: sampleStartedAt == null ? null : new Date(sampleStartedAt).toISOString(),
    avgNetYield: avgNetYield == null ? null : Number(avgNetYield.toFixed(4)),
    // A category that has not resolved anything for weeks should be visibly stale
    // rather than quietly ranked next to a current one.
    lastResolvedAt: resolutionTimes.length ? new Date(Math.max(...resolutionTimes)).toISOString() : null,
  };
}

function scrapedSimulationMatchesRule(trade, { marketType = "all", threshold = 0, maxResolutionDays = null } = {}) {
  return (marketType === "all" || trade.marketType === marketType)
    && trade.entry >= threshold
    && (maxResolutionDays == null || trade.days == null || trade.days <= maxResolutionDays);
}

function scrapedSimulationParameterRows(trades, openTrades = []) {
  const rows = [];
  for (const marketType of ["all", "binary", "multi"]) {
    for (const threshold of REPORT_THRESHOLDS) {
      for (const maxResolutionDays of SCRAPED_SIMULATION_MAX_DAYS) {
        const criteria = { marketType, threshold, maxResolutionDays };
        const selected = trades.filter((trade) => scrapedSimulationMatchesRule(trade, criteria));
        rows.push({
          probabilitySource: "polymarket",
          marketType,
          threshold,
          maxResolutionDays,
          openCount: openTrades.filter((trade) => scrapedSimulationMatchesRule(trade, criteria)).length,
          ...summarizeScrapedSimulationRows(selected),
        });
      }
    }
  }
  return rows;
}

function scrapedSimulationTaxonomyRows(trades, openTrades, field, kind) {
  const groups = new Map();
  const add = (label, trade, { open = false } = {}) => {
    const key = String(label || "").trim().toLowerCase();
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { kind, label: key, trades: [], openTrades: [] });
    if (open) groups.get(key).openTrades.push(trade);
    else groups.get(key).trades.push(trade);
  };
  const addTradeToGroups = (trade, options = {}) => {
    const labels = Array.isArray(trade[field]) ? trade[field] : [];
    // A missing Gamma relation must not silently remove a settled market from the
    // taxonomy report. Keep it distinct from an actual Polymarket category or tag
    // instead of guessing from an unrelated risk label.
    if (!labels.length) {
      add(kind === "category" ? "uncategorized" : "untagged", trade, options);
      return;
    }
    for (const label of labels) add(label, trade, options);
  };
  for (const trade of trades) addTradeToGroups(trade);
  for (const trade of openTrades) addTradeToGroups(trade, { open: true });
  const rows = [...groups.values()]
    .map(({ trades: groupTrades, openTrades: groupOpenTrades, ...group }) => {
      const row = {
        ...group,
        openCount: groupOpenTrades.length,
        ...summarizeScrapedSimulationRows(groupTrades),
      };
      // Keep the stored representation compact: the UI expands these summaries
      // into one row per tag/probability threshold only when Tag performance is open.
      if (kind === "tag") {
        row.minimumProbabilitySummaries = TAG_PERFORMANCE_THRESHOLDS.map((minimumProbability) => ({
          minimumProbability,
          openCount: groupOpenTrades.filter((trade) => trade.entry >= minimumProbability).length,
          ...summarizeScrapedSimulationRows(groupTrades.filter((trade) => trade.entry >= minimumProbability)),
        }));
      }
      return row;
    })
    // Rank by evidence first: a group with one resolved trade is noise next to one
    // with fifty, whatever its ROI looks like.
    .sort((a, b) => (b.resolved - a.resolved)
      || (b.trades - a.trades)
      || (b.openCount - a.openCount)
      || a.label.localeCompare(b.label));
  // This report lives in the core state file, which every dashboard read decodes, so
  // the row count cannot be left to however many tags Polymarket happens to publish.
  return rows.slice(0, SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT);
}

function scrapedSimulationTaxonomyCoverage(trades, field) {
  const classifiedTrades = trades.filter((trade) => (
    Array.isArray(trade[field]) && trade[field].length > 0
  )).length;
  return {
    totalTrades: trades.length,
    classifiedTrades,
    unclassifiedTrades: trades.length - classifiedTrades,
  };
}

function buildCalculationReport(state) {
  const generatedAt = state.generatedAt || nowIso();
  const observedTrades = (Array.isArray(state.marketObservations) ? state.marketObservations : [])
    .map(withFirstObservationMetadata)
    .map(scrapedSimulationTrade)
    .filter(Boolean);
  // This is a performance report, not an inventory of live opportunities. Pending
  // markets have no outcome, so including them in trade counts or averages dilutes
  // every parameter combination with data that cannot validate the strategy yet.
  const trades = observedTrades.filter((trade) => trade.outcome != null);
  // The new count columns are an inventory of genuinely tradable opportunities, not
  // merely unresolved records waiting for settlement. Pending/closed observations
  // cannot be opened and must therefore stay outside the deep links.
  const openTrades = observedTrades.filter((trade) => (
    trade.outcome == null
    && !observationIsResolved(trade.item)
    && trade.item?.marketClosed !== true
    && trade.item?.acceptingOrders !== false
  ));
  return {
    id: `calculation-report-${generatedAt}`,
    generatedAt,
    taxonomyVersion: 5,
    simulationType: "fresh_scraped_opportunities",
    observedSampleSize: observedTrades.length,
    sampleSize: trades.length,
    resolvedSampleSize: trades.length,
    stakeUsdc: Number(SCRAPED_SIMULATION_STAKE_USDC.toFixed(4)),
    resolvedBinaryCount: trades.filter((trade) => trade.marketType === "binary").length,
    resolvedMultiCount: trades.filter((trade) => trade.marketType === "multi").length,
    sourceNotes: {
      probability: "Polymarket probability captured on the first scraped observation; no AI analysis or portfolio filter is used.",
      execution: `Each fresh scraped opportunity is simulated as an immediate market position with a fixed ${SCRAPED_SIMULATION_STAKE_USDC.toFixed(2)} USDC stake and the stored taker fee schedule.`,
      resolution: "Only opportunities with a final Polymarket resolution price are included in performance statistics.",
    },
    openSampleSize: openTrades.length,
    parameterSummaries: scrapedSimulationParameterRows(trades, openTrades),
    categorySummaries: scrapedSimulationTaxonomyRows(trades, openTrades, "categories", "category"),
    tagSummaries: scrapedSimulationTaxonomyRows(trades, openTrades, "tags", "tag"),
    taxonomyCoverage: {
      category: scrapedSimulationTaxonomyCoverage(trades, "categories"),
      tag: scrapedSimulationTaxonomyCoverage(trades, "tags"),
    },
    examples: trades.slice(0, 80).map((trade) => {
      const item = trade.item || {};
      const firstVolume = Number(item.firstVolumeUsdc ?? item.volumeUsdc ?? item.firstVolume24hr ?? item.volume24hr);
      const resolvedVolume = Number(item.resolvedVolumeUsdc ?? item.resolvedVolume24hr);
      return {
        id: item.id,
        marketType: trade.marketType,
        categories: trade.categories,
        tags: trade.tags,
        question: item.question,
        selectedOutcome: item.firstOutcome || item.outcome,
        url: `https://polymarket.com/event/${item.eventSlug || item.slug || ""}`,
        firstObservedAt: trade.firstObservedAt,
        firstProbability: trade.entry,
        firstVolumeUsdc: Number.isFinite(firstVolume) ? Number(firstVolume.toFixed(2)) : null,
        resolvedVolumeUsdc: Number.isFinite(resolvedVolume) ? Number(resolvedVolume.toFixed(2)) : null,
        volumeUsdc: trade.volumeUsdc,
        daysToResolution: trade.days,
        finalOutcomePrice: item.finalOutcomePrice ?? null,
        resolvedOutcome: trade.outcome,
        pnlUsdc: trade.pnl,
      };
    }),
  };
}

// Whether this process is holding the resolved archive the report is measured from.
//
// The manifest of the state that was read states how many resolved rows exist. If it says
// tens of thousands and this process is holding none, the archive was carried over rather
// than fetched, and a report built from what is in memory would describe the live half of
// the catalogue only -- every settled market missing, so no sample, no accuracy, no P/L.
//
// A state that never declared an archive (a fresh one, a local fixture, a test) has nothing
// to be missing and is holding everything there is.
function stateHoldsResolvedArchive(state) {
  const declared = Number(
    previousStateSegmentManifest?.[RESOLVED_OBSERVATION_SEGMENT]?.counts?.[RESOLVED_OBSERVATION_TRANSPORT_FIELD],
  );
  if (!Number.isFinite(declared) || declared <= 0) return true;
  const observations = Array.isArray(state.marketObservations) ? state.marketObservations : [];
  return observations.some(observationIsResolved);
}

// The report is rebuilt only by a pass that has the data it measures.
//
// Reported: the statistics tables went blank -- every parameter row reading TRADES 0 and
// ACCURACY "-" beside an OPEN NOW of 3,851. The cause is a pass rebuilding this report while
// holding only the active catalogue, which produces a structurally complete report whose
// resolved sample is empty, and publishing it over a good one.
//
// Guarding the pass mode was not enough. Of the five places that rebuild this, the mode
// guard covered one, and inferring which of the others had done it from overlapping run
// timestamps did not converge. The mode was only ever a proxy for the real precondition,
// which is a question about the data: does this process actually have the resolved rows?
// Asking that here covers every caller at once, including any added later.
//
// Keeping the previous report is exactly right when the answer is no. A pass that is not
// holding the archive cannot have changed it either, so the report it would compute is not
// a newer measurement -- it is the same measurement taken with most of the data missing.
function updateCalculationReport(state) {
  if (!stateHoldsResolvedArchive(state)) {
    console.warn(
      "Keeping the stored calculation report: this pass is not holding the resolved archive, "
      + "so rebuilding it would publish an empty sample over a complete one.",
    );
    return state.latestCalculationReport || null;
  }
  const report = buildCalculationReport(state);
  state.calculationReports = mergeUniqueById([report, ...(state.calculationReports || [])], (item) => item.id || item.generatedAt || "", CALCULATION_REPORT_HISTORY_LIMIT)
    .sort((a, b) => (Date.parse(b.generatedAt || "") || 0) - (Date.parse(a.generatedAt || "") || 0));
  state.latestCalculationReport = state.calculationReports[0] || report;
  return report;
}

function updatePaperPortfolio(portfolioState) {
  const realizedPnl = portfolioState.trades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
  const openPnl = portfolioState.trades
    .filter((trade) => OPEN_STATUSES.has(String(trade.status || "").toUpperCase()))
    .reduce((sum, trade) => sum + Number(trade.unrealizedPnlUsdc || 0), 0);
  const openRiskValue = openRisk(portfolioState.trades);
  const adjustedAtTime = Date.parse(portfolioState.capitalAdjustmentAt || "");
  // A one-time manual correction to the account's capital baseline, applied by
  // adjustPaperPortfolioCapital() -- never by ordinary trading. Every other portfolio
  // carries 0 here, so PORTFOLIO_USDC + 0 reproduces the prior formula exactly.
  const capitalAdjustment = Number(portfolioState.capitalAdjustmentUsdc) || 0;
  const baseline = PORTFOLIO_USDC + capitalAdjustment;
  const equity = baseline + realizedPnl + openPnl;

  // Reported: High reward showed equity 109.46 against a Total P/L of -37.92. Those two
  // cannot both describe the same account, and the P/L was the wrong one.
  //
  // A rebase sets equity to a target outright (adjustPaperPortfolioCapital), so it is a
  // reset of a *stock*. "Since the reset" was measured as a *flow* instead: the realized
  // P/L of every trade that resolved after the moment, plus the current open P/L, over
  // the all-time baseline. Both halves were wrong. A position already open and under
  // water at the reset had that loss absorbed into the equity the reset handed it; when
  // it later resolved, its full realized loss was charged a second time -- which is how
  // -33.31 appeared while the true all-time realized P/L was only about -10. And the
  // percentage divided a since-the-reset figure by the pre-reset baseline.
  //
  // Measuring the stock cannot double count: what the account has done since the reset
  // is exactly how far its equity has moved from the equity the reset gave it. The
  // decomposition then follows from that total, so the three tiles still add up.
  // Recorded at the reset from that moment's own numbers. A portfolio rebased before they
  // were stored falls back to the documented target (PORTFOLIO_USDC), which is what every
  // rebase so far actually used, and to a zero open book -- an approximation only for
  // positions open across that single moment, and bounded by their size. A portfolio never
  // rebased measures "since" over its whole life, so its base is its own baseline, and the
  // formulas below then reduce to the all-time figures exactly.
  // numericOrNaN, not Number(): these are null until a reset records them, and Number(null)
  // is 0 -- which would read as "the reset handed this account zero equity".
  const equityAtAdjustment = numericOrNaN(portfolioState.capitalAdjustmentEquityUsdc);
  const openPnlAtAdjustment = numericOrNaN(portfolioState.capitalAdjustmentOpenPnlUsdc);
  // A recorded baseline of zero or less is not a baseline. A reset always puts equity on a
  // positive target, so zero can only be the Number(null) === 0 trap that an earlier pass
  // wrote into the published state -- and dividing by it made High reward report its whole
  // balance as profit since the reset (+$110.11 on equity of $110.11, at +0.0%). Guarding
  // the value, not just the write, is what heals a state that already carries the zero.
  const rebaseEquity = Number.isFinite(equityAtAdjustment) && equityAtAdjustment > 0
    ? equityAtAdjustment
    : (Number.isFinite(adjustedAtTime) ? PORTFOLIO_USDC : baseline);
  const rebaseOpenPnl = Number.isFinite(openPnlAtAdjustment) ? openPnlAtAdjustment : 0;
  const totalPnlSinceAdjustment = equity - rebaseEquity;
  const openPnlSinceAdjustment = openPnl - rebaseOpenPnl;
  const realizedPnlSinceAdjustment = totalPnlSinceAdjustment - openPnlSinceAdjustment;
  const sinceAdjustmentStats = {
    rebaseEquityUsdc: Number(rebaseEquity.toFixed(4)),
    realizedPnlSinceAdjustmentUsdc: Number(realizedPnlSinceAdjustment.toFixed(4)),
    realizedPnlSinceAdjustmentPct: pnlPercent(realizedPnlSinceAdjustment, rebaseEquity),
    openPnlSinceAdjustmentUsdc: Number(openPnlSinceAdjustment.toFixed(4)),
    openPnlSinceAdjustmentPct: pnlPercent(openPnlSinceAdjustment, rebaseEquity),
    totalPnlSinceAdjustmentUsdc: Number(totalPnlSinceAdjustment.toFixed(4)),
    totalPnlSinceAdjustmentPct: pnlPercent(totalPnlSinceAdjustment, rebaseEquity),
  };
  const portfolioMaxFraction = Number(
    portfolioState.maxFraction ?? portfolioState.portfolio?.maxFraction ?? MAX_FRACTION,
  );
  const configuredStakeUsdc = Number(portfolioState.stakeUsdc ?? portfolioState.portfolio?.stakeUsdc);
  const portfolioStakeUsdc = Number.isFinite(configuredStakeUsdc) && configuredStakeUsdc > 0
    ? configuredStakeUsdc
    : Math.max(0.01, baseline * portfolioMaxFraction);
  const freeCapital = Math.max(0, baseline + realizedPnl - openRiskValue);
  // Free capital counts every open row, resting limit orders included, because that is what
  // is currently allocated. The next order is sized against something different when the
  // portfolio rests limit orders -- an unfilled offer is not exposure and does not block it
  // -- so both figures are published. Showing only one of them is what would make the
  // dashboard and the run log contradict each other: "1.32 USDC available" beside an order
  // that was placed anyway.
  const restingLimitOrderCapital = waitingLimitOrderRisk(portfolioState.trades);
  const deployable = portfolioState.useLimitOrders
    ? freeCapital + restingLimitOrderCapital
    : freeCapital;
  portfolioState.portfolio = {
    ...(portfolioState.portfolio || {}),
    strategyId: portfolioState.id,
    strategyLabel: portfolioState.label,
    selectionMetric: portfolioState.selectionMetric,
    selectionOrder: portfolioState.selectionOrder,
    strategyDescription: portfolioState.description,
    initialUsdc: baseline,
    // Kept visible on the published row rather than only on the portfolio state, so a
    // dashboard reading this object directly can still explain why equity does not
    // equal PORTFOLIO_USDC + realized + open.
    capitalAdjustmentUsdc: Number(capitalAdjustment.toFixed(4)),
    capitalAdjustmentAt: portfolioState.capitalAdjustmentAt || null,
    // The fixed per-portfolio USDC stake is the source of truth. The legacy fraction is
    // kept for old configs only, not for resizing the next order as equity changes.
    stakeUsdc: Number(portfolioStakeUsdc.toFixed(2)),
    maxFraction: portfolioMaxFraction,
    maxStakeUsdc: Number(portfolioStakeUsdc.toFixed(2)),
    minProbability: Number(portfolioState.minProbability ?? MIN_PROBABILITY),
    minAnnualReturn: MIN_ANNUAL_RETURN,
    opportunityMinProbability: OPPORTUNITY_MIN_PROBABILITY,
    opportunityMinEdge: OPPORTUNITY_MIN_EDGE,
    opportunityMinAnnualReturn: OPPORTUNITY_MIN_ANNUAL_RETURN,
    maxResolutionDays: strategyMaxResolutionDays(portfolioState),
    minLiquidityUsdc: portfolioState.minLiquidityUsdc == null ? null : Number(portfolioState.minLiquidityUsdc),
    marketType: normalizePortfolioMarketType(portfolioState.marketType, portfolioState.requireMostProbableOutcome),
    requireMostProbableOutcome: Boolean(portfolioState.requireMostProbableOutcome),
    realizedPnlUsdc: Number(realizedPnl.toFixed(4)),
    realizedPnlPct: pnlPercent(realizedPnl, baseline),
    openPnlUsdc: Number(openPnl.toFixed(4)),
    openPnlPct: pnlPercent(openPnl, baseline),
    equityUsdc: Number(equity.toFixed(4)),
    totalPnlUsdc: Number((realizedPnl + openPnl).toFixed(4)),
    totalPnlPct: pnlPercent(realizedPnl + openPnl, baseline),
    // Display-only: equity, free capital and sizing must keep using the true, unfiltered
    // realizedPnl above -- these exist so a rebased portfolio's headline stats can read
    // "since the reset" without that filtering ever touching what the bot trades on.
    ...sinceAdjustmentStats,
    openRiskUsdc: Number(openRiskValue.toFixed(2)),
    // The two halves of that total, because they are not the same kind of commitment.
    // Capital in a filled position is exposure: it moves with the market and can be lost.
    // Capital behind a resting order is a reservation against an offer nobody has taken,
    // which is discarded intact if the event ends unfilled. One number for both hides
    // whether a portfolio is actually invested or merely queueing.
    positionRiskUsdc: Number(Math.max(0, openRiskValue - restingLimitOrderCapital).toFixed(2)),
    freeCapitalUsdc: Number(freeCapital.toFixed(2)),
    // What resting, unfilled orders are holding, and what the next order is actually sized
    // against. They differ by exactly that amount when this portfolio rests limit orders.
    restingLimitOrderUsdc: Number(restingLimitOrderCapital.toFixed(2)),
    deployableCapitalUsdc: Number(deployable.toFixed(2)),
  };
}

function updatePortfolio(state) {
  state.paperPortfolios ||= {};
  for (const strategy of Object.values(PAPER_STRATEGIES)) {
    state.paperPortfolios[strategy.id] ||= normalizePaperPortfolio(strategy, {});
    updatePaperPortfolio(state.paperPortfolios[strategy.id]);
  }
  syncLegacyPaperAliases(state);
}

function recordPortfolioRun(state, portfolioState, { evaluations = [], eligible = [], decision }) {
  const runAt = state.generatedAt;
  const portfolioEligibleCount = Number(decision.batchLog?.counts?.rankedEligible);
  const eligibleCount = Number.isFinite(portfolioEligibleCount) ? portfolioEligibleCount : eligible.length;
  portfolioState.lastDecision = {
    runAt,
    runSource: MANUAL_RUN_ONCE ? "MANUAL" : "AUTO",
    strategyId: portfolioState.id,
    strategyLabel: portfolioState.label,
    selectionMetric: portfolioState.selectionMetric,
    evaluatedCount: evaluations.length,
    eligibleCount,
    action: decision.action,
    reason: decision.reason,
    tradeId: decision.trade?.id || null,
    closedTradeId: decision.closedTrade?.id || null,
    rotationReview: decision.rotationReview || null,
    batchLog: decision.batchLog || null,
    availableCapitalUsdc: decision.available == null ? null : Number(Number(decision.available).toFixed(4)),
    requiredStakeUsdc: decision.requiredStake == null ? null : Number(Number(decision.requiredStake).toFixed(4)),
    insufficientCapital: Boolean(decision.insufficientCapital),
    selectedHorizonDays: decision.trade?.daysToResolution ?? null,
    riskSkippedCount: decision.skippedForRisk || 0,
    refreshOnly: REFRESH_ONLY,
    reportOnly,
    learningSampleSize: state.learningProfile.sampleSize,
    brierScore: state.learningProfile.brierScore,
    calibrationBias: state.learningProfile.calibrationBias,
  };
  const entry = {
    runAt,
    runSource: MANUAL_RUN_ONCE ? "MANUAL" : "AUTO",
    strategyId: portfolioState.id,
    strategyLabel: portfolioState.label,
    selectionMetric: portfolioState.selectionMetric,
    evaluatedCount: evaluations.length,
    eligibleCount,
    action: decision.action,
    reason: decision.reason,
    tradeId: decision.trade?.id || null,
    closedTradeId: decision.closedTrade?.id || null,
    rotationReview: decision.rotationReview || null,
    batchLog: decision.batchLog || null,
    availableCapitalUsdc: decision.available == null ? null : Number(Number(decision.available).toFixed(4)),
    requiredStakeUsdc: decision.requiredStake == null ? null : Number(Number(decision.requiredStake).toFixed(4)),
    insufficientCapital: Boolean(decision.insufficientCapital),
    riskSkippedCount: decision.skippedForRisk || 0,
    refreshOnly: REFRESH_ONLY,
    reportOnly,
    learningSampleSize: state.learningProfile.sampleSize,
    brierScore: state.learningProfile.brierScore,
  };
  portfolioState.runLog = [entry, ...portfolioState.runLog].slice(0, PORTFOLIO_RUN_LOG_LIMIT);
  syncLegacyPaperAliases(state);
  return entry;
}

function recordRun(state, { evaluations = [], eligible = [], decisions = [] }) {
  const newRunLogEntries = [];
  for (const decision of decisions) {
    const portfolioState = state.paperPortfolios?.[decision.strategyId] || state.paperPortfolios?.conservative;
    if (!portfolioState) continue;
    newRunLogEntries.push(recordPortfolioRun(state, portfolioState, { evaluations, eligible, decision }));
  }
  state.evaluationRunLog = [
    {
      id: `evaluation-run-${state.generatedAt}`,
      runAt: state.generatedAt,
      refreshOnly: REFRESH_ONLY,
      reportOnly,
      evaluatedCount: evaluations.length,
      eligibleCount: eligible.length,
      rejectedCount: evaluations.filter((item) => String(item.status || "").toUpperCase() === "REJECTED").length,
      errorCount: evaluations.filter((item) => String(item.status || "").toUpperCase() === "ERROR").length,
      statusCounts: evaluations.reduce((counts, item) => {
        const status = String(item.status || "UNKNOWN").toUpperCase();
        counts[status] = Number(counts[status] || 0) + 1;
        return counts;
      }, {}),
      decisions: decisions.map((decision) => ({
        strategyId: decision.strategyId,
        action: decision.action,
        reason: decision.reason,
        tradeId: decision.trade?.id || null,
        closedTradeId: decision.closedTrade?.id || null,
        rotationReview: decision.rotationReview || null,
        batchLog: decision.batchLog || null,
        availableCapitalUsdc: decision.available == null ? null : Number(Number(decision.available).toFixed(4)),
        requiredStakeUsdc: decision.requiredStake == null ? null : Number(Number(decision.requiredStake).toFixed(4)),
        insufficientCapital: Boolean(decision.insufficientCapital),
      })),
      events: evaluations.map((item) => ({
        id: item.id,
        evaluatedAt: item.evaluatedAt,
        evaluationResult: String(item.status || "").toUpperCase() === "ERROR" ? "ERROR" : "EVALUATED",
        portfolioFilterStatus: item.status,
        status: item.status,
        question: item.question,
        outcome: item.outcome,
        slug: item.slug,
        eventSlug: item.eventSlug,
        tokenId: item.tokenId,
        url: `https://polymarket.com/event/${item.eventSlug || item.slug || ""}`,
        aiProbability: item.aiProbability,
        rawProbability: item.rawProbability,
        marketPrice: item.marketPrice,
        annualizedReturn: item.annualizedReturn,
        expectedValueUsdc: item.expectedValueUsdc,
        netGainIfWinUsdc: item.netGainIfWinUsdc,
        riskReward: rewardRiskRatio(item),
        liquidity: item.liquidity,
        volume24hr: item.volume24hr,
        endDate: item.endDate,
        daysToResolution: item.daysToResolution,
        rejectReasons: item.rejectReasons,
        analysisSummary: item.analysisSummary,
        probabilityThesis: item.probabilityThesis,
        analysisModel: item.analysisModel,
        riskGroupLabels: item.riskGroupLabels,
      })),
    },
    ...(state.evaluationRunLog || []),
  ].slice(0, EVALUATION_RUN_LOG_LIMIT);
  return newRunLogEntries;
}

function updateEvaluationStats(state, { evaluations = [], retainedBefore = 0, retainedAfter = 0 } = {}) {
  const previousStats = state.evaluationStats || {};
  const previousTotal = Number(previousStats.totalRunEvaluatedCount);
  const loggedTotal = Array.isArray(state.evaluationRunLog)
    ? state.evaluationRunLog.reduce((total, run) => total + Number(run.evaluatedCount || 0), 0)
    : 0;
  const baselineTotal = Number.isFinite(previousTotal) ? previousTotal : loggedTotal;
  const retainedLimit = Number.isFinite(MAX_HISTORY) && MAX_HISTORY > 0 ? MAX_HISTORY : retainedAfter;

  state.evaluationStats = {
    ...previousStats,
    retainedLimit,
    retainedCount: retainedAfter,
    retainedBeforeMergeCount: retainedBefore,
    lastRunEvaluatedCount: evaluations.length,
    lastRunAt: state.generatedAt,
    totalRunEvaluatedCount: baselineTotal + evaluations.length,
    historyTrimmed: retainedLimit > 0 && retainedAfter >= retainedLimit,
    lastTrimmedCount: Math.max(0, retainedBefore - retainedAfter),
    aiUsage: state.aiUsage || null,
  };
}

async function executeManualPaperRunFromStoredCandidates(state, strategiesForRun, options = {}) {
  const source = options.source || "manual";
  const evaluations = [];
  const eligible = [];
  const decisions = [];

  for (const strategy of strategiesForRun) {
    const portfolioState = state.paperPortfolios?.[strategy.id];
    if (!portfolioState) continue;

    const shortlist = timedSync("candidateShortlist", () => storedExecutionShortlist(state, strategy));
    const selectedForRevalidation = shortlist.rows.slice(0, MAX_EVALUATIONS_PER_RUN);
    // The gap between "this is the candidate" and "the order is in" is exactly this call.
    const revalidated = await timed("candidateRevalidation", () =>
      revalidateStoredExecutionShortlist(selectedForRevalidation, state.learningProfile, state));
    const rankedEligible = sortEligibleForStrategy(
      revalidated.filter((item) => portfolioFilterResult(item, strategy).eligible),
      strategy,
    );
    const revalidatedRejectedSample = revalidated
      .map((item) => {
        const result = portfolioFilterResult(item, strategy);
        if (result.eligible) return null;
        return {
          ...tradeBatchCandidateSummary(item),
          portfolioRejectReasons: result.reasons,
        };
      })
      .filter(Boolean)
      .slice(0, 30);

    const prevalidationFilter = {
      ...shortlist.diagnostics,
      source: source === "after_scrape" ? "stored_execution_candidates_after_scrape" : "stored_execution_candidates",
      selectedForRevalidation: selectedForRevalidation.length,
      revalidatedCount: revalidated.length,
      revalidatedPortfolioEligible: rankedEligible.length,
      revalidatedRejected: Math.max(0, revalidated.length - rankedEligible.length),
      skippedByScanLimit: Math.max(0, shortlist.rows.length - selectedForRevalidation.length),
      skippedByRevalidationLimit: Math.max(0, shortlist.rows.length - selectedForRevalidation.length),
      revalidatedCandidates: revalidated.slice(0, 30).map(tradeBatchCandidateSummary).filter(Boolean),
      revalidatedRejectedSample,
    };

    const decision = maybeOpenScheduledTrade(portfolioState, rankedEligible, strategy, revalidated, {
      prevalidationFilter,
      diversificationDiagnostics: {
        source: source === "after_scrape" ? "stored_execution_candidates_after_scrape" : "stored_execution_candidates",
        note: source === "after_scrape"
          ? "Post-scrape execution revalidated the current portfolio shortlist only; no AI analysis or unrelated market scan was used."
          : "Manual paper run revalidated the current portfolio execution shortlist only; no unrelated fresh market scan was used.",
      },
    });
    decisions.push(decision);
    evaluations.push(...revalidated);
    eligible.push(...revalidated.filter((item) => String(item.status || "").toUpperCase() === "ELIGIBLE"));
  }

  state.generatedAt = nowIso();
  updatePortfolio(state);
  const mergedEvaluations = await refreshStoredEvaluationResolutionStatuses(expirePastEvaluations(mergeEvaluationLists(evaluations, state.evaluations)));
  const retainedBefore = new Set([...(state.evaluations || []), ...evaluations].map(evaluationKey).filter(Boolean)).size;
  state.evaluations = mergedEvaluations.map(ensureEvaluationErrorMetadata);
  timedSync("calculationReport", () => updateCalculationReport(state));
  updateEvaluationStats(state, { evaluations, retainedBefore, retainedAfter: state.evaluations.length });
  const newRunLogEntries = recordRun(state, { evaluations, eligible, decisions });
  await writeState(state);
  await writePortfolioRunLogEntries(newRunLogEntries);
  console.log(JSON.stringify({
    generatedAt: state.generatedAt,
    source: source === "after_scrape" ? "stored_execution_candidates_after_scrape" : "stored_execution_candidates",
    decisions: Object.fromEntries(decisions.map((decision) => [decision.strategyId, {
      action: decision.action,
      reason: decision.reason,
      tradeId: decision.trade?.id || null,
      revalidatedCount: decision.batchLog?.prevalidationFilter?.revalidatedCount ?? null,
      revalidatedPortfolioEligible: decision.batchLog?.prevalidationFilter?.revalidatedPortfolioEligible ?? null,
    }])),
  }, null, 2));
}

async function writeState(state) {
  recordPassTimingOnState(state);
  await timed("writeState", async () => {
    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    // Normalize immediately before persistence. This protects the public state
    // file from accidental growth when a scan sees many valid markets while
    // retaining every market observation themselves.
    const persisted = normalizeState(state);
    const { core, segments } = splitStateIntoSegments(persisted);
    await Promise.all([
      writeFile(OUTPUT_PATH, `${JSON.stringify(core)}\n`, "utf8"),
      ...Object.entries(segments).map(([name, payload]) =>
        writeFile(stateSegmentPath(name), `${JSON.stringify(payload)}\n`, "utf8")),
    ]);
  });
}

function compactScanHistoryEntry(run) {
  if (!run || typeof run !== "object" || (!run.id && !run.runAt)) return null;
  const { audit, ...summary } = run;
  return summary;
}

async function writeScanHistoryEntry(run) {
  const entry = compactScanHistoryEntry(run);
  if (!entry) return;
  await mkdir(dirname(SCAN_HISTORY_ENTRY_PATH), { recursive: true });
  await writeFile(SCAN_HISTORY_ENTRY_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

// One line per portfolio that got a new run-log entry this cycle -- a single run can
// evaluate several portfolios at once, unlike the one-run-per-cycle scan history.
async function writePortfolioRunLogEntries(entries) {
  const lines = (entries || [])
    .filter((entry) => entry && entry.strategyId && entry.runAt)
    .map((entry) => JSON.stringify(entry));
  if (!lines.length) return;
  await mkdir(dirname(PORTFOLIO_RUN_LOG_ENTRY_PATH), { recursive: true });
  await writeFile(PORTFOLIO_RUN_LOG_ENTRY_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function writeScanErrorMarker(message) {
  const text = String(message || "").trim();
  if (!text) return;
  await mkdir(dirname(SCAN_ERROR_MARKER_PATH), { recursive: true });
  await writeFile(SCAN_ERROR_MARKER_PATH, `${text}\n`, "utf8");
}

async function run() {
  if (REQUIRE_GEMINI && !GEMINI_API_KEY && !EXECUTION_ONLY) {
    throw new Error("PAPER_REQUIRE_GEMINI is true, but GEMINI_API_KEY is not available. Check GitHub secret GEMINI_API_KEY_POLYMARKET and workflow secret access.");
  }
  console.log(JSON.stringify({
    aiProvider: GEMINI_API_KEY ? "gemini" : (OPENAI_API_KEY ? "openai" : "heuristic-only"),
    geminiConfigured: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_API_KEY ? GEMINI_MODEL : null,
    requireGemini: REQUIRE_GEMINI,
    aiAnalysisLimit: AI_ANALYSIS_LIMIT,
  }));
  await rm(SCAN_HISTORY_ENTRY_PATH, { force: true }).catch(() => {});
  await rm(SCAN_ERROR_MARKER_PATH, { force: true }).catch(() => {});
  await rm(PORTFOLIO_RUN_LOG_ENTRY_PATH, { force: true }).catch(() => {});
  const state = await timed("readState", () => readState());
  if (PAPER_RESET_PORTFOLIO) {
    if (!PAPER_STRATEGY_ID) {
      throw new Error("PAPER_RESET_PORTFOLIO requires a valid PAPER_STRATEGY_ID.");
    }
    const archive = archiveAndResetPaperPortfolio(state, PAPER_STRATEGY_ID);
    state.generatedAt = nowIso();
    state.aiUsage = aiUsageSnapshot(state);
    await writeState(state);
    console.log(JSON.stringify({
      action: "PAPER_PORTFOLIO_RESET",
      strategyId: PAPER_STRATEGY_ID,
      archiveId: archive.id,
      archivedAt: archive.archivedAt,
      initialUsdc: state.paperPortfolios[PAPER_STRATEGY_ID].portfolio.initialUsdc,
      trades: state.paperPortfolios[PAPER_STRATEGY_ID].trades.length,
      runLog: state.paperPortfolios[PAPER_STRATEGY_ID].runLog.length,
    }, null, 2));
    return;
  }
  if (PAPER_RESTORE_PORTFOLIO) {
    if (!PAPER_STRATEGY_ID) {
      throw new Error("PAPER_RESTORE_PORTFOLIO requires a valid PAPER_STRATEGY_ID.");
    }
    const result = restoreArchivedPaperPortfolio(state, PAPER_STRATEGY_ID);
    state.generatedAt = nowIso();
    state.aiUsage = aiUsageSnapshot(state);
    await writeState(state);
    console.log(JSON.stringify({
      action: "PAPER_PORTFOLIO_RESTORED",
      strategyId: PAPER_STRATEGY_ID,
      ...result,
      equityUsdc: state.paperPortfolios[PAPER_STRATEGY_ID].portfolio.equityUsdc,
      runLog: state.paperPortfolios[PAPER_STRATEGY_ID].runLog.length,
    }, null, 2));
    return;
  }
  if (PAPER_ADJUST_CAPITAL) {
    if (!PAPER_STRATEGY_ID) {
      throw new Error("PAPER_ADJUST_CAPITAL requires a valid PAPER_STRATEGY_ID.");
    }
    const result = adjustPaperPortfolioCapital(state, PAPER_STRATEGY_ID, PAPER_TARGET_EQUITY_USDC);
    state.generatedAt = nowIso();
    state.aiUsage = aiUsageSnapshot(state);
    await writeState(state);
    console.log(JSON.stringify({
      action: "PAPER_PORTFOLIO_CAPITAL_ADJUSTED",
      strategyId: PAPER_STRATEGY_ID,
      ...result,
      trades: state.paperPortfolios[PAPER_STRATEGY_ID].trades.length,
    }, null, 2));
    return;
  }
  if (PAPER_SET_CAPITAL_ADJUSTMENT_AT) {
    if (!PAPER_STRATEGY_ID) {
      throw new Error("PAPER_SET_CAPITAL_ADJUSTMENT_AT requires a valid PAPER_STRATEGY_ID.");
    }
    if (!PAPER_CAPITAL_ADJUSTMENT_AT_ISO) {
      throw new Error("PAPER_SET_CAPITAL_ADJUSTMENT_AT requires PAPER_CAPITAL_ADJUSTMENT_AT_ISO.");
    }
    const result = backfillCapitalAdjustmentAt(state, PAPER_STRATEGY_ID, PAPER_CAPITAL_ADJUSTMENT_AT_ISO);
    state.generatedAt = nowIso();
    state.aiUsage = aiUsageSnapshot(state);
    await writeState(state);
    console.log(JSON.stringify({
      action: "PAPER_PORTFOLIO_CAPITAL_ADJUSTMENT_AT_SET",
      strategyId: PAPER_STRATEGY_ID,
      ...result,
    }, null, 2));
    return;
  }
  if (SCHEDULED_CADENCE && !COMPACT_ONLY && !REFRESH_ONLY && !EXECUTION_ONLY && !EVALUATION_ONLY) {
    const cadence = resolveScheduledCadence(state);
    scanOnly = cadence.scanOnly;
    reportOnly = cadence.reportOnly;
    console.log(JSON.stringify({
      action: "SCHEDULED_CADENCE",
      resolvedStage: cadence.stage,
      reason: cadence.broughtForwardByCapital
        ? `scheduled tick resolved to full because ${cadence.capitalReadyPortfolios.join(", ")} can fund a trade now, ahead of the ${FULL_CADENCE_MINUTES}-minute cadence`
        : `scheduled tick resolved to ${cadence.stage} from the stored cadence instead of the cron expression`,
      lastFullAt: normalizeCadence(state.cadence).lastFullAt,
      lastReportAt: normalizeCadence(state.cadence).lastReportAt,
      fullAgeMinutes: Number.isFinite(cadence.fullAgeMinutes) ? Number(cadence.fullAgeMinutes.toFixed(1)) : null,
      fullCadenceMinutes: FULL_CADENCE_MINUTES,
      reportCadenceMinutes: REPORT_CADENCE_MINUTES,
      // Which portfolios are holding a fundable stake, so an idle one is visible even on a
      // tick that did not bring the pass forward.
      capitalReadyPortfolios: cadence.capitalReadyPortfolios || [],
      broughtForwardByCapital: Boolean(cadence.broughtForwardByCapital),
      idleCapitalFullPassMinMinutes: IDLE_CAPITAL_FULL_PASS_MIN_MINUTES,
    }));
  }
  const priorScanRunIds = new Set((state.marketScanHistory || [])
    .map((item) => String(item?.id || item?.runAt || ""))
    .filter(Boolean));
  syncLegacyPaperAliases(state);
  state.aiUsage = aiUsageSnapshot(state);
  // Expiry always runs -- it is what stops a finished market being offered as a candidate.
  // The resolution sync beside it is a different job: it walks up to 120 stored
  // evaluations, asking Polymarket what each one settled at, to keep the record complete.
  // An execution pass skips it for the reason EXECUTION_PASS documents.
  state.evaluations = (scanOnly || EXECUTION_PASS
    ? expirePastEvaluations(state.evaluations || [])
    : await timed("evaluationResolutionSync", () =>
      refreshStoredEvaluationResolutionStatuses(expirePastEvaluations(state.evaluations || []))))
    .map(normalizeAiPendingEvaluation)
    .map(ensureEvaluationErrorMetadata);
  state.marketObservations = (state.marketObservations || []).map(normalizeMarketObservationEconomics);
  if (COMPACT_ONLY) {
    state.generatedAt = nowIso();
    updatePortfolio(state);
    await writeState(state);
    console.log(JSON.stringify({
      action: "STATE_COMPACTED",
      reason: "Recovered the stored paper state without rescanning markets or changing trades.",
      evaluations: state.evaluations.length,
      marketObservations: state.marketObservations.length,
      scanHistory: state.marketScanHistory.length,
    }, null, 2));
    return;
  }
  // Repair records created before binary outcome flips rebuilt the full quote.
  // This runs even if the current market scan does not include that contract.
  state.evaluations = repairStaleBinarySideQuotes(state.evaluations);
  let scanFailure = "";
  // An execution pass reads the catalogue the scans maintain rather than rescraping it.
  // The after-scrape path always worked this way -- it runs because a scan has just
  // finished -- and a portfolio started from the dashboard now does too: the catalogue is
  // at most one scan interval old, and every candidate that reaches the order is requoted
  // live by revalidateStoredExecutionShortlist regardless.
  if (!EXECUTION_PASS) {
    try {
      const observations = await timed("marketScan", () => refreshMarketObservations(state));
      state.evaluations = applyMarketObservationsToEvaluations(state.evaluations, observations);
    } catch (error) {
      state.marketScan = {
        ...normalizeMarketScan(state.marketScan),
        lastScanError: error?.message || String(error),
      };
    }
    // Published whatever happened above. A scan that failed is still a run the dashboard
    // has to list, and for a manual scan this row is the only place its error can surface.
    const latestScanRun = state.marketScanHistory?.[0];
    if (latestScanRun && !priorScanRunIds.has(String(latestScanRun.id || latestScanRun.runAt || ""))) {
      await writeScanHistoryEntry(latestScanRun);
    }
    scanFailure = String(normalizeMarketScan(state.marketScan).lastScanError || "");
    if (scanFailure) await writeScanErrorMarker(scanFailure);
  }
  // Up to 300 slug lookups to settle historical rows. Housekeeping of the archive, and
  // the largest single block of waiting in a pass that only wants to place an order.
  if (!scanOnly && !EXECUTION_PASS) {
    state.marketObservations = await timed("observationResolutionSync", () =>
      refreshStoredMarketObservationResolutionStatuses(state.marketObservations || []));
  }

  if (scanOnly) {
    state.generatedAt = nowIso();
    updatePortfolio(state);
    timedSync("calculationReport", () => updateCalculationReport(state));
    markCadenceStage(state, "scan");
    await writeState(state);
    console.log(JSON.stringify({
      // A scan that fetched nothing must not print the success summary. Reporting
      // MARKET_SCAN over a stale lastScanAt is what made a failed manual scan look like it
      // had worked, leaving the user hunting for a log that was never written.
      action: scanFailure ? "MARKET_SCAN_FAILED" : "MARKET_SCAN",
      reason: scanFailure
        ? `scraped market scan did not complete: ${scanFailure}`
        : "10-minute scraped market scan completed; AI evaluation and trade execution were intentionally skipped",
      scanTag: MARKET_SCAN_TAG || null,
      scanTrigger: String(process.env.PAPER_MARKET_SCAN_TRIGGER || (MANUAL_RUN_ONCE ? "MANUAL" : "AUTO")).toUpperCase(),
      scanError: scanFailure || null,
      marketScanAt: state.marketScan?.lastScanAt || null,
      marketBatchCount: state.marketScan?.lastBatchCount || 0,
      retainedObservationCount: state.marketScanHistory?.[0]?.retainedObservationCount || 0,
      resolvedSkippedCount: state.marketScanHistory?.[0]?.resolvedSkippedCount || 0,
    }, null, 2));
    return;
  }

  // Keep the parameter report independent from AI evaluation and trade
  // execution. This scheduled path still refreshes the scraped catalogue
  // above, then recalculates the report without spending Gemini quota or
  // changing any portfolio positions.
  if (reportOnly) {
    state.generatedAt = nowIso();
    timedSync("calculationReport", () => updateCalculationReport(state));
    const decisions = Object.values(state.paperPortfolios).map((portfolioState) => ({
      strategyId: portfolioState.id,
      action: "REPORT",
      reason: "hourly fresh-scraped opportunity simulation updated",
    }));
    const newRunLogEntries = recordRun(state, {
      decisions,
      eligible: [],
      evaluations: [],
    });
    markCadenceStage(state, "report");
    await writeState(state);
    await writePortfolioRunLogEntries(newRunLogEntries);
    console.log(JSON.stringify({
      action: "REPORT",
      reason: "hourly fresh-scraped opportunity simulation updated",
      sampleSize: state.latestCalculationReport?.sampleSize || 0,
      strategies: decisions.map((decision) => decision.strategyId),
    }, null, 2));
    return;
  }

  recoverLedgerGaps(state);
  // Marking open positions to market is what decides how much capital a portfolio has
  // free, so it runs on every pass including an execution one -- but the portfolios do not
  // have to wait for each other. Each one only rewrites its own trades.
  await timed("refreshTrades", () => mapWithConcurrency(
    Object.values(state.paperPortfolios),
    async (portfolioState) => {
      portfolioState.trades = await refreshTrades(portfolioState.trades, portfolioState);
      if (!EXECUTION_PASS) {
        portfolioState.trades = await reviewClosedTradesWithAi(portfolioState.trades, state);
      }
    },
    // Each portfolio fans out over its own trades, so the outer width stays small; the
    // inner refreshTrades calls share the same per-slug cache and the same cap.
    Math.max(2, Math.ceil(REQUEST_CONCURRENCY / 2)),
  ));
  const allTrades = Object.values(state.paperPortfolios).flatMap((portfolioState) => portfolioState.trades || []);
  state.learningProfile = buildLearningProfile(allTrades, state.learningProfile);
  state.generatedAt = nowIso();
  timedSync("updatePortfolio", () => updatePortfolio(state));
  // Not on an execution pass, and not merely to save the work.
  //
  // buildCalculationReport measures the scraped catalogue, and its whole performance half
  // comes from the resolved archive -- which an execution pass never reads, because it
  // carries that segment over untouched. Rebuilding the report from the active half alone
  // therefore does not produce the same report more cheaply; it produces a report whose
  // resolved sample is zero. Measured on real passes either side of this guard: sampleSize
  // read 0 against 4,673 open observations before it, and 53,413 after one full pass. That
  // is the empty-statistics symptom again, arrived at from the other direction.
  //
  // The pass that reads the whole catalogue is the pass that may recalculate it. Carrying
  // the previous report forward is exact, not an approximation: an execution pass does not
  // change a single observation the report is built from.
  if (!EXECUTION_PASS) timedSync("calculationReport", () => updateCalculationReport(state));
  // Trades were refreshed and the report recalculated, so this tick has done the
  // full portfolio pass. Mark it before the narrower manual modes below, which
  // must not move the scheduled cadence clocks -- an execution pass deliberately skips
  // the catalogue maintenance, so claiming the full stage would postpone the pass that
  // actually does it.
  if (!REFRESH_ONLY && !EXECUTION_PASS && !EVALUATION_ONLY) {
    markCadenceStage(state, "full");
  }

  if (REFRESH_ONLY) {
    const decisions = Object.values(state.paperPortfolios).map((portfolioState) => ({
      strategyId: portfolioState.id,
      action: "REFRESH",
      reason: "refreshed open positions and resolved markets only",
    }));
    const newRunLogEntries = recordRun(state, {
      decisions,
      eligible: [],
      evaluations: [],
    });
    await writeState(state);
    await writePortfolioRunLogEntries(newRunLogEntries);
    console.log(JSON.stringify({
        action: "REFRESH",
        reason: "refreshed open positions and resolved markets only",
        strategies: decisions.map((decision) => decision.strategyId),
      }, null, 2));
    return;
  }

  if (EXECUTION_ONLY) {
    const strategiesForRun = dueExecutionStrategies(state);
    if (!strategiesForRun.length) {
      await writeState(state);
      console.log(JSON.stringify({
        action: "AFTER_SCRAPE_WAIT",
        reason: "no paper portfolio is configured for after-scrape execution",
        executionTrigger: EXECUTION_TRIGGER,
      }, null, 2));
      return;
    }
    await timed("execution", () => executeManualPaperRunFromStoredCandidates(state, strategiesForRun, {
      source: "after_scrape",
    }));
    return;
  }

  let strategiesForRun = EVALUATION_ONLY ? executionStrategies() : dueExecutionStrategies(state);
  if (!EVALUATION_ONLY && CONTINUOUS_EVALUATION && !strategiesForRun.length) {
    strategiesForRun = executionStrategies();
  }
  if (!strategiesForRun.length) {
    await writeState(state);
    console.log(JSON.stringify({
      action: "EXECUTION_TRIGGER_WAIT",
      reason: "no paper portfolio is configured for this execution trigger",
      executionTrigger: EXECUTION_TRIGGER,
    }, null, 2));
    return;
  }

  if (MANUAL_RUN_ONCE) {
    await timed("execution", () => executeManualPaperRunFromStoredCandidates(state, strategiesForRun));
    return;
  }

  const knownEvaluationKeys = new Set((state.evaluations || []).map(evaluationKey).filter(Boolean));
  const knownBinaryMarketKeys = new Set((state.evaluations || []).map(binaryEvaluationMarketKey).filter(Boolean));
  const exposureProfile = openExposureProfile(strategiesForRun.map((strategy) => state.paperPortfolios[strategy.id]).filter(Boolean));
  const diversificationByMarket = new Map();
  const diversificationForMarket = (market) => {
    const key = String(market?.id || market?.slug || market?.question || "");
    if (!diversificationByMarket.has(key)) {
      diversificationByMarket.set(key, marketDiversificationScore(market, exposureProfile));
    }
    return diversificationByMarket.get(key);
  };
  const markets = (EVALUATION_ONLY ? await loadFocusedEvaluationMarkets(state) : await loadMarkets()).sort((a, b) => {
    const aNew = marketHasNewOutcome(a, knownEvaluationKeys, knownBinaryMarketKeys) ? 1 : 0;
    const bNew = marketHasNewOutcome(b, knownEvaluationKeys, knownBinaryMarketKeys) ? 1 : 0;
    if (aNew !== bNew) return bNew - aNew;
    const aDiversification = diversificationForMarket(a).score;
    const bDiversification = diversificationForMarket(b).score;
    if (bDiversification !== aDiversification) return bDiversification - aDiversification;
    return Number(b.volume24hr || 0) - Number(a.volume24hr || 0);
  });
  const diversificationDiagnostics = {
    openTrades: exposureProfile.openTrades.length,
    occupiedTags: exposureProfile.tagCounts,
    occupiedCategories: exposureProfile.categoryCounts,
    topDiversifiedMarkets: markets.slice(0, 12).map((market) => {
      const diversification = diversificationForMarket(market);
      return {
        question: market.question || "",
        slug: market.slug || "",
        volume24hr: Number(market.volume24hr || 0),
        diversificationScore: Number(diversification.score.toFixed(2)),
        category: diversification.category,
        tags: diversification.tags,
        reasons: diversification.reasons,
      };
    }),
  };
  let evaluations = [];

  for (const market of markets) {
    const outcomes = parseJsonField(market.outcomes);
    const tokenIds = parseJsonField(market.clobTokenIds);
    const binaryIndexes = binaryYesNoOutcomeIndexes(outcomes);
    const requestedOutcomeIndex = EVALUATION_TOKEN_ID
      ? tokenIds.findIndex((tokenId) => String(tokenId) === EVALUATION_TOKEN_ID)
      : -1;
    const outcomeIndexes = binaryIndexes
      ? [binaryIndexes.yesIndex]
      : requestedOutcomeIndex >= 0
      ? [requestedOutcomeIndex]
      : Array.from({ length: Math.min(outcomes.length, tokenIds.length, 2) }, (_, index) => index);

    for (const outcomeIndex of outcomeIndexes) {
      if (evaluations.length >= MAX_EVALUATIONS_PER_RUN) break;
      const tokenId = tokenIds[outcomeIndex];
      if (!tokenId) continue;

      try {
        const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
        const evaluation = evaluateCandidate({ market, outcomeIndex, tokenId, book, learningProfile: state.learningProfile });
        if (evaluation) {
          if (binaryIndexes) {
            evaluation._binaryCounterpart = {
              market,
              outcomeIndex: binaryIndexes.noIndex,
              outcome: outcomes[binaryIndexes.noIndex] || "No",
              tokenId: tokenIds[binaryIndexes.noIndex],
              yesTokenId: tokenIds[binaryIndexes.yesIndex],
              learningProfile: state.learningProfile,
            };
          }
          evaluations.push(evaluation);
        }
      } catch (error) {
        const errorMessage = error?.message || String(error || "Unknown orderbook error");
        evaluations.push(ensureEvaluationErrorMetadata({
          id: tokenId ? `token:${tokenId}` : `market:${market.slug || market.id || "unknown"}:${outcomes[outcomeIndex] || outcomeIndex}`,
          evaluatedAt: nowIso(),
          status: "ERROR",
          question: market.question || "",
          outcome: outcomes[outcomeIndex] || `Outcome ${outcomeIndex + 1}`,
          tokenId,
          rawErrorMessage: errorMessage,
          rejectReasons: [errorMessage],
          analysisSummary: `Orderbook fetch failed: ${errorMessage}`,
        }));
      }
    }
  }

  const aiCandidateCount = evaluations.length;
  evaluations = (await enrichEvaluationsWithAi(evaluations, state.learningProfile, state)).map(normalizeEvaluationRisk);
  const aiBackoffUntil = state.aiUsage?.quotaBlockedUntil || null;
  state.aiEvaluation = {
    ...(state.aiEvaluation || {}),
    model: GEMINI_MODEL,
    lastRunAt: nowIso(),
    lastStatus: aiBackoffUntil ? "QUOTA_BACKOFF" : "COMPLETED",
    lastCandidateCount: aiCandidateCount,
    lastEvaluatedCount: evaluations.filter((item) => String(item.status || "").toUpperCase() !== "ERROR").length,
    nextRetryAt: aiBackoffUntil || state.aiUsage?.nextAvailableAt || null,
    reason: aiBackoffUntil
      ? `Gemini quota/rate-limit backoff is active until ${aiBackoffUntil}.`
      : "Grounded Gemini evaluation completed for the candidates processed in this run.",
  };
  const eligible = evaluations.filter((item) => item.status === "ELIGIBLE" && (!REQUIRE_GEMINI || hasGroundedPublicMemo(item)));
  const executionEvaluations = evaluations.filter((item) => item.status !== "ERROR" && (!REQUIRE_GEMINI || hasGroundedPublicMemo(item)));
  const decisions = EVALUATION_ONLY
    ? strategiesForRun.map((strategy) => ({
        action: "EVALUATION_ONLY",
        reason: `manual evaluation completed for ${evaluations.length} selected Polymarket outcome${evaluations.length === 1 ? "" : "s"}; no trade was considered`,
        strategyId: strategy.id,
        evaluatedCount: evaluations.length,
        eligibleCount: eligible.length,
        batchLog: {
          action: "EVALUATION_ONLY",
          reason: "manual single-opportunity evaluation",
          explanation: "A single Polymarket opportunity was evaluated on demand. Portfolio positions were not changed.",
          evaluatedCount: evaluations.length,
          eligibleCount: eligible.length,
          selected: evaluations[0] ? tradeBatchCandidateSummary(evaluations[0]) : null,
          evaluationOnly: true,
        },
      }))
    : strategiesForRun.map((strategy) => {
        const portfolioState = state.paperPortfolios[strategy.id];
        const strategyExecutionRows = executionRowsForStrategy(state, strategy, executionEvaluations);
        const rankedEligible = sortEligibleForStrategy(
          strategyExecutionRows.filter((item) => portfolioFilterResult(item, strategy).eligible),
          strategy,
        );
        return maybeOpenScheduledTrade(portfolioState, rankedEligible, strategy, strategyExecutionRows, { diversificationDiagnostics });
      });

  state.generatedAt = nowIso();
  updatePortfolio(state);
  const mergedEvaluations = await refreshStoredEvaluationResolutionStatuses(expirePastEvaluations(mergeEvaluationLists(evaluations, state.evaluations)));
  const retainedBefore = new Set([...(state.evaluations || []), ...evaluations].map(evaluationKey).filter(Boolean)).size;
  state.evaluations = mergedEvaluations.map(ensureEvaluationErrorMetadata);
  timedSync("calculationReport", () => updateCalculationReport(state));
  updateEvaluationStats(state, { evaluations, retainedBefore, retainedAfter: state.evaluations.length });
  const newRunLogEntries = recordRun(state, { evaluations, eligible, decisions });
  await writeState(state);
  await writePortfolioRunLogEntries(newRunLogEntries);
  console.log(JSON.stringify({
    generatedAt: state.generatedAt,
    decisions: Object.fromEntries(decisions.map((decision) => [decision.strategyId, {
      action: decision.action,
      reason: decision.reason,
      tradeId: decision.trade?.id || null,
    }])),
  }, null, 2));
}

// Importing this module must not start a run, otherwise the test suite would hit
// the network and the hosting. Only a direct `node tools/paper-trading-bot.mjs`
// invocation executes.
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  const reportTiming = () => {
    console.log(JSON.stringify({ action: "PASS_TIMING", executionPass: EXECUTION_PASS, ...phaseTimingSummary() }));
  };
  run().then(reportTiming).catch((error) => {
    // Printed on the way out of a failure too: a pass that timed out or died late is
    // exactly the one whose phase breakdown is worth having.
    reportTiming();
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

// Exported for tests only. These are the pure calculations behind the numbers the
// dashboard shows, plus the guards that keep a stale snapshot out of production.
export {
  EFFECTIVELY_CERTAIN_MARKET_PROBABILITY,
  refreshEvaluationAfterProbability,
  PAPER_STRATEGIES,
  portfolioEconomics,
  portfolioFilterResult,
  portfolioProbabilityForStrategy,
  rounded,
  MARKET_OBSERVATION_RETAIN_LIMIT,
  marketDateContext,
  marketScanRetentionReason,
  marketScanLiveTags,
  marketScanScopes,
  resolveMarketScanTag,
  gammaTagRecord,
  normalizeMarketScan,
  refreshMarketObservations,
  overdueHourlyScanScope,
  MARKET_SCAN_HOURLY_TAG_SLUGS,
  scanEventRequestParams,
  annualizationDays,
  annualizeReturn,
  annualizedPotentialReturn,
  buildCalculationReport,
  markCadenceStage,
  mergeCadence,
  minutesSinceIso,
  feeConfig,
  netYieldAfterFees,
  paperEntryEconomics,
  lastRunAtForStrategy,
  strategyCadenceIsDue,
  strategyEligibleCandidates,
  strategyMatchesExecutionTrigger,
  normalizeCadence,
  normalizeState,
  normalizePaperPortfolioArchives,
  archiveAndResetPaperPortfolio,
  restoreArchivedPaperPortfolio,
  adjustPaperPortfolioCapital,
  backfillCapitalAdjustmentAt,
  maybeOpenScheduledTrade,
  markOpenTrade,
  markWaitingLimitOrder,
  limitOrderEventEnded,
  limitOrderFillDecision,
  openPaperTradeForStrategy,
  paperTradeFromCandidate,
  mergeStates,
  openRisk,
  pnlPercent,
  readState,
  resolveScheduledCadence,
  portfoliosWithDeployableCapital,
  riskProfile,
  // What stops a portfolio taking a candidate it already has correlated exposure to, and
  // the sentence the run log shows for it.
  riskBlock,
  riskBlockReason,
  // Whether an event is two-sided or a field of mutually exclusive alternatives. Both the
  // portfolio filters and the statistics classify through this one function.
  reportMarketType,
  // Whether a resting stop would have been filled by the crossing a losing settlement
  // proves, for the one case the live check never reached: the market closed.
  settlementStopFill,
  // Capital that really is in a position, and the check that a fill can be funded out of it.
  positionRisk,
  fundLimitOrderFills,
  simulateMarketBuy,
  splitStateIntoSegments,
  // The choke point that decides whether a pass may remeasure the statistics report.
  updateCalculationReport,
  // The hook readStateWithSegments calls after fetching the core, so a test can put a
  // manifest in front of the writer the same way a real read does.
  rememberStateSegmentManifest,
  PUBLISHED_STATE_SEGMENT_NAMES,
  STATE_SEGMENT_NAMES,
  stateHasCurrentSchema,
  stateSegmentFileName,
  mergeStateSegment,
  syncLegacyPaperAliases,
  takerFeeForFills,
  netExitValueAtPrice,
  equalRiskStopPlan,
  equalRiskEntryProtection,
  equalRiskStopExitDecision,
  shouldCheckEqualStopBeforePending,
  totalCost,
  updatePaperPortfolio,
  withLastLiveMarketProbability,
  writeState,
};
