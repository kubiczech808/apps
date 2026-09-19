// Runs offline: markOpenTrade, markWaitingLimitOrder and fetchMarketByTokenId are the REAL
// functions out of paper-trading-bot.mjs, EXECUTED with globalThis.fetch stubbed. No
// network, no host.
//
// "stale se na eventy na polymarketu nemohu prokliknout, jejich resolution je '-', p/l je u
// vsech 0.0, to je taky divne. neco je spatne."
//
// Three symptoms, one cause. A dip-entry position is rebuilt from a recorded hit, and no
// hit ever carried a slug (measured on production: 0/500). markOpenTrade() begins with
//
//     market = await fetchMarketBySlug(trade.slug)
//
// and fetchMarketBySlug returns null for an empty slug without asking Gamma anything. The
// next line returns MARKET_NOT_FOUND -- and EVERYTHING the function does is below it:
//
//   * the CLOB book read, so currentPrice never moves off the entry and unrealizedPnlUsdc
//     stays 0.00 for the life of the position;
//   * endDate/daysToResolution, so the resolution column renders "-";
//   * eventSlug, so polymarketUrl() has nothing and falls back to the bare homepage.
//
// So the link was never a display bug on its own -- it was the visible corner of a position
// that is not being marked, cannot notice its own market resolving, and reports no P/L.
// Carrying the slug forward (fixed in the same change) repairs positions opened from here
// on; these tests cover the other half, which is that a row that already lost its slug must
// still be refreshable. The token id is on every row, so it is the identifier to fall
// back to.

import assert from "node:assert/strict";
import test from "node:test";

const bot = await import("../tools/paper-trading-bot.mjs");

// Records every URL asked for, so a test can assert on what was NOT requested too -- "the
// slug path is still preferred" is only provable by the absence of the token query.
async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    urls.push(url);
    const body = handler(url);
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({}), text: async () => "" }
      : { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    return { result: await run(), urls };
  } finally {
    globalThis.fetch = original;
  }
}

const TOKEN = "81280220723492411217926832302716507805858486134217234885939562449630067976938";
const OPPOSITE = "83033393998203881216957612527391029081067916028759126771395003345052050286588";
// Far enough out that the position is neither awaiting resolution nor closed.
const END_DATE = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();

const GAMMA_MARKET = {
  question: "Dota 2: Conventus Stellarum vs PlayTime - Game 1 Winner",
  slug: "dota2-cs-playti-2026-09-19-game1",
  events: [{ slug: "dota2-cs-playti-2026-09-19" }],
  clobTokenIds: JSON.stringify([TOKEN, OPPOSITE]),
  outcomes: JSON.stringify(["Conventus Stellarum", "PlayTime"]),
  outcomePrices: JSON.stringify(["0.8", "0.2"]),
  endDate: END_DATE,
  closed: false,
  active: true,
  acceptingOrders: true,
};

// A dip position exactly as dipEntryCandidateRows built it before the fix: everything
// present except the one field the whole refresh keys on.
const dipTrade = (overrides = {}) => ({
  id: "paper-dip70-2026-09-19-conventus",
  strategyId: "dip70",
  status: "OPEN",
  tokenId: TOKEN,
  question: "Dota 2: Conventus Stellarum vs PlayTime - Game 1 Winner",
  outcome: "Conventus Stellarum",
  slug: "",
  entryPrice: 0.6,
  shares: 8.33,
  stakeUsdc: 5,
  totalCostUsdc: 5,
  currentPrice: 0.6,
  unrealizedPnlUsdc: 0,
  openedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  date: new Date().toISOString().slice(0, 10),
  ...overrides,
});

// Gamma answers the token query; the CLOB answers the book. A bid well above entry so a
// mark that actually happened is unmistakable in the P/L.
function marketAndBookHandler({ token = TOKEN, market = GAMMA_MARKET, bestBid = 0.8 } = {}) {
  return (url) => {
    if (url.hostname === "clob.polymarket.com") {
      return { bids: [{ price: String(bestBid), size: "500" }], asks: [{ price: String(bestBid + 0.02), size: "500" }] };
    }
    if (url.searchParams.get("clob_token_ids") === token) return [market];
    if (url.searchParams.get("slug")) return [];
    return [];
  };
}

