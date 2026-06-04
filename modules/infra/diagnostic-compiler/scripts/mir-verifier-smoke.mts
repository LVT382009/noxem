import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cc = process.env.CC ?? "cc";
const out = `/tmp/zero-mir-verifier-smoke-${process.pid}`;

try {
  await execFileAsync(cc, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-I",
    "native/zero-c/include",
    "-I",
    "native/zero-c/src",
    "native/zero-c/src/mir_verify.c",
    "native/zero-c/tests/mir_verify_smoke.c",
    "-o",
    out,
  ]);
  const result = await execFileAsync(out);
  if (!result.stdout.includes("mir verifier smoke ok")) {
    throw new Error(`unexpected MIR verifier smoke output: ${result.stdout}`);
  }
} finally {
  await rm(out, { force: true });
}
