// Runs offline: no secrets, no network, no DOM beyond the stub below.
//
// Two faults reported on the portfolio form, and both are the kind that only show up when
// somebody else uses it:
//
//   1. A value typed in was saved as a different value. 70 and 0 in the dip band came back
//      as 1 % - 70 %; a field left empty filled itself in with 80 %.
//   2. Copying a dip portfolio produced a form with the dip rule unticked.
//
// So the form's rules are executed here rather than read: the validator runs against real
// field values, and the copy runs the real chain from the source portfolio to the checkbox.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function extract(pattern, label) {
  const match = pattern.exec(APP);
  assert.ok(match, `${label} must be findable in app.js`);
  return match[0];
}

// A field, as much of one as the validator touches: a value, a class list and attributes.
function field(value = "") {
  const classes = new Set();
  return {
    value,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    insertAdjacentElement() {},
    invalid: () => classes.has("field-invalid"),
  };
}

// Drives the real validator with a real `els`. Every field the table names is present, so
// a rule that stops being checked shows up as a missing error rather than as a skip.
function validate(values = {}, { dipOn = false } = {}) {
  const source = [
    extract(/function portfolioFormFields[\s\S]*?\n\}/, "portfolioFormFields"),
    extract(/function portfolioFieldRangeText[\s\S]*?\n\}/, "portfolioFieldRangeText"),
    extract(/function formatFieldBound[\s\S]*?\n\}/, "formatFieldBound"),
    extract(/function portfolioFormFieldErrors[\s\S]*?\n  return errors;\n\}/, "portfolioFormFieldErrors"),
  ].join("\n");

  const names = [
    "eligibilityThreshold", "maxEligibilityThreshold", "riskAllocation", "maxResolutionHours",
    "stopLossProbabilityFloor", "dipEntryOpenMin", "dipEntryOpenMax", "settlementCloseBid",
    "minLiquidity", "minNetYield", "stopLossRiskMultiplier", "fixedEntryPrice",
    "executionCronMinutes",
  ];
  // Defaults every rule accepts, so a test naming one field is testing only that field.
  const defaults = {
    eligibilityThreshold: "60", maxEligibilityThreshold: "90", riskAllocation: "5",
    maxResolutionHours: "48", stopLossProbabilityFloor: "0", dipEntryOpenMin: "70",
    dipEntryOpenMax: "80", settlementCloseBid: "0", minLiquidity: "0", minNetYield: "0",
    stopLossRiskMultiplier: "0", fixedEntryPrice: "0", executionCronMinutes: "60",
  };
  const els = { dipEntryEnabled: { checked: dipOn } };
  for (const name of names) {
    els[name] = field(String(values[name] ?? defaults[name]));
  }
  const run = new Function("els", `${source}\nreturn portfolioFormFieldErrors();`);
  const errors = run(els);
  return {
    errors,
    els,
    for: (name) => errors.find((error) => error.element === els[name]) || null,
    messages: errors.map((error) => error.message),
  };
}

test("a value the form cannot store is refused, not rewritten", () => {
  // The reported case, exactly: 70 and 0 in the dip band. It used to save as 1 % - 70 %,
  // because the 0 was clamped up to 1 and the pair was then reordered.
  const reported = validate({ dipEntryOpenMin: "70", dipEntryOpenMax: "0" }, { dipOn: true });
  const failing = reported.for("dipEntryOpenMax");
  assert.ok(failing, `0 must be refused: ${JSON.stringify(reported.messages)}`);
  assert.match(failing.message, /Dip entry opening band to is 0/);
  // And it has to say what IS accepted, or the reader is left guessing.
  assert.match(failing.message, /1 to 99 %/);
  // The other half was typed correctly and must not be blamed.
  assert.equal(reported.for("dipEntryOpenMin"), null);

  // An empty field used to fill itself in with 80 %. While the rule is on it is refused.
  const empty = validate({ dipEntryOpenMax: "" }, { dipOn: true });
  assert.match(empty.for("dipEntryOpenMax")?.message || "", /is needed while the dip rule is on/);

  // And while the rule is OFF, an empty band is nothing to complain about -- demanding one
  // would block saving every other change on the form.
  assert.equal(validate({ dipEntryOpenMax: "" }, { dipOn: false }).for("dipEntryOpenMax"), null);
});

