// Not a test file (the runner's glob is *.test.mjs): the harness that lifts the browser's
// real parameter builder out of app.js and runs it with its own real helpers.
//
// Shared because two tests need it. tests/portfolio-parameter-card drives it to check that
// every setting has a row and that each value is the number rather than a sentence;
// tests/portfolio-management drives one row of it, having previously driven a formatter
// that the shared list replaced.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} was not found in app.js`);
  let depth = 0;
  for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is not closed`);
}

// A top-level const, whether it is one line or a block.
const constant = (name) => {
  const start = APP.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} must be findable in app.js`);
  const end = APP.indexOf("\n};", start);
  const line = APP.indexOf("\n", start);
  return end > start && end < line + 400 ? APP.slice(start, end + 3) : APP.slice(start, line);
};

// The real builder with its real helpers. Only the two that read page state are supplied:
// which horizon this mode is configured for, and the system-wide switch.
const REAL_HELPERS = [
  "dipEntryRuleFromConfig", "dipEntryRuleFault", "normalizeStopLossProbabilityFloor",
  "normalizeSettlementCloseBid", "stopLossRiskMultiplier", "normalizeOptionalMoney",
  "normalizeMarketTagList", "configExcludedMarketShapes", "normalizeEligibilityThreshold",
  "normalizeOptionalProbability", "configLiveEventMode", "formatHorizonHours",
  "normalizeRiskAllocation", "portfolioMarketTypeLabel", "normalizePortfolioMarketType",
  "marketShapeLabel", "stopLossReverseIsEnabled", "automaticRotationIsEnabled",
  "normalizeExecutionTrigger", "executionCronMinutesLabel", "normalizeExecutionCronMinutes",
  "normalizeMinimumNetYield", "money", "percent", "probability", "dipEntryBound", "stopLossIsEnabled", "normalizeLiveEventMode", "normalizedScrapedScanTag", "normalizeStopLossRiskMultiplier",
];

const BUILDER_SOURCE = `
  ${REAL_HELPERS.map((name) => extractFunction(APP, name)).join("\n")}
  ${constant("MARKET_SHAPE_LABELS")}
  ${constant("DEFAULT_RISK_ALLOCATION")}
  ${constant("TERSE_NONE")}
  ${constant("DIP_ENTRY_RULE_DEFAULTS")}
  ${constant("MIN_ELIGIBILITY_THRESHOLD")}
  ${constant("MAX_ELIGIBILITY_THRESHOLD")}
  ${constant("EXECUTION_CRON_CHOICES")}
  ${constant("MAX_RISK_ALLOCATION")}
  ${constant("MIN_RISK_ALLOCATION")}
  ${constant("LIVE_EVENT_MODES")}
  ${extractFunction(APP, "portfolioParameterRows")}
  return portfolioParameterRows;
`;
const buildRows = new Function("resolutionHoursForMode", BUILDER_SOURCE)(() => 19);


export { buildRows, APP, API, extractFunction, constant };

// One row, for a test that is about that row alone.
export function resolutionRowFor(config = {}, hours = 19) {
  const rows = buildRowsWithHorizon(config, hours);
  return rows.find(([label]) => label === "Resolution")?.[1];
}

function buildRowsWithHorizon(config, hours) {
  const build = new Function("resolutionHoursForMode", BUILDER_SOURCE)(() => hours);
  return build(config, { mode: "paper-x" });
}
