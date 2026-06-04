#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const zero = "bin/zero";
const outDir = ".zero/stdlib-target-matrix";
const fixtures = [
  "conformance/native/pass/stdlib-target-neutral.0",
  "conformance/native/pass/direct-checksum-helpers.0",
];
const artifactBudgetBytes = 120_000;
const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-musl-arm64",
  "linux-musl-x64",
  "linux-x64",
  "win32-arm64.exe",
  "win32-x64.exe",
];

type MatrixRow = {
  fixture: string;
  target: string;
  ok: boolean;
  artifactPath: string;
  artifactBytes: number;
  generatedCBytes: number;
  directObjectEmitter?: string;
  diagnostic?: string;
};

await mkdir(outDir, { recursive: true });

async function json(args: string[]) {
  try {
    const result = await execFileAsync(zero, args, { maxBuffer: 1024 * 1024 * 4 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, body: JSON.parse(result.stdout) };
  } catch (error) {
    const stdout = error.stdout?.toString() ?? "";
    let body = null;
    try {
      body = JSON.parse(stdout);
    } catch {
      body = null;
    }
    return {
      code: error.code ?? error.status ?? 1,
      stdout,
      stderr: error.stderr?.toString() ?? "",
      body,
    };
  }
}

const rows: MatrixRow[] = [];
for (const fixture of fixtures) {
  const stem = fixture.split("/").pop()?.replace(/\.0$/, "") ?? "fixture";
  for (const target of targets) {
    const ext = target.includes("win32") ? ".obj" : ".o";
    const artifactPath = join(outDir, `${stem}-${target}${ext}`);
    const result = await json(["build", "--json", "--emit", "obj", "--target", target, fixture, "--out", artifactPath]);
    const diagnostic = result.body?.diagnostics?.[0];
    const row: MatrixRow = {
      fixture,
      target,
      ok: result.code === 0 && result.body?.ok !== false,
      artifactPath,
      artifactBytes: result.body?.artifactBytes ?? 0,
      generatedCBytes: result.body?.generatedCBytes ?? -1,
      directObjectEmitter: result.body?.releaseTargetContract?.directObjectEmitter,
      diagnostic: diagnostic ? `${diagnostic.code}: ${diagnostic.message}` : undefined,
    };
    rows.push(row);
    assert.equal(row.ok, true, `${fixture} ${target} failed: ${row.diagnostic ?? result.stderr}`);
    assert.equal(row.generatedCBytes, 0, `${fixture} ${target} used generated C fallback`);
    assert.ok(row.artifactBytes > 0, `${fixture} ${target} did not produce an object artifact`);
    assert.ok(row.artifactBytes <= artifactBudgetBytes, `${fixture} ${target} object artifact exceeded ${artifactBudgetBytes} bytes`);
  }
}

for (const fixture of fixtures) {
  const hostRun = await execFileAsync(zero, ["run", fixture]);
  assert.equal(hostRun.stdout, "", `${fixture} should run silently`);
}

const report = {
  schemaVersion: 1,
  ok: rows.every((row) => row.ok),
  fixtures,
  artifactBudgetBytes,
  targets: rows,
};

await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log("stdlib target matrix ok");
