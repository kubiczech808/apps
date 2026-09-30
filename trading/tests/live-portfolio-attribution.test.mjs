import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { stampPortfolioOwnership } from "../tools/live-account-sync.mjs";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function ownership(entries) {
  return new Map([["shared-token", entries]]);
}

test("historical rows use the ownership proof that predates the entry, not a later re-entry", () => {
  const [row] = stampPortfolioOwnership([{
    asset_id: "shared-token",
    averagePrice: 0.759,
    openedAt: "2026-09-29T10:05:00Z",
    portfolioId: "live",
  }], ownership([
    {
      mode: "live-custom-counterstrike",
      price: 0.759,
      at: "2026-09-29T10:00:00Z",
      source: "stored-run-log",
    },
    {
      mode: "live-custom-dip",
      price: 0.759,
      at: "2026-09-30T10:00:00Z",
      source: "dip-entry-ledger",
    },
  ]));

  assert.equal(row.portfolioId, "live-custom-counterstrike");
  assert.equal(row.portfolioOwnershipAt, "2026-09-29T10:00:00Z");
  assert.equal(row.portfolioOwnershipSource, "stored-run-log");
});

test("ambiguous later ownership records never guess an owner for an older closed row", () => {
  const [row] = stampPortfolioOwnership([{
    asset: "shared-token",
    entryPrice: 0.64,
    openedAt: "2026-09-29T10:00:00Z",
  }], ownership([
    { mode: "live-custom-first", price: 0.64, at: "2026-09-30T10:00:00Z" },
    { mode: "live-custom-second", price: 0.64, at: "2026-09-30T11:00:00Z" },
  ]));

  assert.equal(row.portfolioId, undefined);
});

test("a single unambiguous ownership record repairs a legacy base-Live placeholder", () => {
  const [row] = stampPortfolioOwnership([{
    clobTokenId: "shared-token",
    avgPrice: 0.51,
    openedAt: "2026-09-29T10:00:00Z",
    portfolioId: "live",
  }], ownership([
    { mode: "live-custom-dip", price: 0.51, at: "2026-09-29T09:59:00Z", source: "dip-entry-ledger" },
  ]));

  assert.equal(row.portfolioId, "live-custom-dip");
  assert.equal(row.portfolioOwnershipSource, "dip-entry-ledger");
});

test("the server serves all durable order sources, including old selected-only runs and DIP fills", () => {
  assert.match(API, /function live_execution_record_ownership_entries\(array \$record\): array/);
  assert.match(API, /\$record\['selected'\].*\$batchLog\['selected'\]/s);
  assert.match(API, /live_execution_record_ownership_entries\(\$record\)/);
  assert.match(API, /foreach \(live_dip_entry_ownership_records\(\) as \$entry\)/);
  assert.match(API, /'dip-entry-ledger'/);
  assert.match(API, /function live_row_token_id\(array \$row\): string/);
});

test("dashboard In positions reports the committed stake instead of a near-zero current mark", () => {
  const overview = APP.slice(APP.indexOf("function renderPortfolioOverview()"), APP.indexOf("function renderPortfolioControls()"));
  assert.match(overview, /const committed = \(row\) =>/);
  assert.match(overview, /row\?\.totalCostUsdc \?\? row\?\.stakeUsdc \?\? row\?\.maxLossUsdc/);
  assert.match(overview, /ownPositions\.reduce\(\(sum, row\) => sum \+ committed\(row\), 0\)/);
  assert.doesNotMatch(overview, /row\?\.marketValueUsdc/);
});