test("a dip position with no slug is refreshed by its token: mark, P/L and resolution all arrive", async () => {
  const { result } = await withStubbedFetch(marketAndBookHandler(), () => bot.markOpenTrade(dipTrade()));
  assert.notEqual(result.status, "MARKET_NOT_FOUND",
    "the row must no longer dead-end on a slug it never had");
  assert.equal(result.marketUrlStatus !== "not_found", true);
  // The three symptoms, one assertion each.
  assert.ok(Number(result.currentPrice) > 0.6,
    `the mark must move off the entry price: ${JSON.stringify({ currentPrice: result.currentPrice })}`);
  assert.ok(Number(result.unrealizedPnlUsdc) > 0,
    `P/L must stop reading 0.00: ${JSON.stringify({ unrealizedPnlUsdc: result.unrealizedPnlUsdc })}`);
  assert.ok(Number(result.daysToResolution) > 0,
    `the resolution column must have a number instead of "-": ${JSON.stringify({ daysToResolution: result.daysToResolution })}`);
});

test("the refreshed row keeps the slug it was given, so the repair is permanent", async () => {
  const { result } = await withStubbedFetch(marketAndBookHandler(), () => bot.markOpenTrade(dipTrade()));
  assert.equal(result.slug, "dota2-cs-playti-2026-09-19-game1",
    "written back, or every future pass pays for the token lookup again");
  assert.equal(result.eventSlug, "dota2-cs-playti-2026-09-19",
    "and the EVENT slug is what the dashboard's link needs for a grouped market");
});

test("BAIT: the fallback asks for the token, not the slug, and accepts a settled market", async () => {
  // Gamma answers /markets?clob_token_ids=... ; a market that has closed since must still
  // be found, which is why the lookup tries closed=true as well.
  //
  // Its own token, because the lookup is deduplicated per process: a token another test
  // already resolved answers from cache and issues no request at all, which would make
  // this assertion pass or fail on test ORDER rather than on the code.
  const settledToken = `${TOKEN}0001`;
  const { result, urls } = await withStubbedFetch((url) => {
    if (url.searchParams.get("closed") !== "true") return [];
    if (url.searchParams.get("clob_token_ids") !== settledToken) return [];
    return [{ ...GAMMA_MARKET, closed: true }];
  }, () => bot.fetchMarketByTokenId(settledToken));
  assert.ok(result, "a settled market must still be found, or a position could never resolve");
  assert.ok(urls.some((url) => url.searchParams.get("clob_token_ids") === settledToken),
    "the query must be keyed on clob_token_ids");
  assert.ok(urls.some((url) => url.searchParams.get("closed") === "true"),
    "and must try closed=true, which is the only query that reaches a settled market");
});

test("BAIT: a trade that HAS a slug never pays for the token lookup", async () => {
  // The fallback is a repair, not a replacement. Asking Gamma twice for every position on
  // every pass would multiply the bot's own load across the whole book.
  const { urls } = await withStubbedFetch((url) => {
    if (url.hostname === "clob.polymarket.com") return { bids: [{ price: "0.8", size: "500" }], asks: [] };
    if (url.searchParams.get("slug") === "dota2-cs-playti-2026-09-19-game1") return [GAMMA_MARKET];
    return [];
  }, () => bot.markOpenTrade(dipTrade({ slug: "dota2-cs-playti-2026-09-19-game1" })));
  assert.ok(!urls.some((url) => url.searchParams.get("clob_token_ids")),
    `the slug answered, so nothing may ask by token: ${urls.map(String).join(" ")}`);
});

test("BAIT: an unknown token still reports MARKET_NOT_FOUND rather than inventing a market", async () => {
  // Its own token again, for the same per-process cache reason as above.
  const { result } = await withStubbedFetch(() => [],
    () => bot.markOpenTrade(dipTrade({ tokenId: `${TOKEN}0002` })));
  assert.equal(result.status, "MARKET_NOT_FOUND",
    "a market nobody can find must stay not-found; a silent default here would price a position off nothing");
  assert.equal(result.unrealizedPnlUsdc, 0);
});