test("a band typed the wrong way round is reported, not silently swapped", () => {
  const reversed = validate({ dipEntryOpenMin: "80", dipEntryOpenMax: "70" }, { dipOn: true });
  const error = reversed.for("dipEntryOpenMax");
  assert.ok(error, `a reversed band must be reported: ${JSON.stringify(reversed.messages)}`);
  assert.match(error.message, /below the opening band from \(80\)|The band has to read upwards/);

  // The probability range is the same shape of pair and gets the same treatment.
  const range = validate({ eligibilityThreshold: "90", maxEligibilityThreshold: "60" });
  assert.ok(range.for("maxEligibilityThreshold"), "the probability range must be checked too");

  // Equal bounds are a band of one value, which is a choice rather than a slip.
  assert.equal(validate({ dipEntryOpenMin: "70", dipEntryOpenMax: "70" }, { dipOn: true }).errors.length, 0);
});

test("zero means off where zero means off, and nothing in between is accepted", () => {
  // Close at certainty stores 0 as "never close early", and otherwise sits in 50-99.9.
  assert.equal(validate({ settlementCloseBid: "0" }).for("settlementCloseBid"), null);
  assert.equal(validate({ settlementCloseBid: "99.9" }).for("settlementCloseBid"), null);
  const tooLow = validate({ settlementCloseBid: "30" }).for("settlementCloseBid");
  assert.ok(tooLow, "30 is neither off nor inside the band");
  // The message has to carry both halves or it reads as "0 is not allowed either".
  assert.match(tooLow.message, /50 to 99\.9 %, or 0 to switch it off/);

  // Above the top of the band is refused as well -- 100 % never trades.
  assert.ok(validate({ settlementCloseBid: "100" }).for("settlementCloseBid"));
});

test("the form accepts what it should, so the check is not just refusing everything", () => {
  // A validator that rejects everything passes every test above. This is the control.
  assert.deepEqual(validate({}, { dipOn: true }).messages, []);
  assert.deepEqual(validate({
    eligibilityThreshold: "55", maxEligibilityThreshold: "99", riskAllocation: "0.01",
    maxResolutionHours: "8760", settlementCloseBid: "99.9", minLiquidity: "25000",
    minNetYield: "3", stopLossRiskMultiplier: "150", executionCronMinutes: "1440",
  }, { dipOn: true }).messages, []);

  // A decimal comma is what a Czech keyboard gives, and it is a number.
  assert.deepEqual(validate({ settlementCloseBid: "99,9" }).messages, []);

  // Text is not.
  assert.match(validate({ riskAllocation: "abc" }).for("riskAllocation")?.message || "", /must be a number/);
});

