const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const ref = process.env.GITHUB_REF_NAME || "main";
const configUrl = "https://www.osobnizkusenosti.cz/trading/api.php?action=portfolio-config";

if (!repository || !token) {
  throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to dispatch post-scrape execution.");
}

const apiHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    payload = { raw: body.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

const configPayload = await readJson(configUrl, {
  headers: { "User-Agent": "trading-post-scrape-dispatch/1.0" },
});
const config = configPayload.config || {};
const paper = config.paper || {};
const live = config.live || {};
const paperAfterScrape = Object.values(paper).some((portfolio) => portfolio?.executionTrigger === "after_scrape");
const liveAfterScrape = live.executionTrigger === "after_scrape";

async function dispatch(workflow, inputs) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`;
  await readJson(url, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ ref, inputs }),
  });
  console.log(`Dispatched ${workflow} for ref ${ref}.`);
}

if (!paperAfterScrape && !liveAfterScrape) {
  console.log("No portfolio is configured for execution after scraping; no execution workflow dispatched.");
  process.exit(0);
}

if (paperAfterScrape) {
  await dispatch("trading-paper-bot.yml", { mode: "after_scan" });
}
if (liveAfterScrape) {
  await dispatch("polymarket-live-limit-order-test.yml", {
    live_confirm: "true",
    live_execution_trigger: "after_scrape",
    live_run_source: "AUTO",
  });
}
