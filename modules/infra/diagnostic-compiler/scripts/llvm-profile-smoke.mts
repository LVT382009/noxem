#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const zero = "bin/zero";
const outDir = ".zero/llvm-profile";
mkdirSync(outDir, { recursive: true });

function runJson(args: string[], options: { allowFailure?: boolean } = {}) {
  try {
    const stdout = execFileSync(zero, args, { encoding: "utf8" });
    return { code: 0, body: JSON.parse(stdout) };
  } catch (error: any) {
    if (!options.allowFailure) throw error;
    return {
      code: error.status ?? error.code ?? 1,
      body: JSON.parse(error.stdout?.toString() ?? "{}"),
    };
  }
}

function llvmOptimizationLevel(profile: string) {
  if (profile === "debug" || profile === "dev") return "-O0";
  if (profile === "fast" || profile === "release-fast") return "-O2";
  if (profile === "audit") return "-O1";
  return "-Oz";
}

function buildRow(id: string, backend: string, profile: string, emit: string, out: string, allowFailure = false) {
  const args = ["build", "--json", "--backend", backend, "--profile", profile, "--emit", emit, "examples/add.0", "--out", out];
  const result = runJson(args, { allowFailure });
  if (result.code !== 0) {
    return {
      id,
      backendFamily: backend,
      profile,
      emit,
      status: "blocked",
      diagnostic: result.body.diagnostics?.[0]?.code ?? "unknown",
      backendBlocker: result.body.diagnostics?.[0]?.backendBlocker ?? null,
    };
  }
  assert.equal(result.body.generatedCBytes, 0);
  assert.equal(result.body.cBridgeFallback ?? false, false);
  assert.equal(result.body.artifactBytes, statSync(result.body.artifactPath).size);
  return {
    id,
    backendFamily: backend,
    profile,
    emit,
    status: "measured",
    elapsedMs: result.body.elapsedMs,
    artifactBytes: result.body.artifactBytes,
    optimizationLevel: backend === "llvm" && emit === "exe"
      ? llvmOptimizationLevel(profile)
      : result.body.profileSemantics?.codegenOptimization ?? null,
    target: result.body.target,
  };
}

const size = runJson(["size", "--json", "--backend", "llvm", "examples/add.0"]).body;
assert.equal(size.targetSupport.backendFamily, "llvm");
assert.equal(size.backendProfile.backendFamily, "llvm");
assert.equal(size.backendProfile.fallbackPolicy, "none");
assert.equal(size.backendProfile.targetTriple, size.targetSupport.llvmTargetTriple);
assert.equal(size.backendProfile.optimizationLevel, "-Oz");
assert.equal(size.objectBackend.backendFamily, "llvm");
assert.equal(size.backendComparison.rows.length, 4);

const check = runJson(["check", "--json", "--backend", "llvm", "examples/add.0"]).body;
const llvmHostReady = check.targetReadiness.ok === true;

const rows = [
  buildRow("direct-debug", "direct", "debug", "exe", join(outDir, "add-direct-debug")),
  buildRow("direct-small", "direct", "small", "exe", join(outDir, "add-direct-small")),
  buildRow("llvm-ir-no-opt", "llvm", "debug", "llvm-ir", join(outDir, "add-debug.ll")),
  buildRow("llvm-ir-optimized-profile", "llvm", "small", "llvm-ir", join(outDir, "add-small.ll")),
];

if (llvmHostReady) {
  rows.push(buildRow("llvm-native-no-opt", "llvm", "debug", "exe", join(outDir, "add-llvm-debug")));
  rows.push(buildRow("llvm-native-optimized", "llvm", "small", "exe", join(outDir, "add-llvm-small")));
} else {
  rows.push(buildRow("llvm-native-no-opt", "llvm", "debug", "exe", join(outDir, "add-llvm-debug"), true));
  rows.push(buildRow("llvm-native-optimized", "llvm", "small", "exe", join(outDir, "add-llvm-small"), true));
}

assert(rows.some((row) => row.id === "direct-debug" && row.status === "measured"));
assert(rows.some((row) => row.id === "direct-small" && row.status === "measured"));
assert(rows.some((row) => row.id === "llvm-ir-no-opt" && row.status === "measured"));
assert(rows.some((row) => row.id === "llvm-ir-optimized-profile" && row.status === "measured"));
if (llvmHostReady) {
  assert(rows.some((row) => row.id === "llvm-native-no-opt" && row.status === "measured"));
  assert(rows.some((row) => row.id === "llvm-native-optimized" && row.status === "measured"));
}

console.log(JSON.stringify({
  schemaVersion: 1,
  kind: "zero-llvm-profile-smoke",
  sourceFile: "examples/add.0",
  llvmHostReady,
  rows,
}, null, 2));
