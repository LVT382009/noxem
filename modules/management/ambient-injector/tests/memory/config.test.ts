import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import { loadConfig, resetConfig, setConfigDir, estimateTokens } from "../../src/memory/config.js";
import type { LemmaConfig } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-cfg-"));
  setConfigDir(TMPDIR);
  resetConfig();
});

afterEach(() => {
  resetConfig();
  setConfigDir(null as any);
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("loadConfig — defaults", () => {
  test("returns defaults when no config file exists", () => {
    const config: LemmaConfig = loadConfig();
    assert.equal(config.token_budget.full_content, 5000);
    assert.equal(config.token_budget.summary_index, 1000);
    assert.equal(config.injection.max_full_content_fragments, 15);
    assert.equal(config.virtual_session.timeout_minutes, 30);
  });

  test("caches config on subsequent calls", () => {
    const first: LemmaConfig = loadConfig();
    const second: LemmaConfig = loadConfig();
    assert.strictEqual(first, second);
  });
});

describe("loadConfig — deep merge with user config", () => {
  test("merges partial user config with defaults", () => {
    const userConfig = {
      token_budget: { full_content: 5000 },
      virtual_session: { timeout_minutes: 60 },
    };
    fs.writeFileSync(
      path.join(TMPDIR, "config.json"),
      JSON.stringify(userConfig),
      "utf-8"
    );

    resetConfig();
    const config: LemmaConfig = loadConfig();
    assert.equal(config.token_budget.full_content, 5000);
    assert.equal(config.token_budget.summary_index, 1000);
    assert.equal(config.injection.max_full_content_fragments, 15);
    assert.equal(config.virtual_session.timeout_minutes, 60);
  });

  test("adds new keys from user config", () => {
    const userConfig = {
      custom_section: { enabled: true, value: 42 },
    };
    fs.writeFileSync(
      path.join(TMPDIR, "config.json"),
      JSON.stringify(userConfig),
      "utf-8"
    );

    resetConfig();
    const config: LemmaConfig & { custom_section: { enabled: boolean; value: number } } = loadConfig() as any;
    assert.equal(config.custom_section.enabled, true);
    assert.equal(config.custom_section.value, 42);
    assert.equal(config.token_budget.full_content, 5000);
  });

  test("falls back to defaults when config file has invalid JSON", () => {
    fs.writeFileSync(
      path.join(TMPDIR, "config.json"),
      "NOT VALID JSON{{{{",
      "utf-8"
    );

    resetConfig();
    const config: LemmaConfig = loadConfig();
    assert.equal(config.token_budget.full_content, 5000);
  });
});

describe("estimateTokens", () => {
  test("estimates tokens as ceil(length / 3.5)", () => {
    assert.equal(estimateTokens("hello world"), Math.ceil(11 / 3.5));
  });

  test("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  test("returns 0 for null", () => {
    assert.equal(estimateTokens(null), 0);
  });

  test("returns 0 for undefined", () => {
    assert.equal(estimateTokens(undefined), 0);
  });

  test("handles single character", () => {
    assert.equal(estimateTokens("a"), 1);
  });

  test("handles long text", () => {
    const text: string = "a".repeat(350);
    assert.equal(estimateTokens(text), 100);
  });
});

describe("resetConfig", () => {
  test("clears cached config so next load re-reads file", () => {
    const first: LemmaConfig = loadConfig();
    assert.equal(first.token_budget.full_content, 5000);

    const userConfig = { token_budget: { full_content: 9999 } };
    fs.writeFileSync(
      path.join(TMPDIR, "config.json"),
      JSON.stringify(userConfig),
      "utf-8"
    );

    resetConfig();
    const second: LemmaConfig = loadConfig();
    assert.equal(second.token_budget.full_content, 9999);
    assert.ok(first !== second);
  });
});
