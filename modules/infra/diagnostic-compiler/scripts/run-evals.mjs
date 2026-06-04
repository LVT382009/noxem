#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

run(node, [
  resolve(repoRoot, "evals", "node_modules", "typescript", "bin", "tsc"),
  "-p",
  resolve(repoRoot, "evals", "tsconfig.json"),
]);
run(node, [
  resolve(repoRoot, "evals", "dist", "run.js"),
  ...process.argv.slice(2),
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`${command} terminated by ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
