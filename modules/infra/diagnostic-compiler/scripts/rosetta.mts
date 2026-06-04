#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type RosettaCase = {
  id: string;
  slug: string;
  source: string;
  expectedStdout: string;
  expectedStderr: string;
};

type RosettaManifest = {
  schemaVersion: number;
  corpus: string;
  taskCount: number;
  target: string;
  cases: RosettaCase[];
};

const manifestPath = "benchmarks/rosetta/manifest.json";
const hostTarget = process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : "linux-musl-x64";
const target = readFlag("--target") ?? process.env.ZERO_ROSETTA_TARGET ?? hostTarget;
const outDir = join(".zero/rosetta", target);
const runOutputs = canRunTarget(target);

function readFlag(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function canRunTarget(targetName: string) {
  return (targetName === "linux-musl-x64" && process.platform === "linux" && process.arch === "x64") ||
    (targetName === "darwin-arm64" && process.platform === "darwin" && process.arch === "arm64") ||
    (targetName === "darwin-x64" && process.platform === "darwin" && (process.arch === "x64" || spawnSync("arch", ["-x86_64", "/usr/bin/true"]).status === 0));
}

function expectedObjectEmissionPath(targetName: string) {
  if (targetName === "linux-musl-x64") return "direct-elf64-exe";
  if (targetName === "darwin-arm64") return "direct-macho64-exe";
  if (targetName === "darwin-x64") return "direct-macho-x64-exe";
  fail(`unsupported Rosetta target: ${targetName}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function commandFailure(command: string, args: string[], result: ReturnType<typeof spawnSync>) {
  let diagnostic = "";
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    try {
      diagnostic = JSON.parse(result.stdout).diagnostics?.[0]?.message ?? result.stdout;
    } catch {
      diagnostic = result.stdout;
    }
  }
  if (!diagnostic && typeof result.stderr === "string") diagnostic = result.stderr;
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    diagnostic: diagnostic.trim(),
    error: result.error?.message,
  };
}

function readManifest(): RosettaManifest {
  if (!existsSync(manifestPath)) fail(`missing Rosetta manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RosettaManifest;
  if (manifest.schemaVersion !== 1) fail(`unsupported Rosetta manifest schema: ${manifest.schemaVersion}`);
  if (manifest.corpus !== "zero-rosetta") fail(`unexpected Rosetta corpus: ${manifest.corpus}`);
  if (typeof manifest.target !== "string" || manifest.target.length === 0) fail("Rosetta manifest target must be a string");
  if (!Array.isArray(manifest.cases)) fail("Rosetta manifest cases must be an array");
  if (manifest.taskCount !== manifest.cases.length) fail(`Rosetta manifest taskCount ${manifest.taskCount} does not match ${manifest.cases.length} cases`);
  return manifest;
}

function validateCases(cases: RosettaCase[]) {
  const slugs = new Set<string>();
  const ids = new Set<string>();
  const bad = [];
  for (const entry of cases) {
    if (ids.has(entry.id)) bad.push(`${entry.id}: duplicate id`);
    ids.add(entry.id);
    if (slugs.has(entry.slug)) bad.push(`${entry.id}: duplicate slug ${entry.slug}`);
    slugs.add(entry.slug);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)) bad.push(`${entry.id}: slug is not param-case`);
    if (entry.source !== `benchmarks/rosetta/${entry.slug}.0`) bad.push(`${entry.id}: source must be benchmarks/rosetta/${entry.slug}.0`);
    if (dirname(entry.source) !== "benchmarks/rosetta") bad.push(`${entry.id}: source must be a flat .0 file`);
    if (!existsSync(entry.source)) bad.push(`${entry.id}: missing source ${entry.source}`);
    if (typeof entry.expectedStdout !== "string") bad.push(`${entry.id}: expectedStdout must be a string`);
    if (typeof entry.expectedStderr !== "string") bad.push(`${entry.id}: expectedStderr must be a string`);
  }
  if (bad.length > 0) fail(`Rosetta manifest validation failed:\n${bad.slice(0, 40).join("\n")}`);
}

function buildCase(entry: RosettaCase) {
  const out = join(outDir, entry.slug);
  const args = ["build", "--json", "--emit", "exe", "--target", target, entry.source, "--out", out];
  const result = spawnSync("bin/zero", args, { encoding: "utf8", maxBuffer: 20_000_000 });
  if (result.status !== 0) return { ok: false, out, failure: commandFailure("bin/zero", args, result) };
  const body = JSON.parse(result.stdout);
  if (body.generatedCBytes !== 0) {
    return { ok: false, out, failure: { diagnostic: `expected generatedCBytes=0, got ${body.generatedCBytes}` } };
  }
  const expectedPath = expectedObjectEmissionPath(target);
  if (body.objectBackend?.objectEmission?.path !== expectedPath) {
    return { ok: false, out, failure: { diagnostic: `expected ${expectedPath}, got ${body.objectBackend?.objectEmission?.path ?? "<missing>"}` } };
  }
  return { ok: true, out };
}

function runCase(entry: RosettaCase, out: string) {
  const result = spawnSync(out, [], { encoding: "utf8", timeout: 5000, maxBuffer: 10_000_000 });
  const ok = result.status === 0 &&
    result.signal === null &&
    result.stdout === entry.expectedStdout &&
    result.stderr === entry.expectedStderr;
  if (ok) return null;
  return {
    id: entry.id,
    slug: entry.slug,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    expectedStdout: entry.expectedStdout,
    expectedStderr: entry.expectedStderr,
    error: result.error?.message,
  };
}

const manifest = readManifest();
validateCases(manifest.cases);
mkdirSync(outDir, { recursive: true });

const buildFailures = [];
const runFailures = [];
let built = 0;
let passed = 0;

for (const entry of manifest.cases) {
  const build = buildCase(entry);
  if (!build.ok) {
    buildFailures.push({ id: entry.id, slug: entry.slug, source: entry.source, ...build.failure });
    continue;
  }
  built++;
  if (!runOutputs) continue;
  const runFailure = runCase(entry, build.out);
  if (runFailure) runFailures.push(runFailure);
  else passed++;
}

const summary = {
  schemaVersion: 1,
  corpus: manifest.corpus,
  target,
  total: manifest.cases.length,
  built,
  buildFailures: buildFailures.length,
  runChecked: runOutputs,
  passed,
  runFailures: runFailures.length,
  failures: [...buildFailures, ...runFailures].slice(0, 20),
};

console.log(JSON.stringify(summary, null, 2));
if (buildFailures.length > 0 || runFailures.length > 0) process.exit(1);
