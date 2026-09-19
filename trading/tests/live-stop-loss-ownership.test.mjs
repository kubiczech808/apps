// Runs offline: live_stop_loss_policy_payload() is the REAL function out of api.php, lifted
// and EXECUTED by php against real files in a temp directory standing in for __DIR__. No
// network, no database, no host.
//
// "ten zapas je vyhranny (kdyby nedoslo k prodeji pozice). problem je, ze to je zapas naseho
// live portfolia, ktere nema zadny stop loss nastaven!"
//
// Reconstructed from the account, 2026-09-18. "Counter-Strike: ShindeN vs Turma do Pagode"
// was bought by "70-80 esports" (live-custom-underway: stopLossRiskMultiplier 0,
// stopLossProbabilityFloor 0 -- no stop configured at all, only a 0.999 settlement close) at
// 14:38, and sold by the worker at 23:48 citing reasonKind "stop" under portfolioId "live"
// (the base portfolio's own 1.5x multiplier / 0.49 floor) for a 1.52 USDC loss on a match
// that, per the account holder, went on to resolve in the held outcome's favour. Two sibling
// positions from the same tournament, closed nearer their own entry and so still inside the
// run log's window, carry the correct owner in live-exit-records.json.
//
// live_stop_loss_policy_payload() attributes a token to its owner by walking each portfolio's
// run log for a SUBMITTED/PENDING_MATCH record naming it -- and that log is bounded (160
// entries client-side, "about a day at this cadence" per live-order-executor.mjs's own
// comment). Once the entry that placed an order ages out, the token looks unowned and
// silently adopts the base Live portfolio's policy instead of staying under, or correctly
// excluded from, its true owner's.
//
// The fix does not invent new storage. live-order-executor.mjs already uploads
// `orderOwnership` beside `runLog` -- "Which tokens THIS portfolio ordered, kept past the run
// log's horizon", capped at 4,000 entries against the run log's 160 -- and nothing
// server-side ever read it. This tests that it now does.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const TOKEN = "45219239380163422650995836088957174218814167070180096522939338722942621151843";

const HOURS = 3600 * 1000;
const now = Date.now();
const iso = (hoursAgo) => new Date(now - hoursAgo * HOURS).toISOString();