test("copying a portfolio carries the dip rule, checkbox included", () => {
  // Reported: the copy opened with the dip rule unticked. This runs the real chain --
  // source portfolio, the prefill that strips what must not be carried, the draft the modal
  // is built from, and the rule the checkbox reads.
  const chain = new Function("customLivePortfolioDefaults", "normalizePortfolioName", "normalizePortfolioAccountType", "parameterCapitalContextForMode", `
    const DIP_ENTRY_RULE_DEFAULTS = { openMin: 0.7, openMax: 0.8, buyMin: 0.2, buyMax: 0.3 };
    ${extract(/function dipEntryBound[\s\S]*?\n\}/, "dipEntryBound")}
    ${extract(/function dipEntryRuleFromConfig[\s\S]*?\n\}/, "dipEntryRuleFromConfig")}
    ${extract(/function livePrefillFromPaperPortfolio[\s\S]*?\n\}/, "livePrefillFromPaperPortfolio")}
    ${extract(/function createPortfolioDraftForType[\s\S]*?\n\}/, "createPortfolioDraftForType")}
    return (source) => {
      const prefill = livePrefillFromPaperPortfolio(source, "copy live");
      const next = createPortfolioDraftForType("live", "copyid", prefill, "copy live");
      return { draft: next.draft, rule: dipEntryRuleFromConfig(next.draft) };
    };
  `)(
    () => ({ dipEntryEnabled: false, minProbability: 0.5 }),
    (name, fallback) => String(name || fallback || ""),
    () => "live",
    () => ({}),
  );

  const source = {
    displayName: "0809 dip",
    dipEntryEnabled: true,
    dipEntryOpenMin: 0.72,
    dipEntryOpenMax: 0.85,
    minProbability: 0.25,
    maxProbability: 0.4,
    stopLossRiskMultiplier: 1.5,
    // Stripped on purpose: these belong to the portfolio that was copied FROM.
    initialUsdc: 100,
    archived: true,
    automationEnabled: true,
  };

  const copied = chain(source);
  assert.equal(copied.rule.enabled, true, "the dip rule must arrive switched on");
  assert.equal(copied.draft.dipEntryEnabled, true, "and as a real boolean the checkbox reads");
  assert.equal(Math.round(copied.rule.openMin * 100), 72, "with the band it was copied from");
  assert.equal(Math.round(copied.rule.openMax * 100), 85);
  assert.equal(copied.draft.stopLossRiskMultiplier, 1.5, "and every other parameter");

  // What must NOT be carried: a copy starts switched off and unarchived, with no borrowed
  // opening balance.
  assert.equal(copied.draft.automationEnabled, false, "a copy never starts trading by itself");
  assert.equal(copied.draft.archived, undefined);
  assert.equal(copied.draft.initialUsdc, undefined);
});

test("the copy survives a config whose flag came back as a string", () => {
  // The checkbox reads `=== true`, so a payload that says "true" or 1 -- which is what a
  // form post and some older stored configs produce -- would leave it unticked while every
  // other value copied across. That is exactly the shape of the reported fault.
  const rule = new Function("config", `
    const DIP_ENTRY_RULE_DEFAULTS = { openMin: 0.7, openMax: 0.8, buyMin: 0.2, buyMax: 0.3 };
    ${extract(/function dipEntryBound[\s\S]*?\n\}/, "dipEntryBound")}
    ${extract(/function dipEntryRuleFromConfig[\s\S]*?\n\}/, "dipEntryRuleFromConfig")}
    return dipEntryRuleFromConfig(config);
  `);
  for (const value of [true, "true", 1, "1"]) {
    assert.equal(rule({ dipEntryEnabled: value, dipEntryOpenMin: 0.7, dipEntryOpenMax: 0.8 }).enabled, true,
      `dipEntryEnabled ${JSON.stringify(value)} means the rule is on`);
  }
  for (const value of [false, "false", 0, "0", null, undefined, ""]) {
    assert.equal(rule({ dipEntryEnabled: value }).enabled, false,
      `dipEntryEnabled ${JSON.stringify(value)} means the rule is off`);
  }
});

test("saving stops while a field is wrong, and says so", () => {
  const save = /const fieldErrors = portfolioFormFieldErrors\(\);[\s\S]*?\n  clearPortfolioFieldErrors\(\);/.exec(APP);
  assert.ok(save, "the save must consult the validator before it starts");
  assert.match(save[0], /if \(fieldErrors\.length\) \{/);
  assert.match(save[0], /showPortfolioFieldErrors\(fieldErrors\)/, "and mark the fields");
  assert.match(save[0], /return;/, "and not save");
  // Before the pending flag, or a refused save leaves the form stuck saving forever.
  assert.ok(APP.indexOf("const fieldErrors = portfolioFormFieldErrors();")
    < APP.indexOf("state.parameterSavePending = true;"),
    "the check has to run before the save is marked as started");
});
