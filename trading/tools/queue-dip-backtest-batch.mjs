#!/usr/bin/env node
// Queues exactly one follow-up batch after a successful publish. Keeping this outside the
// workflow YAML makes the stop condition testable without calling GitHub.

import { readFile } from "node:fs/promises";

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function nextDipBacktestDispatch(report, { ref, tag, maxMarkets } = {}) {
  if (positiveInteger(report?.coverage?.pendingMarkets) === 0) return null;
  return {
    ref: String(ref || "").trim(),
    inputs: {
      tag: String(tag || report?.tag || "esports").trim().toLowerCase(),
      max_markets: String(positiveInteger(maxMarkets) || 600),
    },
  };
}

async function main() {
  const tag = String(process.env.DIP_BACKTEST_TAG || "esports").trim().toLowerCase();
  const reportPath = process.env.DIP_BACKTEST_REPORT_PATH || `data/dip-backtest-${tag}-report.json`;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const dispatch = nextDipBacktestDispatch(
    JSON.parse(await readFile(reportPath, "utf8")),
    {
      ref: process.env.GITHUB_REF_NAME,
      tag: process.env.DIP_BACKTEST_TAG,
      maxMarkets: process.env.DIP_BACKTEST_MAX_MARKETS,
    },
  );
  if (!dispatch) {
    console.log("Historical DIP archive is complete; no follow-up batch queued.");
    return;
  }
  if (!repository || !token || !dispatch.ref) throw new Error("GitHub dispatch context is missing");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/trading-dip-history-backtest.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "trading-dip-history-backtest",
    },
    body: JSON.stringify(dispatch),
  });
  if (!response.ok) throw new Error(`Unable to queue next historical DIP batch: HTTP ${response.status}`);
  console.log(`Queued next historical DIP batch for ${dispatch.inputs.tag}; ${positiveInteger(process.env.DIP_BACKTEST_MAX_MARKETS) || 600} markets.`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
