import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, redactSecrets } from "../../src/memory/privacy.js";

describe("Privacy scanning", () => {
  it("detects OpenAI API keys", () => {
    const text = "Set OPENAI_API_KEY=sk-abc123def456ghi789jkl012mno345";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "OpenAI API key");
  });

  it("detects GitHub tokens", () => {
    const text = "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "GitHub token");
  });

  it("detects private keys", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowI...";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "Private key");
  });

  it("detects MongoDB connection strings", () => {
    const text = "mongodb://admin:password123@localhost:27017/mydb";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "MongoDB connection string");
  });

  it("detects PostgreSQL connection strings", () => {
    const text = "postgresql://user:pass@db.example.com:5432/mydb";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "PostgreSQL connection string");
  });

  it("detects AWS access keys", () => {
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "AWS access key");
  });

  it("detects webhook secrets", () => {
    const text = "whsec_abc123def456ghi789";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "Webhook secret");
  });

  it("detects multiple secrets in one text", () => {
    const text = "Key: sk-abc123def456ghi789jkl012mno345 and token: ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 2);
  });

  it("returns empty array for clean text", () => {
    const text = "This is a normal fragment about React hooks and state management.";
    const matches = scanForSecrets(text);
    assert.equal(matches.length, 0);
  });

  it("does not false-positive on short strings like sk-", () => {
    const text = "The sk- prefix is used for OpenAI keys";
    const matches = scanForSecrets(text);
    assert.equal(matches.length, 0);
  });
});

describe("Redaction", () => {
  it("redacts OpenAI keys with type label", () => {
    const text = "Use key sk-abc123def456ghi789jkl012mno345 for API access";
    const { redacted, found } = redactSecrets(text);
    assert.ok(found.length >= 1);
    assert.ok(!redacted.includes("sk-abc123def456ghi789jkl012mno345"));
    assert.ok(redacted.includes("[REDACTED:OpenAI API key]"));
  });

  it("preserves surrounding text", () => {
    const text = "Fixed webhook using whsec_mysecret123 endpoint";
    const { redacted } = redactSecrets(text);
    assert.ok(redacted.startsWith("Fixed webhook using"));
    assert.ok(redacted.includes("[REDACTED:Webhook secret]"));
    assert.ok(redacted.includes("endpoint"));
  });

  it("redacts multiple secrets", () => {
    const text = "sk-abc123def456ghi789jkl012mno345 and ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const { redacted, found } = redactSecrets(text);
    assert.ok(found.length >= 2);
    assert.ok(!redacted.includes("sk-abc123"));
    assert.ok(!redacted.includes("ghp_"));
  });

  it("returns unchanged text when no secrets", () => {
    const text = "Normal fragment about TypeScript strict mode";
    const { redacted, found } = redactSecrets(text);
    assert.equal(found.length, 0);
    assert.equal(redacted, text);
  });
});
