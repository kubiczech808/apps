#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

async function loadPlaywright() {
  const candidates = [
    "playwright",
    "playwright-core",
    "/home/openclaw2/.openclaw/virtual-assistant-node/node_modules/playwright/index.js",
    "/home/openclaw2/.openclaw/virtual-assistant-node/node_modules/playwright-core/index.js",
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      const api = mod.chromium ? mod : mod.default;
      if (api?.chromium) {
        return api;
      }
      errors.push(`${candidate}: imported module has no chromium export`);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Playwright module is not available: ${errors.join(" | ")}`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function chromiumExecutable() {
  if (process.env.VIRTUAL_ASSISTANT_CHROMIUM_PATH && await pathExists(process.env.VIRTUAL_ASSISTANT_CHROMIUM_PATH)) {
    return process.env.VIRTUAL_ASSISTANT_CHROMIUM_PATH;
  }
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return "";
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function isSubmitLike(selector, text = "") {
  const low = `${selector} ${text}`.toLowerCase();
  return (
    low.includes("[type=submit]") ||
    low.includes('[type="submit"]') ||
    low.includes("submit") ||
    low.includes("odeslat") ||
    low.includes("publik") ||
    low.includes("post comment") ||
    low.includes("send")
  );
}

async function clickOrSubmit(page, selector, allowSubmit, timeoutMs) {
  const locator = page.locator(selector).first();
  const text = await locator.innerText({ timeout: 3000 }).catch(() => "");
  const submitLike = isSubmitLike(selector, text);
  if (!allowSubmit && submitLike) {
    return { ok: false, blocked: "submit-like click blocked because allowSubmit=false" };
  }
  try {
    await locator.click({ timeout: timeoutMs });
    return { ok: true, fallback: "" };
  } catch (error) {
    if (!submitLike) {
      throw error;
    }
    const fallback = await locator.evaluate((el) => {
      const form = el.form || el.closest("form");
      if (typeof el.click === "function") {
        el.click();
        return "dom-click";
      }
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit(el);
        return "form-requestSubmit";
      }
      if (form && typeof form.submit === "function") {
        form.submit();
        return "form-submit";
      }
      throw new Error("submit fallback unavailable");
    }, { timeout: timeoutMs });
    return { ok: true, fallback, recoveredFrom: error.message };
  }
}

async function elementSummary(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const fields = [...document.querySelectorAll("input, textarea, select, button")]
      .filter(visible)
      .slice(0, 80)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        text: (el.innerText || el.value || "").trim().slice(0, 120),
      }));
    const forms = [...document.querySelectorAll("form")]
      .slice(0, 20)
      .map((form) => ({
        action: form.getAttribute("action") || "",
        method: form.getAttribute("method") || "get",
        id: form.id || "",
        fields: [...form.querySelectorAll("input, textarea, select, button")]
          .slice(0, 40)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") || "",
            name: el.getAttribute("name") || "",
            id: el.id || "",
            placeholder: el.getAttribute("placeholder") || "",
            text: (el.innerText || el.value || "").trim().slice(0, 80),
          })),
      }));
    return {
      title: document.title,
      url: location.href,
      forms,
      fields,
    };
  });
}

async function genericAutofill(page, values = {}, options = {}) {
  return await page.evaluate(({ values, submit, allowSubmit }) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const norm = (value) => String(value || "").toLowerCase();
    const labelText = (el) => {
      const bits = [
        el.getAttribute("name"),
        el.id,
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"),
      ];
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) bits.push(label.textContent || "");
      }
      const parentLabel = el.closest("label");
      if (parentLabel) bits.push(parentLabel.textContent || "");
      return norm(bits.filter(Boolean).join(" "));
    };
    const pickValue = (el) => {
      const type = norm(el.getAttribute("type") || el.tagName);
      const hay = labelText(el);
      if (type === "email" || hay.includes("email") || hay.includes("e-mail")) return values.email;
      if (type === "tel" || hay.includes("phone") || hay.includes("telefon") || hay.includes("mobil")) return values.phone;
      if (type === "url" || hay.includes("web") || hay.includes("url")) return values.website;
      if (hay.includes("subject") || hay.includes("predmet") || hay.includes("předmět")) return values.subject;
      if (hay.includes("firma") || hay.includes("company") || hay.includes("spolecnost")) return values.company;
      if (hay.includes("surname") || hay.includes("lastname") || hay.includes("prijmeni") || hay.includes("příjmení")) return values.lastName;
      if (hay.includes("firstname") || hay.includes("jmeno") || hay.includes("jméno") || hay.includes("name")) return values.name;
      if (el.tagName.toLowerCase() === "textarea" || hay.includes("message") || hay.includes("zprava") || hay.includes("zpráva") || hay.includes("comment") || hay.includes("komentar") || hay.includes("komentář")) return values.message;
      return values.text;
    };
    const setValue = (el, value) => {
      el.focus();
      el.value = value || "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const forms = [...document.querySelectorAll("form")].filter((form) =>
      visible(form) && [...form.querySelectorAll("input, textarea, select")].some(visible)
    );
    const root = forms[0] || document;
    const filled = [];
    const skipped = [];
    const fields = [...root.querySelectorAll("input, textarea, select")].filter(visible);
    const seenRadio = new Set();
    for (const el of fields) {
      const tag = el.tagName.toLowerCase();
      const type = norm(el.getAttribute("type") || tag);
      const name = el.getAttribute("name") || el.id || tag;
      if (["hidden", "submit", "button", "image", "reset", "file", "password"].includes(type)) {
        skipped.push({ name, type });
        continue;
      }
      if (tag === "select") {
        const option = [...el.options].find((item) => !item.disabled && item.value) || [...el.options].find((item) => !item.disabled);
        if (option) {
          el.value = option.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          filled.push({ name, type: "select", value: option.value });
        }
        continue;
      }
      if (type === "checkbox") {
        if (!el.checked) el.click();
        filled.push({ name, type: "checkbox", value: "checked" });
        continue;
      }
      if (type === "radio") {
        const group = el.getAttribute("name") || el.id || "__radio";
        if (!seenRadio.has(group)) {
          el.click();
          seenRadio.add(group);
          filled.push({ name, type: "radio", value: el.value || "selected" });
        }
        continue;
      }
      const value = pickValue(el);
      setValue(el, value);
      filled.push({ name, type, value: String(value || "").slice(0, 80) });
    }
    let submitted = false;
    let blocked = "";
    if (submit) {
      const submitter = root.querySelector("button[type='submit'], input[type='submit'], button:not([type]), input[type='button']");
      if (!allowSubmit) {
        blocked = "submit blocked because allowSubmit=false";
      } else if (submitter && visible(submitter)) {
        submitter.click();
        submitted = true;
      } else if (root.tagName && root.tagName.toLowerCase() === "form") {
        root.requestSubmit ? root.requestSubmit() : root.submit();
        submitted = true;
      } else {
        blocked = "submit control not found";
      }
    }
    return { filled, skipped, submitted, blocked, formFound: Boolean(forms[0]) };
  }, {
    values,
    submit: options.submit !== false,
    allowSubmit: options.allowSubmit !== false,
  });
}

async function run() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    throw new Error("Usage: virtual_assistant_playwright.mjs task.json");
  }
  const task = JSON.parse(await fs.readFile(taskPath, "utf8"));
  const url = requireString(task.url, "url");
  const actions = Array.isArray(task.actions) ? task.actions : [];
  const allowSubmit = task.allowSubmit !== false;
  const screenshotPath = task.screenshotPath ? String(task.screenshotPath) : "";
  const timeoutMs = Number.isFinite(Number(task.timeoutMs)) ? Number(task.timeoutMs) : 45000;
  const { chromium } = await loadPlaywright();
  const executablePath = await chromiumExecutable();
  const launchOptions = {
    headless: task.headless !== false,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({
    viewport: { width: Number(task.width || 1280), height: Number(task.height || 900) },
  });
  const result = {
    ok: false,
    url,
    finalUrl: "",
    title: "",
    actions: [],
    summary: null,
    screenshotPath: "",
  };
  try {
    await page.goto(url, { waitUntil: task.waitUntil || "domcontentloaded", timeout: timeoutMs });
    for (const action of actions) {
      const type = String(action.type || "").toLowerCase();
      const selector = type === "autofill" ? "" : requireString(action.selector, "action.selector");
      const note = { type, selector, ok: false };
      try {
        if (type === "autofill") {
          note.details = await genericAutofill(page, action.values || {}, {
            submit: action.submit !== false,
            allowSubmit,
          });
          if (note.details.submitted) {
            await Promise.race([
              page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {}),
              page.waitForTimeout(2500),
            ]);
          }
          note.ok = Array.isArray(note.details.filled) && note.details.filled.length > 0;
          if (!note.ok) note.blocked = "no visible fields filled";
          if (note.details.blocked) note.blocked = note.details.blocked;
        } else if (type === "fill") {
          await page.locator(selector).first().fill(String(action.value ?? ""), { timeout: timeoutMs });
          note.ok = true;
        } else if (type === "check") {
          await page.locator(selector).first().check({ timeout: timeoutMs });
          note.ok = true;
        } else if (type === "select") {
          await page.locator(selector).first().selectOption(String(action.value ?? ""), { timeout: timeoutMs });
          note.ok = true;
        } else if (type === "click") {
          const clickResult = await clickOrSubmit(page, selector, allowSubmit, timeoutMs);
          if (clickResult.blocked) {
            note.blocked = clickResult.blocked;
          } else if (clickResult.ok) {
            await Promise.race([
              page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {}),
              page.waitForTimeout(2500),
            ]);
            note.ok = true;
            if (clickResult.fallback) note.fallback = clickResult.fallback;
            if (clickResult.recoveredFrom) note.recoveredFrom = clickResult.recoveredFrom;
          }
        } else {
          note.blocked = `unknown action type ${type}`;
        }
      } catch (error) {
        if (action.optional === true) {
          note.blocked = `optional action unavailable: ${error.message}`;
        } else {
          note.error = error.message;
          result.error = error.message;
          result.actions.push(note);
          break;
        }
      }
      if (!result.actions.includes(note)) {
        result.actions.push(note);
      }
    }
    if (screenshotPath) {
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPath = screenshotPath;
    }
    result.summary = await elementSummary(page);
    result.submitMarker = await page.evaluate(() => ({
      bodySubmitted: document.body?.dataset?.submitted || "",
      resultText: document.querySelector("#result")?.textContent?.trim() || "",
    })).catch(() => ({}));
    result.pageText = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 5000)).catch(() => "");
    result.finalUrl = page.url();
    result.title = await page.title();
    result.ok = result.actions.every((item) => item.ok || item.blocked);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