test("a position waiting for settlement reports a real P/L, not a carried-forward zero", async () => {
  // "p/l se musi zobrazovat dle realu stejne jako u jinych otevrenych pozic. tady by uz
  // nemel byt zadny rozdil v tom jak to funguje u jinych portfolii."
  //
  // Once the fixture is over, the book read is skipped and the row goes straight to
  // PENDING_RESOLUTION -- which used to carry the previous P/L forward and nothing else.
  // For a portfolio that had been marked all along that reads as correct; for a dip row,
  // which never got a mark at all, it carried a zero forward for ever with no book read
  // left to rescue it. The outcome price is known here, and the shares are held, so the
  // value is knowable and so is the P/L.
  const ended = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const settled = { ...GAMMA_MARKET, endDate: ended, outcomePrices: JSON.stringify(["1", "0"]) };
  const { result } = await withStubbedFetch(
    marketAndBookHandler({ token: `${TOKEN}0003`, market: settled }),
    () => bot.markOpenTrade(dipTrade({
      tokenId: `${TOKEN}0003`,
      shares: 8.33,
      stakeUsdc: 5,
      totalCostUsdc: 5,
      unrealizedPnlUsdc: 0,
    })),
  );
  assert.equal(result.status, "PENDING_RESOLUTION");
  assert.equal(result.currentPrice, 1, "the settlement print is the price it is worth");
  assert.equal(result.currentValueUsdc, 8.33, "8.33 shares at 1.00");
  assert.equal(result.unrealizedPnlUsdc, 3.33, "8.33 less the 5.00 it cost -- not the zero it arrived with");
});

test("BAIT: a pending row with no price to value it against keeps what it had", async () => {
  // The rule must not invent a number. With no settlement print and no mark, there is
  // nothing to compute from, and the previous figure is the best answer available.
  const ended = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const priceless = { ...GAMMA_MARKET, endDate: ended, outcomePrices: JSON.stringify([]) };
  const { result } = await withStubbedFetch(
    marketAndBookHandler({ token: `${TOKEN}0004`, market: priceless }),
    () => bot.markOpenTrade(dipTrade({
      tokenId: `${TOKEN}0004`,
      shares: 8.33,
      totalCostUsdc: 5,
      currentPrice: null,
      currentValueUsdc: null,
      unrealizedPnlUsdc: -1.25,
    })),
  );
  assert.equal(result.status, "PENDING_RESOLUTION");
  assert.equal(result.unrealizedPnlUsdc, -1.25, "nothing to value it with, so nothing is invented");
});

test("a waiting limit order with no slug also gets its resolution date", async () => {
  const waiting = dipTrade({ status: "LIMIT_ORDER_WAITING", limitPrice: 0.6, orderPrice: 0.6 });
  const { result } = await withStubbedFetch(marketAndBookHandler(), () => bot.markWaitingLimitOrder(waiting));
  assert.notEqual(result.status, "MARKET_NOT_FOUND");
  assert.ok(Number(result.daysToResolution) > 0,
    `a resting order must know when its market ends: ${JSON.stringify({ daysToResolution: result.daysToResolution })}`);
  assert.equal(result.slug, "dota2-cs-playti-2026-09-19-game1");
});

test("a recorded dip with no slug borrows the market's address from the catalogue", async () => {
  // The birth gap, closed where the two sources already meet. The slug belongs to the
  // MARKET, so the favourite side -- the one above 0.50 that the catalogue keeps -- carries
  // the same one, and matching on conditionId costs nothing.
  const recorded = [{ tokenId: "collapsed-side", conditionId: "0xmarket", slug: "", question: "Q" }];
  const catalogue = [{ tokenId: "favourite-side", conditionId: "0xmarket", slug: "atp-simakin-heck-2026-09-18", eventSlug: "atp-simakin-heck-2026-09-18" }];
  const [row] = bot.mergeDipEntryPool(recorded, catalogue);
  assert.equal(row.tokenId, "collapsed-side", "the recording still leads -- it has the price the dip reached");
  assert.equal(row.slug, "atp-simakin-heck-2026-09-18");
  assert.equal(row.eventSlug, "atp-simakin-heck-2026-09-18");
});

test("BAIT: a recorded dip that already has a slug keeps its own", async () => {
  const recorded = [{ tokenId: "t", conditionId: "0xmarket", slug: "its-own-slug", eventSlug: "its-own-event" }];
  const catalogue = [{ tokenId: "other", conditionId: "0xmarket", slug: "someone-elses", eventSlug: "someone-elses" }];
  const [row] = bot.mergeDipEntryPool(recorded, catalogue);
  assert.equal(row.slug, "its-own-slug", "a row that knows its address must not have it overwritten");
  assert.equal(row.eventSlug, "its-own-event");
});

test("BAIT: no catalogue row for that market leaves the recording exactly as it was", async () => {
  // Nothing may be invented: a dip whose market is genuinely absent from the catalogue is
  // still opened, and repaired from its token on the first refresh instead.
  const recorded = [{ tokenId: "t", conditionId: "0xmarket", slug: "", question: "Q" }];
  const [row] = bot.mergeDipEntryPool(recorded, [{ tokenId: "x", conditionId: "0xdifferent", slug: "unrelated" }]);
  assert.equal(row.slug, "");
  assert.equal(row.question, "Q", "and the row itself is untouched");
});