// Runs the real function against a fixture directory. No storage.php is written, so api.php's
// own fallback (the block right after `require_once $tradingStoragePath`, taken only when the
// file is absent -- "Offline API tests deliberately copy just api.php into a temporary
// document root") supplies trading_storage_is_active() etc. without a database.
function runPolicyPayload(fixture) {
  const directory = mkdtempSync(join(tmpdir(), "live-stop-loss-ownership-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php must still end with its request dispatch");
    writeFileSync(join(directory, "definitions.php"), API.slice(0, cut) + "\n");
    mkdirSync(join(directory, "data"), { recursive: true });
    for (const [name, contents] of Object.entries(fixture)) {
      writeFileSync(join(directory, "data", name), JSON.stringify(contents));
    }
    return JSON.parse(execFileSync("php", ["-r",
      `require '${join(directory, "definitions.php")}';`
      + ` echo json_encode(live_stop_loss_policy_payload());`,
    ], { encoding: "utf8", cwd: directory, maxBuffer: 16 * 1024 * 1024 }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The account and portfolio shapes as they actually are.
const CONFIG = {
  live: { stopLossRiskMultiplier: 1.5, stopLossProbabilityFloor: 0.49, settlementCloseBid: 0.999, stakeUsdc: 5 },
  live5050: { archived: true },
  livePortfolios: {
    underway: {
      displayName: "70-80 esports",
      // The reported setting, exactly: no stop, only the certainty close.
      stopLossRiskMultiplier: 0,
      stopLossProbabilityFloor: 0,
      settlementCloseBid: 0.999,
      stakeUsdc: 5,
      archived: false,
      automationEnabled: true,
    },
  },
};

const LIVE_STATE = {
  portfolio: { cashUsdc: 10 },
  positions: [{ tokenId: TOKEN, question: "ShindeN vs Turma do Pagode", entryPrice: 0.7, shares: 7.14 }],
};

function fixture({ underwayRunLog = [], underwayOwnership = [], liveRunLog = [] } = {}) {
  return {
    "portfolio-config.json": CONFIG,
    "live-state.json": LIVE_STATE,
    "live-execution-state.json": { runLog: liveRunLog, orderOwnership: [] },
    "live-underway-execution-state.json": { runLog: underwayRunLog, orderOwnership: underwayOwnership },
  };
}

function policyFor(payload, tokenId = TOKEN) {
  const rows = Array.isArray(payload?.policies) ? payload.policies : [];
  return rows.find((row) => row.tokenId === tokenId) || null;
}

test("with its own run log entry still retained, the position is correctly protected", () => {
  // The baseline: attribution working as designed, before anything has had time to rotate.
  const payload = runPolicyPayload(fixture({
    underwayRunLog: [{
      action: "SUBMITTED", generatedAt: iso(1),
      selected: { tokenId: TOKEN },
    }],
  }));
  const policy = policyFor(payload);
  assert.ok(policy, "the position must be attributed to somebody");
  assert.equal(policy.portfolioId, "live-custom-underway");
  assert.equal(policy.stopLossEnabled, false, "this portfolio never armed a stop");
  assert.equal(policy.stopLossProbabilityFloor, 0);
  assert.equal(policy.settlementCloseBid, 0.999, "only the certainty close is its own");
});

test("once the entry's run log entry has rotated out, durable orderOwnership still protects it", () => {
  // The reported failure, reproduced: the run log that placed this order is gone (empty,
  // standing in for "aged past 160 entries"), but the durable record survives.
  const payload = runPolicyPayload(fixture({
    underwayRunLog: [],
    underwayOwnership: [{ tokenId: TOKEN, price: 0.7, mode: "live", at: iso(9.17) }],
  }));
  const policy = policyFor(payload);
  assert.ok(policy, "orderOwnership must still attribute the position");
  assert.equal(policy.portfolioId, "live-custom-underway",
    "the true owner, not the base Live portfolio");
  assert.equal(policy.stopLossEnabled, false,
    "the owner never configured a stop -- adopting one from elsewhere is the bug");
  assert.equal(policy.stopLossProbabilityFloor, 0);
  assert.equal(payload.positionsAdoptedFromAccount, 0,
    "a durably-attributed position must not also count as adopted from the account fallback");
});

test("BAIT: without reading orderOwnership, the same position silently adopts the base portfolio's stop", () => {
  // Exactly the incident. Nothing in the fixture changes except that orderOwnership is
  // dropped from the read -- which is what the code did before this fix, and it must still
  // be possible to reproduce that failure by removing the new source, not just assert the
  // fixed behaviour in isolation.
  const start = API.indexOf("function live_stop_loss_policy_payload()");
  const end = API.indexOf("\n}\n", start);
  const withoutOwnershipRead = API.slice(0, start)
    + API.slice(start, end).replace(
      /\n        \/\/ The durable record[\s\S]*?\$ownedAt\[\$tokenId\] = \$updatedAt;\n        \}\n/,
      "\n",
    )
    + API.slice(end);
  assert.notEqual(withoutOwnershipRead, API, "the orderOwnership block must actually be removed");

  const directory = mkdtempSync(join(tmpdir(), "live-stop-loss-ownership-bait-"));
  try {
    const cut = withoutOwnershipRead.indexOf("\ntry {");
    writeFileSync(join(directory, "definitions.php"), withoutOwnershipRead.slice(0, cut) + "\n");
    mkdirSync(join(directory, "data"), { recursive: true });
    const rows = fixture({ underwayRunLog: [], underwayOwnership: [{ tokenId: TOKEN, price: 0.7, mode: "live", at: iso(9.17) }] });
    for (const [name, contents] of Object.entries(rows)) {
      writeFileSync(join(directory, "data", name), JSON.stringify(contents));
    }
    const payload = JSON.parse(execFileSync("php", ["-r",
      `require '${join(directory, "definitions.php")}';`
      + ` echo json_encode(live_stop_loss_policy_payload());`,
    ], { encoding: "utf8", cwd: directory, maxBuffer: 16 * 1024 * 1024 }));
    const policy = policyFor(payload);
    assert.ok(policy, "the account-fallback still adopts it");
    assert.equal(policy.portfolioId, "live",
      "without orderOwnership the position falls back to the base portfolio");
    assert.equal(policy.stopLossEnabled, true,
      "and inherits a stop its true owner never configured -- the reported loss");
    assert.equal(policy.stopLossProbabilityFloor, 0.49);
    assert.equal(payload.positionsAdoptedFromAccount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a fresher run log claim still wins over a stale orderOwnership record", () => {
  // The merge must stay time-ordered across BOTH sources, or a token traded again more
  // recently by a different portfolio would keep its old owner's stop instead of the new
  // one's -- the same danger this fix exists to close, in the other direction.
  const payload = runPolicyPayload(fixture({
    underwayOwnership: [{ tokenId: TOKEN, price: 0.7, mode: "live", at: iso(20) }],
    liveRunLog: [{ action: "SUBMITTED", generatedAt: iso(1), selected: { tokenId: TOKEN } }],
  }));
  const policy = policyFor(payload);
  assert.equal(policy.portfolioId, "live", "the more recent claim must win");
});

test("a stale run log claim does not override a fresher orderOwnership record", () => {
  const payload = runPolicyPayload(fixture({
    underwayOwnership: [{ tokenId: TOKEN, price: 0.7, mode: "live", at: iso(1) }],
    liveRunLog: [{ action: "SUBMITTED", generatedAt: iso(20), selected: { tokenId: TOKEN } }],
  }));
  const policy = policyFor(payload);
  assert.equal(policy.portfolioId, "live-custom-underway", "the more recent claim must win");
});

test("BAIT: an orderOwnership row missing a tokenId does not falsely attribute the position", () => {
  // A malformed row must contribute nothing to $ownerOf, which is a DIFFERENT outcome from
  // "excluded" -- it leaves the token genuinely unattributed, so it still reaches the normal
  // open-position fallback and adopts defaultPolicy exactly as an unowned position always
  // has. The bug this guards is the row's price or mode being read as if it were the token.
  const payload = runPolicyPayload(fixture({
    underwayOwnership: [{ price: 0.7, mode: "live", at: iso(1) }],
  }));
  const policy = policyFor(payload);
  assert.ok(policy, "a genuinely unattributed open position still gets the account fallback");
  assert.equal(policy.portfolioId, "live", "not the underway portfolio the malformed row named no token for");
  assert.equal(policy.source, "open-position", "reached via the fallback, not via orderOwnership");
  assert.equal(payload.positionsAdoptedFromAccount, 1);
});

test("the helper reads exactly what the executor uploads, keyed by tokenId, not by price", () => {
  const body = API.slice(
    API.indexOf("function live_execution_state_order_ownership_token_ids"),
    API.indexOf("\n}\n", API.indexOf("function live_execution_state_order_ownership_token_ids")),
  );
  assert.match(body, /\$state\['orderOwnership'\]/, "must read the field the executor actually writes");
  assert.match(body, /\$row\['tokenId'\]/);
  // Multiple rows for the same token at different prices (the executor's own key) must still
  // collapse to one owner -- ownership here is per-token, not per-price.
  const payload = runPolicyPayload(fixture({
    underwayOwnership: [
      { tokenId: TOKEN, price: 0.7, at: iso(9) },
      { tokenId: TOKEN, price: 0.68, at: iso(0.5) },
    ],
  }));
  assert.equal(policyFor(payload).portfolioId, "live-custom-underway");
});
