#!/usr/bin/env node
// Read-only. Public GETs against the published state. No keys, no writes, no orders.
//
// Reported: the "dip 70+ to 30-56" portfolio shows "0 ready" while its own caption says
// "169 dip(s) recorded, newest 18. 09. 2026 09:57 at 56.0%", with an active opportunity
// visible on the exchange.
//
// A first theory was that the dashboard and the bot disagreed on the portfolio id -- the
// dashboard accepts a hit tagged "paper-<id>" OR the bare "<id>", the bot only the prefixed
// form. Checked against the code that writes them, and it does not hold: the watch plans are
// built with "paper-" already on them. So the mismatch is somewhere else, and this looks
// rather than guesses again.
//
// Every stage between a recorded dip and a ready candidate, counted, with the rows that fall
// out named at the stage they fall out:
//
//   recorded  -> for this portfolio  -> not already held  -> priced  -> inside the buy band
//
// The interesting number is wherever it drops to zero.
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const WANT = (process.env.PROBE_PORTFOLIO || "dip").toLowerCase();

async function json(path) {
  const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

async function main() {
  console.log(`Dip shortlist probe, ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written and no credentials are used.\n");

  const config = await json("api.php?action=portfolio-config");
  const body = config?.config || {};
  const candidates = Object.entries(body.paper || {})
    .map(([id, entry]) => ({ id, name: String(entry?.displayName || entry?.label || id), config: entry }));
  const match = candidates.find((entry) => entry.name.toLowerCase().includes(WANT)
    || entry.id.toLowerCase().includes(WANT));
  if (!match) {
    console.log(`No paper portfolio matching "${WANT}". Configured:`);
    for (const entry of candidates) console.log(`   ${entry.id.padEnd(24)} ${entry.name}`);
    return;
  }
  const prefixed = `paper-${match.id}`;
  console.log(`Portfolio: ${match.name}  (id=${match.id}, hits are filed under "${prefixed}")\n`);

  const rule = {
    openMin: num(match.config?.dipEntryOpenMin),
    openMax: num(match.config?.dipEntryOpenMax),
    buyMin: num(match.config?.dipEntryBuyMin) ?? num(match.config?.minProbability),
    buyMax: num(match.config?.dipEntryBuyMax) ?? num(match.config?.maxProbability),
    enabled: match.config?.dipEntryEnabled,
  };
  console.log("== the rule as configured");
  console.log(`   ${JSON.stringify(rule)}`);
  // Every gate strategyEligibleCandidates consults, printed rather than guessed at. Three
  // theories have already been checked and eliminated -- the portfolioId spelling, the
  // under-way flag, the volume floor -- and each cost a dispatch. The settings that decide
  // the remaining gates are right here and cost nothing.
  console.log("   gates that can still reject a dip row:");
  for (const field of ["minProbability", "maxProbability", "maxResolutionDays", "minLiquidityUsdc",
    "excludedMarketShapes", "excludeOverUnderMarkets", "includeOnlyMarketTags", "excludedMarketTags",
    "liveEventMode", "equalRiskProtection", "marketType", "automationEnabled", "archived"]) {
    if (match.config?.[field] !== undefined) {
      console.log(`      ${field.padEnd(24)} ${JSON.stringify(match.config[field])}`);
    }
  }

  // And what the bot itself said it did. It records a reason per skipped candidate on every
  // run, which is the authoritative answer to "why did nothing pass" -- reading it beats a
  // fourth theory.
  try {
    // 300 rather than 40. The bot runs about every five minutes, so forty rows reach back
    // barely three hours -- and the dips this is trying to explain were recorded at 11:37.
    // A window that stops short of the event reports "no eligible runs" for a day in which
    // there were some, which is the most confident kind of wrong answer.
    const log = await json(`api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(match.id)}&page_size=300`);
    const records = Array.isArray(log?.records) ? log.records : [];
    console.log(`\n== the bot's own run log (${records.length} of ${log?.total ?? "?"} rows)`);
    if (records.length) {
      console.log(`   fields: ${Object.keys(records[0]).join(", ")}`);
    }
    const reasons = new Map();
    for (const record of records.slice(0, 20)) {
      for (const entry of record.skipReasons || record.reasons || record.rejections || []) {
        const key = String(entry?.reason ?? entry?.label ?? entry ?? "");
        const count = num(entry?.count) ?? 1;
        if (key) reasons.set(key, (reasons.get(key) || 0) + count);
      }
    }
    for (const [reason, count] of [...reasons].sort((left, right) => right[1] - left[1]).slice(0, 12)) {
      console.log(`   ${String(count).padStart(5)}x  ${reason.slice(0, 110)}`);
    }
    if (!reasons.size && records.length) {
      // The shape is printed rather than the absence reported, so the next run reads a
      // field name instead of trying another one.
      console.log(`   no skip reasons on these rows; newest row: ${JSON.stringify(records[0]).slice(0, 500)}`);
    }

    // Did a run EVER find something, and when. The worker's journal shows six dips recorded
    // at 11:26-11:37 on 2026-09-18, and no position was opened from any of them -- which the
    // gate counts above cannot explain, because they are applied to hits as they stand NOW,
    // hours later, when every one of those matches has ended. What decides is what the bot
    // saw at the time, and the run log is the only record of that.
    const eligible = records.filter((row) => num(row?.eligibleCount) > 0);
    const acted = records.filter((row) => String(row?.action ?? "") !== "SKIP");
    const evaluated = records.map((row) => num(row?.evaluatedCount) ?? 0);
    console.log(`   runs retained: ${records.length}`
      + `, evaluated per run: ${evaluated.length ? `${Math.min(...evaluated)}-${Math.max(...evaluated)}` : "?"}`);
    console.log(`   runs with eligibleCount > 0: ${eligible.length}`
      + `${eligible.length ? ` (newest ${String(eligible[0].runAt).slice(0, 16)})` : ""}`);
    console.log(`   runs that did anything but SKIP: ${acted.length}`
      + `${acted.length ? ` (newest ${String(acted[0].runAt).slice(0, 16)} ${acted[0].action})` : ""}`);
    if (records.length) {
      console.log(`   oldest retained run: ${String(records[records.length - 1].runAt).slice(0, 16)}`
        + `, newest: ${String(records[0].runAt).slice(0, 16)}`);
    }
    if (records.length && !eligible.length) {
      console.log("   Not one retained run found a single eligible candidate. If dips WERE");
      console.log("   recorded inside this window, the loss is between the recorded hit and");
      console.log("   strategyEligibleCandidates -- not in the shortlist the gates below count.");
    }
  } catch (error) {
    console.log(`\n== the bot's own run log: could not read (${String(error.message).slice(0, 200)})`);
  }

  const [watch, hits] = await Promise.all([
    json(`api.php?action=dip-entry-watch&t=${Date.now()}`).catch((error) => ({ error: error.message })),
    json(`api.php?action=dip-entry-hits&t=${Date.now()}`).catch((error) => ({ error: error.message })),
  ]);

  console.log("\n== what is being watched");
  const now = Date.now();
  const plans = Array.isArray(watch?.watch) ? watch.watch : (Array.isArray(watch?.plans) ? watch.plans : []);
  if (watch?.error) console.log(`   could not read: ${watch.error}`);
  const byWatchPortfolio = new Map();
  for (const plan of plans) {
    const key = String(plan?.portfolioId ?? "(none)");
    byWatchPortfolio.set(key, (byWatchPortfolio.get(key) || 0) + 1);
  }
  console.log(`   ${plans.length} plan(s): ${[...byWatchPortfolio].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  // The number this probe was missing. The watch admits a market on one test -- has its
  // kickoff passed -- and applies NO upper bound, so a fixture that finished days ago still
  // reads as running until it is marked RESOLVED. Its price then decays towards 0 or 1 as the
  // result becomes known, which is indistinguishable from a dip. If this count is high, the
  // rule is catching settlements rather than collapses.
  const plansEnded = plans.filter((plan) => {
    const end = Date.parse(String(plan?.endDate || ""));
    return Number.isFinite(end) && end <= now;
  }).length;
  const plansUndated = plans.filter((plan) => !Number.isFinite(Date.parse(String(plan?.endDate || "")))).length;
  console.log(`   ... already past their resolution date: ${plansEnded}`
    + ` (${plans.length ? ((plansEnded / plans.length) * 100).toFixed(0) : "0"}%)`);
  console.log(`   ... carrying no resolution date at all: ${plansUndated}`);
  if (plansEnded > plans.length / 2) {
    console.log("   The watch is mostly finished markets. live_dip_entry_watch_payload() admits");
    console.log("   anything whose kickoff has passed and never asks whether it is over.");
  }

  console.log("\n== the recorded dips");
  const rows = Array.isArray(hits?.hits) ? hits.hits : [];
  if (hits?.error) console.log(`   could not read: ${hits.error}`);
  const byPortfolio = new Map();
  for (const hit of rows) {
    const key = String(hit?.portfolioId ?? "(none)");
    byPortfolio.set(key, (byPortfolio.get(key) || 0) + 1);
  }
  console.log(`   ${rows.length} hit(s) in total: ${[...byPortfolio].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  // The id question, settled rather than assumed either way.
  console.log(`   filed under "${prefixed}": ${byPortfolio.get(prefixed) || 0}`);
  console.log(`   filed under the bare "${match.id}": ${byPortfolio.get(match.id) || 0}`);

  // WHEN the last one arrived, which is the question every count above leaves open. A
  // portfolio with 186 recorded dips and nothing ready looks identical whether the worker
  // recorded one a minute ago or stopped recording days ago -- and those are completely
  // different faults. Each hit carries 'at' (record_dip_entry_hit, api.php), so this was one
  // sort away and was simply never printed.
  const age = (value) => {
    const when = Date.parse(String(value ?? ""));
    return Number.isFinite(when) ? (Date.now() - when) / 3600000 : null;
  };
  const dated = rows.map((hit) => ({ hit, hours: age(hit?.at) })).filter((row) => row.hours !== null);
  dated.sort((left, right) => left.hours - right.hours);
  if (!dated.length) {
    console.log("   none of the hits carry a timestamp, so their age cannot be read");
  } else {
    const newest = dated[0];
    console.log(`   newest hit anywhere: ${String(newest.hit.at).slice(0, 16)}`
      + ` (${newest.hours.toFixed(1)} h ago, ${newest.hit.portfolioId})`);
    for (const window of [1, 6, 24]) {
      console.log(`   ... recorded in the last ${String(window).padStart(2)} h: `
        + `${dated.filter((row) => row.hours <= window).length}`);
    }
    const mineDated = dated.filter((row) => String(row.hit?.portfolioId ?? "") === prefixed);
    console.log(`   newest for this portfolio: ${mineDated.length
      ? `${String(mineDated[0].hit.at).slice(0, 16)} (${mineDated[0].hours.toFixed(1)} h ago)` : "never"}`);
    if (newest.hours > 6) {
      console.log("   NOTHING has been recorded for hours. The gates below cannot explain that --");
      console.log("   they filter hits that already exist. This points at the RPi worker, which");
      console.log("   polls the watched books every second and is what writes a hit at all.");
    }
  }

  const mine = rows.filter((hit) => String(hit?.portfolioId ?? "") === prefixed);
  if (!mine.length) {
    console.log("\n   NONE of the recorded dips are filed under this portfolio's id.");
    console.log("   That alone explains a shortlist of zero beside a caption counting hundreds,");
    console.log("   because the dashboard's caption accepts a second spelling and the bot does not.");
    return;
  }

  // What the bot's own row builder would reject. Each gate is the one named in
  // dipEntryCandidateRows, applied in the same order.
  console.log("\n== what happens to this portfolio's dips");
  const state = await json(
    `api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(match.id)}&t=${Date.now()}`)
    .catch((error) => ({ error: error.message }));
  const portfolio = state?.paperPortfolios?.[match.id] || {};
  const trades = Array.isArray(portfolio?.trades) ? portfolio.trades : [];
  const openTokens = new Set(trades
    .filter((trade) => ["OPEN", "LIMIT_ORDER_WAITING"].includes(String(trade?.status || "").toUpperCase()))
    .map((trade) => String(trade?.tokenId || "")));
  const everTokens = new Set(trades.map((trade) => String(trade?.tokenId || "")));

  // The gate this probe used to leave out, and it is the one that decided the answer.
  // liveEventMode "only" means the portfolio trades nothing but running fixtures --
  // paper-trading-bot.mjs rejects a row outright when the event has not kicked off. Left
  // unapplied, this probe reported rows as "WOULD BE READY" that the bot would certainly
  // refuse, which is the probe lying rather than the bot misbehaving.
  const liveEventMode = String(match.config?.liveEventMode ?? "ignore").toLowerCase();
  // The same question the bot asks, and the same inability to answer it: a hit that carries
  // no kickoff is counted apart rather than guessed either way.
  // The portfolio's tag lists, applied exactly as observationMatchesActiveLiveConfig applies
  // them: an include list demands at least one match, an exclude list forbids any.
  const slugify = (value) => String(value ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const tagSet = (list) => new Set((Array.isArray(list) ? list : []).map(slugify).filter(Boolean));
  const includeTags = tagSet(match.config?.includeOnlyMarketTags || match.config?.allowedMarketTags);
  const excludeTags = tagSet(match.config?.excludedMarketTags);
  const hitTags = (hit) => {
    const out = new Set();
    for (const field of ["polymarketTags", "tags", "firstPolymarketTags", "firstTags",
      "polymarketCategories", "firstPolymarketCategories"]) {
      for (const raw of (Array.isArray(hit?.[field]) ? hit[field] : [])) {
        const tag = slugify(raw && typeof raw === "object" ? (raw.slug || raw.label || raw.name || "") : raw);
        if (tag) out.add(tag);
      }
    }
    for (const field of ["riskCategory", "category", "firstCategory"]) {
      const tag = slugify(hit?.[field]);
      if (tag) out.add(tag);
    }
    return out;
  };
  const tagsAdmit = (hit) => {
    const tags = hitTags(hit);
    if (excludeTags.size && [...excludeTags].some((tag) => tags.has(tag))) return false;
    if (includeTags.size && ![...includeTags].some((tag) => tags.has(tag))) return false;
    return true;
  };

  const running = (hit) => {
    const kickoff = Date.parse(String(hit?.eventStartTime || ""));
    if (Number.isFinite(kickoff)) return kickoff <= now;
    if (typeof hit?.eventStarted === "boolean") return hit.eventStarted;
    return null;
  };

  let unpriced = 0;
  let held = 0;
  let traded = 0;
  let outsideBand = 0;
  let ended = 0;
  let notRunning = 0;
  let startUnknown = 0;
  let outsideTags = 0;
  let ready = 0;
  const readyRows = [];
  for (const hit of mine) {
    const price = num(hit?.price);
    if (price === null || price <= 0 || price >= 1) { unpriced += 1; continue; }
    const token = String(hit?.tokenId || "");
    if (openTokens.has(token)) { held += 1; continue; }
    if (everTokens.has(token)) { traded += 1; continue; }
    const end = Date.parse(String(hit?.endDate || ""));
    if (Number.isFinite(end) && end <= now) { ended += 1; continue; }
    if ((rule.buyMin != null && price < rule.buyMin) || (rule.buyMax != null && price > rule.buyMax)) {
      outsideBand += 1;
      continue;
    }
    if (liveEventMode === "only") {
      const live = running(hit);
      if (live === null) { startUnknown += 1; continue; }
      if (!live) { notRunning += 1; continue; }
    }
    // The gate this mirror was missing, and it was the one deciding the answer. A portfolio
    // with includeOnlyMarketTags refuses a row whose tag set is empty, and a rebuilt dip row
    // carried no tags at all -- so 270 recorded dips a day were refused here while this probe
    // reported innocent gates three times running. A mirror missing a rule is worse than none.
    if (!tagsAdmit(hit)) { outsideTags += 1; continue; }
    ready += 1;
    readyRows.push(hit);
  }

  console.log(`   recorded for this portfolio        ${mine.length}`);
  console.log(`   ... unusable price                 ${unpriced}`);
  console.log(`   ... already an OPEN position       ${held}`);
  console.log(`   ... already traded once            ${traded}`);
  console.log(`   ... market already ended           ${ended}`);
  console.log(`   ... dip price outside the buy band ${outsideBand}`);
  if (liveEventMode === "only") {
    console.log(`   ... fixture has not kicked off     ${notRunning}`);
    console.log(`   ... no kickoff recorded at all     ${startUnknown}`);
  }
  console.log(`   ... tags the portfolio refuses     ${outsideTags}`);
  console.log(`   ... WOULD BE READY                 ${ready}`);
  console.log(`\n   liveEventMode: ${JSON.stringify(liveEventMode)}`
    + (liveEventMode === "only"
      ? "  -- this portfolio trades running fixtures only, so a dip is actionable"
        + "\n   only during the match. Outside that window the bot refuses it whatever else passes."
      : ""));

  // Volume is printed because it is the strongest remaining suspect and it is invisible
  // everywhere else. dipEntryCandidateRows turns a hit that recorded no volume into a row
  // with volumeUsdc = 0, and the worker stores null whenever its plan had none -- so a dip
  // can be recorded, look ready on every other gate, and then fail a liquidity floor it
  // never had a number for.
  const floor = num(match.config?.minLiquidityUsdc);
  console.log(`\n   portfolio liquidity floor: ${floor == null ? "none set (the bot default applies)" : `$${floor}`}`);
  for (const hit of readyRows.slice(0, 10)) {
    const volume = num(hit.volumeUsdc);
    console.log(`      ${String(hit.question || hit.slug || "?").slice(0, 52).padEnd(52)}`
      + ` at ${(num(hit.price) * 100).toFixed(1)}%  opened ${hit.openProbability != null ? `${(num(hit.openProbability) * 100).toFixed(0)}%` : "?"}`
      + `  ends ${String(hit.endDate || "?").slice(0, 16)}`
      + `  vol ${volume == null ? "NOT RECORDED -> becomes 0" : `$${volume.toFixed(0)}`}`);
  }
  const noVolume = readyRows.filter((hit) => num(hit.volumeUsdc) == null).length;
  if (noVolume) {
    console.log(`\n   ${noVolume} of ${readyRows.length} ready dip(s) recorded NO volume. The candidate row is`);
    console.log("   built with volumeUsdc = 0 for those, so every liquidity floor rejects them --");
    console.log("   a dip that was caught correctly and can never be traded.");
  }
  if (!ready) {
    console.log("\n   Nothing is ready, and the line above says which gate consumed them. If it is");
    console.log("   'already traded once', the rule is working as built: a dip is recorded once per");
    console.log("   token forever, so an old hit can never produce a second entry -- and the caption");
    console.log("   counts all 169 of those, which is why it disagrees with the shortlist.");
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
