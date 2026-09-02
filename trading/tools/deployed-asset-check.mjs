// Read-only. Fetches the deployed dashboard assets and reports whether the markers you
// name are present in them. No credentials, nothing written, no side effects.
//
// It exists because "the code is in the repo and every deploy went green" does not answer
// "is that what the browser is running". A stale file, a partial upload, or a marker that
// only ever existed locally all look identical from here, and each calls for a different
// fix. Reported for a UI element that vanished with no commit having removed it.
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/$/, "");
const FILES = (process.env.ASSET_FILES || "assets/app.js,assets/app.css,index.html")
  .split(",").map((value) => value.trim()).filter(Boolean);
const MARKERS = (process.env.ASSET_MARKERS || "market-tags-button,marketTagsInfo,openMarketTagsPanel,market-tags-panel")
  .split(",").map((value) => value.trim()).filter(Boolean);

async function main() {
  console.log(`Deployed asset check at ${new Date().toISOString()}`);
  console.log(`host ${HOST}`);
  console.log(`Read-only: fetches published files, writes nothing.\n`);

  for (const file of FILES) {
    const url = `${HOST}/${file}?assetCheck=${Date.now()}`;
    let response;
    let body = "";
    try {
      response = await fetch(url);
      body = await response.text();
    } catch (error) {
      console.log(`== ${file}\n   !! fetch failed: ${error?.message || error}\n`);
      continue;
    }
    console.log(`== ${file}`);
    console.log(`   HTTP ${response.status}   ${body.length} bytes`
      + `   last-modified ${response.headers.get("last-modified") || "(not sent)"}`
      + `   etag ${response.headers.get("etag") || "(none)"}`);
    // The headers decide whether a browser ever asks again. A correctly stamped page is
    // still invisible if the PAGE itself is the cached copy: it keeps requesting the old
    // asset URL, which it also has. So the page's own caching is part of the answer.
    console.log(`   cache-control ${response.headers.get("cache-control") || "(not sent)"}`
      + `   expires ${response.headers.get("expires") || "(not sent)"}`
      + `   pragma ${response.headers.get("pragma") || "(not sent)"}`);
    if (file.endsWith(".html")) {
      for (const match of body.matchAll(/(?:href|src)="(assets\/[^"]+)"/g)) {
        console.log(`   references ${match[1]}`);
      }
    }
    if (!response.ok) {
      console.log(`   body starts: ${body.slice(0, 160)}\n`);
      continue;
    }
    for (const marker of MARKERS) {
      const count = body.split(marker).length - 1;
      console.log(`   ${count ? "found" : "MISSING"}  ${String(count).padStart(3)}x  ${marker}`);
    }
    // A file the browser cannot parse is a file whose later half never runs, which looks
    // exactly like a missing feature. Counting braces is crude but catches a truncated
    // upload, which is the failure this is really watching for.
    if (file.endsWith(".js")) {
      const opens = body.split("{").length - 1;
      const closes = body.split("}").length - 1;
      console.log(`   braces ${opens} open / ${closes} close${opens === closes ? "" : "   <- UNBALANCED: the upload looks truncated"}`);
      console.log(`   ends with: ${JSON.stringify(body.slice(-70))}`);
    }
    console.log("");
  }
}

main().catch((error) => {
  console.log(`\n!! asset check stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
