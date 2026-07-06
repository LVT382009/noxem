#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, '..', 'src', 'index.ts');

const args = process.argv.slice(2);
const proc = spawn('node', ['--import', 'tsx', script, ...args], { stdio: 'inherit' });
proc.on('close', (code) => process.exit(code ?? 0));
