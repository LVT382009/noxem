#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const extensionId = `${manifest.publisher}.${manifest.name}-${manifest.version}`;
const extensionDir = join(homedir(), ".cursor", "extensions", extensionId);

await rm(extensionDir, { force: true, recursive: true });
await mkdir(join(extensionDir, "language-configuration"), { recursive: true });
await mkdir(join(extensionDir, "syntaxes"), { recursive: true });
await mkdir(join(extensionDir, "snippets"), { recursive: true });

await cp("package.json", join(extensionDir, "package.json"));
await cp("README.md", join(extensionDir, "README.md"));
await cp("language-configuration/zero.json", join(extensionDir, "language-configuration", "zero.json"));
await cp("syntaxes/zero.tmLanguage.json", join(extensionDir, "syntaxes", "zero.tmLanguage.json"));
await cp("snippets/zero.json", join(extensionDir, "snippets", "zero.json"));
await writeFile(join(extensionDir, ".installed-by-zero"), new Date().toISOString());

console.log(`Installed ${manifest.publisher}.${manifest.name} to ${extensionDir}`);
console.log("Reload the Cursor window for syntax highlighting to activate.");
