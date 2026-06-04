/**
 * RLM Bridge — Node.js bridge to the Python RLM sidecar.
 *
 * Spawns rlm_sidecar.py as a long-lived child process.
 * Communication via NDJSON over stdin/stdout.
 * Circuit breaker: after 5 consecutive failures, skip LLM for 60s.
 * Graceful fallback to the caller's single-shot function.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const RLM_ENABLED = process.env.RLM_ENABLED !== 'false';
const RLM_SCRIPT = process.env.RLM_SCRIPT || fileURLToPath(new URL('./rlm_sidecar.py', import.meta.url));
const RLM_MAX_SUB_CALLS = parseInt(process.env.RLM_MAX_SUB_CALLS ?? '5');
const RLM_MAX_TOKENS = parseInt(process.env.RLM_MAX_TOKENS ?? '4096');
const RLM_TIMEOUT_MS = parseInt(process.env.RLM_TIMEOUT_MS ?? '120000');
const RLM_LLM_TIMEOUT = parseInt(process.env.RLM_LLM_TIMEOUT ?? '60');
const CONTEXT_WINDOW = parseInt(process.env.NOXEM_CONTEXT_WINDOW ?? '8192');

// Resolve Python binary: venv python preferred (has httpx/numpy), system python as fallback
const isWin = process.platform === 'win32';
const venvPythonPath = isWin
  ? '../../.hermes/noxem-venv/Scripts/python.exe'
  : '../../.hermes/noxem-venv/bin/python3';
const NOXEM_VENV_PY = fileURLToPath(new URL(venvPythonPath, import.meta.url));
const SYSTEM_PYTHON = isWin ? 'python' : 'python3';
const NOXEM_PY = process.env.NOXEM_PYTHON || (existsSync(NOXEM_VENV_PY) ? NOXEM_VENV_PY : SYSTEM_PYTHON);

// Circuit breaker state
let consecutiveFailures = 0;
const MAX_FAILURES = 5;
let circuitOpenUntil = 0;
let halfOpenProbe = false; // Prevents thundering herd in half-open state

// Child process state
let childProc = null;
let readline = null;
let pendingRequests = new Map(); // id -> { resolve, reject, timer }
let nextId = 1;

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

/**
 * Check if circuit breaker allows a call.
 */
function isCircuitClosed() {
  if (consecutiveFailures < MAX_FAILURES) return true;
  if (Date.now() > circuitOpenUntil) {
    // Half-open: allow only one probe call to avoid thundering herd
    if (halfOpenProbe) return false;
    halfOpenProbe = true;
    return true;
  }
  return false;
}

/**
 * Ensure the Python sidecar process is running.
 */
function ensureProcess() {
  if (childProc && !childProc.killed && childProc.exitCode === null) {
    return; // Already running
  }

  try {
    childProc = spawn(NOXEM_PY, [RLM_SCRIPT], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      LLM_URL: process.env.LLM_URL || process.env.GEMMA_URL || '',
      LLM_MODEL: process.env.LLM_MODEL || process.env.GEMMA_MODEL || '',
      LLM_API_KEY: process.env.LLM_API_KEY || '',
      NOXEM_CONTEXT_WINDOW: process.env.NOXEM_CONTEXT_WINDOW || '',
      VIRTUAL_ENV: process.env.VIRTUAL_ENV || '',
    RLM_LLM_TIMEOUT: process.env.RLM_LLM_TIMEOUT || '',
    },
    });

    readline = createInterface({ input: childProc.stdout });

    readline.on('line', (line) => {
      try {
        const resp = JSON.parse(line);
        // Update circuit breaker state based on sidecar response status
        if (resp.status === 'ok' || resp.status === 'degraded') {
          consecutiveFailures = 0;
          halfOpenProbe = false;
        } else if (resp.status === 'error') {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_FAILURES) {
            circuitOpenUntil = Date.now() + 60_000;
            halfOpenProbe = false;
          }
        }
        const id = resp._reqId;
        if (id && pendingRequests.has(id)) {
          const { resolve, timer } = pendingRequests.get(id);
          clearTimeout(timer);
          pendingRequests.delete(id);
          resolve(resp);
        }
      } catch (err) {
        LOG_DEBUG && console.error('[RLM] Parse error:', err.message);
      }
    });

    childProc.on('error', (err) => {
      LOG_DEBUG && console.error('[RLM] Process error:', err.message);
      // Reject all pending requests
      for (const [id, { reject }] of pendingRequests) {
        reject(new Error(`RLM process error: ${err.message}`));
      }
      pendingRequests.clear();
      childProc = null;
    });

    childProc.on('exit', (code) => {
      LOG_DEBUG && console.error(`[RLM] Process exited with code ${code}`);
      // Reset circuit breaker state - process restart is a clean slate
      consecutiveFailures = 0;
      halfOpenProbe = false;
      // Reject all pending requests
      for (const [id, { reject }] of pendingRequests) {
        reject(new Error(`RLM process exited: code ${code}`));
      }
      pendingRequests.clear();
      childProc = null;
    });

    LOG_DEBUG && console.log(`[RLM] Sidecar process started (python: ${NOXEM_PY})`);
  } catch (err) {
    LOG_DEBUG && console.error('[RLM] Failed to spawn sidecar:', err.message);
    childProc = null;
  }
}

