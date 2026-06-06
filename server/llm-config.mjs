/**
 * Central LLM configuration — single source of truth for URL, model, and API key.
 *
 * All Brain 2 modules should import from here instead of reading
 * LLM_URL / LLM_MODEL / GEMMA_URL / GEMMA_MODEL / LLM_API_KEY directly.
 */

const _url = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const _model = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const _apiKey = process.env.LLM_API_KEY || '';

/** Base LLM endpoint URL (includes /v1/chat/completions path). */
export const LLM_URL = _url;

/** LLM model identifier. */
export const LLM_MODEL = _model;

/** LLM API key (may be empty for local endpoints). */
export const LLM_API_KEY = _apiKey;

/** Strip /v1/chat/completions suffix to get the base URL for /v1/models etc. */
export function baseLlmUrl() {
  return _url.replace(/\/v1\/chat\/completions\/?$/i, '').replace(/\/v1\/?$/i, '');
}

/** Maximum prompt body size in bytes (Qwen3.6 has 1M token context — 2MB is safe). */
export const MAX_PROMPT_BYTES = parseInt(process.env.MAX_PROMPT_BYTES || '2000000');
