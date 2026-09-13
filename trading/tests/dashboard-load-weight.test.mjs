// Runs offline: the rule is lifted out of app.js and executed. No network, no secrets.
//
// Reported: ERR_CONNECTION_CLOSED when opening the app on a phone.
//
// Measured from a datacentre runner the same minute, and this is why the fix is not on the
// server: every request the dashboard makes answered OK in under three seconds --
//
//   scraping log / scraped tab      2.75s  2.97 MB   1200 rows, more pages follow
//   scraped, second page            2.09s  2.92 MB   1200 rows, more pages follow
//   resolved archive, first page    1.85s  3.48 MB   1200 rows, more pages follow
//   resolved archive, second page   1.62s  2.93 MB   1016 rows
//   dashboard                       1.52s  1.50 MB
//   live account                    1.37s  1.52 MB
//
// -- with totals scraped=8091. Seven pages of the active catalogue at about 3 MB each, plus
// two of the archive: roughly 27 MB, fetched in the background on EVERY load whichever tab
// was open, so that open-order rows could turn a token id into a market name. A phone drops
// the connection long before that finishes, and the app never renders.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function lift(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} was not found in app.js`);
  let depth = 0;
  for (let index = APP.indexOf("{", APP.indexOf(")", start)); index < APP.length; index += 1) {
    if (APP[index] === "{") depth += 1;
    else if (APP[index] === "}") {
      depth -= 1;
      if (depth === 0) return APP.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}

const app = new Function(`
  ${lift("scrapedCatalogueViewNeedsEveryPage")}
  ${lift("scrapedWalkIsDeferred")}
  return { scrapedCatalogueViewNeedsEveryPage, scrapedWalkIsDeferred };
`)();

test("dashboard load: the catalogue walk is deferred unless a view lists markets", () => {
  // The background load, on the tabs where nobody is looking at a market list. This is the
  // 27 MB that must not be fetched.
  for (const view of ["portfolios", "live", "", null, undefined, "candidates"]) {
    assert.equal(app.scrapedWalkIsDeferred({ firstPageOnly: true, opportunityView: view }), true,
      `a background load on "${view}" must stop after one page`);
  }

  // The three views that genuinely need every row: they filter, count and sort the whole
  // catalogue in the browser, so a page of it would silently answer with a fraction --
  // which is its own reported bug and must not be reintroduced by this fix.
  for (const view of ["scraped", "scan-log", "overview"]) {
    assert.equal(app.scrapedCatalogueViewNeedsEveryPage(view), true);
    assert.equal(app.scrapedWalkIsDeferred({ firstPageOnly: true, opportunityView: view }), false,
      `"${view}" lists markets and must still get every page`);
  }

  // A deliberate load -- opening one of those tabs, or a forced refresh -- never defers,
  // whatever the view happens to be at that moment.
  assert.equal(app.scrapedWalkIsDeferred({ opportunityView: "portfolios" }), false);
  assert.equal(app.scrapedWalkIsDeferred({ firstPageOnly: false, opportunityView: "portfolios" }), false);
  assert.equal(app.scrapedWalkIsDeferred({}), false);
});

test("dashboard load: a partial catalogue is not mistaken for a loaded one", () => {
  // The half of the fix that is easy to leave out. Fetching one page and marking nothing
  // would make the next call return early, and the Scraped tab would list 1,200 of 8,091
  // rows for the rest of the session -- worse than the slow load it replaced, because it
  // would be wrong rather than late.
  assert.match(APP, /state\.scrapedMarketStatePartial = true;/,
    "a deferred walk has to leave a mark");
  assert.match(APP, /state\.scrapedMarketStatePartial = false;/,
    "and a complete walk has to clear it");
  assert.match(APP, /const partialWouldDo = !\(needsEveryPage && state\.scrapedMarketStatePartial === true\);/);
  assert.match(APP, /matchingExecutionScope && partialWouldDo\)/,
    "the early return must consult it, or the mark is written and never read");

  // And the call that caused this must be the one that defers.
  assert.match(APP, /ensureScrapedMarketState\(\{ \.\.\.options, firstPageOnly: true \}\);/,
    "the background load is the 27 MB one");
  // While the tab switches keep asking for everything.
  assert.match(APP, /state\.opportunityView === "overview"\) ensureScrapedMarketState\(\);/);
});