/**
 * Write to child process stdin with backpressure handling.
 * Waits for 'drain' event if the write returns false.
 */
function writeToStdin(data) {
  return new Promise((resolve, reject) => {
    if (!childProc?.stdin?.writable || childProc.stdin.destroyed) return reject(new Error('stdin not writable'));
    const canWrite = childProc.stdin.write(data);
    if (!canWrite) {
      const drainTimeout = setTimeout(() => reject(new Error('stdin drain timeout')), 5000);
      const onDrain = () => { clearTimeout(drainTimeout); cleanup(); resolve(); };
      const onError = (err) => { clearTimeout(drainTimeout); cleanup(); reject(new Error(`stdin error: ${err.message}`)); };
      const onClose = () => { clearTimeout(drainTimeout); cleanup(); reject(new Error('stdin closed')); };
      const cleanup = () => {
        childProc?.stdin?.removeListener('drain', onDrain);
        childProc?.stdin?.removeListener('error', onError);
        childProc?.stdin?.removeListener('close', onClose);
      };
      childProc.stdin.once('drain', onDrain);
      childProc.stdin.once('error', onError);
      childProc.stdin.once('close', onClose);
    } else {
      resolve();
    }
  });
}

/**
 * Send a request to the RLM sidecar and wait for the response.
 * Returns the parsed JSON response or throws on timeout/error.
 */
export async function callRLM({ task, context, timeout = RLM_TIMEOUT_MS }) {
  if (!RLM_ENABLED) {
    return Promise.reject(new Error('RLM disabled'));
  }

  if (!isCircuitClosed()) {
    return Promise.reject(new Error('RLM circuit breaker open'));
  }

  ensureProcess();
  if (!childProc) {
    return Promise.reject(new Error('RLM process not available'));
  }

  const id = nextId++;
  const llmUrl = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
  const llmModel = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';

  const request = {
    _reqId: id,
    task,
    context,
    llmUrl,
    llmModel,
    llmApiKey: process.env.LLM_API_KEY || '',
    config: {
      maxSubCalls: RLM_MAX_SUB_CALLS,
      maxTokensBudget: RLM_MAX_TOKENS,
   contextWindow: parseInt(process.env.NOXEM_CONTEXT_WINDOW ?? '8192'),
    llmTimeout: RLM_LLM_TIMEOUT,
    },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('RLM request timeout'));
    }, timeout);

    pendingRequests.set(id, { resolve, reject, timer });

    writeToStdin(JSON.stringify(request) + '\n').catch(err => {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new Error(`RLM write error: ${err.message}`));
    });
  });
}

/**
 * Call RLM with automatic fallback to a single-shot function.
 * Returns { data, source: 'rlm'|'fallback' }.
 */
export async function callRLMWithFallback({ task, context, fallbackFn, timeout = RLM_TIMEOUT_MS }) {
  try {
    const resp = await callRLM({ task, context, timeout });
    if (resp.status === 'ok' || resp.status === 'degraded') {
      return { data: resp.data, source: 'rlm', metadata: resp.metadata };
    }
    // Error from sidecar - circuit breaker state managed by readline handler
  } catch (err) {
    // Circuit breaker state managed by readline handler (single source of truth)
    LOG_DEBUG && console.error(`[RLM] ${task} failed, using fallback:`, err.message);
  }

  // Fallback to single-shot
  const _fallStart = Date.now();
  const fallbackResult = await fallbackFn();
  return { data: fallbackResult, source: 'fallback', metadata: { calls: 1, tokens: 0, elapsed_ms: Date.now() - _fallStart } };
}

/**
 * Get RLM bridge status (for /health endpoint).
 */
export function getRLMStatus() {
  return {
    enabled: RLM_ENABLED,
    python_bin: NOXEM_PY,
    process_alive: childProc !== null && !childProc.killed && childProc.exitCode === null,
    circuit_open: !isCircuitClosed(),
    consecutive_failures: consecutiveFailures,
    pending_requests: pendingRequests.size,
  };
}

/**
 * Shutdown the RLM sidecar process gracefully.
 */
export function shutdownRLM() {
  const proc = childProc;
  if (proc) {
    childProc = null; // Prevent new calls from using this process
    // Reject all pending requests so callers don't hang forever
    for (const [id, { reject, timer }] of pendingRequests) {
      clearTimeout(timer);
      reject(new Error('RLM shutting down'));
    }
    pendingRequests.clear();
    try {
      // Close stdin first so Python reads EOF and exits its loop cleanly
      proc.stdin.end();
      // On Windows, proc.kill() calls TerminateProcess which kills the entire tree.
      // On Unix, send SIGTERM first, then SIGKILL after 3s if still alive.
      if (process.platform === 'win32') {
        try { proc.kill(); } catch {} // TerminateProcess on Windows
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000).unref();
      }
    } catch {}
  }
}
