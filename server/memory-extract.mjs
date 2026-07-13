const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '60000');
import { llmFetch } from './llm-fetch.mjs';
import { LLM_URL, LLM_MODEL } from './llm-config.mjs';
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || ''; // empty = use LLM
const VALID_TYPES = ['general', 'fact', 'preference', 'profile', 'project', 'goal', 'pattern', 'entity', 'event', 'issue', 'setup', 'learning', 'request', 'reflection', 'summary'];

const EXTRACTION_PROMPT = `You are a memory extraction AI. Analyze the conversation below and extract factual memories that the AI agent should remember for future conversations.

CRITICAL RULES:
- Extract ONLY information actually stated in the conversation. NEVER hallucinate or infer beyond what is written.
- Preserve VERBATIM specifics: exact numbers (e.g. "250ms", "Flask 2.3.1"), exact dates (e.g. "March 29, 2024"), exact identifiers (e.g. "pbkdf2", "UNIQUE constraint", "Flask-WTF", "Confluence", "Matplotlib"). Do NOT paraphrase or round these.
- For EVERY memory you MUST provide a "source_quote": a short VERBATIM phrase copied from the conversation that proves this memory (anti-hallucination). If you cannot find a verbatim quote, do NOT emit the memory.
- Capture DENIALS and contradictions explicitly (e.g. "User decided AGAINST microservices for v1.0", "User never wrote Flask routes", "User did not integrate Flask-Login"). Set "contradiction_with" to the text of the opposing memory if one exists in the same batch.
- Extract BOTH sides of any contradiction as separate memories and cross-reference them via "contradiction_with".
- Enumerate EVERY distinct fact/event/preference; do not collapse multiple facts into one memory.
- Categorize type as: preference, fact, entity, event, pattern, goal, project, setup, issue, reflection, summary
- Each memory text must be a complete sentence
- Return ONLY a JSON array, nothing else (no markdown fences, no prose)

Example output:
[
{"text": "User prefers simple, minimal-dependency architectures to keep the app lightweight.", "type": "preference", "source_quote": "keep it lightweight, minimal deps", "entity": "user", "attribute": "architecture_preference", "value": "minimal dependencies", "event_date": null, "order_index": 1, "contradiction_with": null},
{"text": "Sprint 1 ends March 29, 2024, focusing on user registration and login.", "type": "event", "source_quote": "first sprint ends March 29", "entity": "sprint_1", "attribute": "end_date", "value": "2024-03-29", "event_date": "2024-03-29", "order_index": 5, "contradiction_with": null}
]

Conversation:
USER: {{userMessage}}
ASSISTANT: {{assistantResponse}}

Memories (JSON array; each item: text, type, source_quote, entity, attribute, value, event_date, order_index, contradiction_with):`;

// Extract a balanced JSON array from LLM output (handles nested brackets)
function extractBalancedArray(text) {
  // Strip CR to handle CRLF line endings on Windows
  // (bare \r is invalid in JSON strings per RFC 8259 section 7)
  text = text.replace(/\r/g, '');
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inStr) { escape = !escape; continue; }
    if (ch === '"' && inStr) { if (!escape) { inStr = false; } escape = false; continue; }
    if (ch === '"' && !inStr) { inStr = true; escape = false; continue; }
    escape = false;
    if (inStr) continue;
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth === 0) return text.substring(start, i + 1); }
  }
  return null;
}

export async function extractMemories({ userMessage, assistantResponse, llmUrl, llmModel }) {
  const url = llmUrl || LLM_URL;
  const model = llmModel || LLM_MODEL;

  const prompt = EXTRACTION_PROMPT
    // FIX (BEAM bench): 2000→24000 chars. Was dropping ~93% of long-conversation
    // specifics (128K-token BEAM corpus). Assistant side 4000→24000 for symmetry.
    .split('{{userMessage}}').join((userMessage || '').substring(0, 24000))
    .split('{{assistantResponse}}').join((assistantResponse || '').substring(0, 24000));

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    // FIX (BEAM bench): 512→2500 (5x) so enumerations not truncated; temp 0.1→0
    // for deterministic verbatim preservation; timeout already 60s via EXTRACT_TIMEOUT_MS.
    max_tokens: 2500,
    temperature: 0,
  });

  try {
    const res = await llmFetch(url, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`LLM API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '[]';

    // Extract JSON array — find balanced brackets to handle nested content
    const arrayStr = extractBalancedArray(content);
    if (!arrayStr) return [];
    try {
      const memories = JSON.parse(arrayStr);
      // FIX (audit Trail): when the LLM returns "[]" (nothing extractable from trivial
      // turns like "hi"/"thanks") or a non-array, return [] explicitly. Previously this only
      // returned when length>0, falling through to an implicit `return undefined` on empty
      // arrays — which then crashed the /memory/extract handler at `!memories.length` (TypeError
      // → HTTP 500). Semantics now: non-array or empty -> []; unparseable -> [] (catch); valid
      // -> filtered/mapped memories.
      if (!Array.isArray(memories)) return [];
      // FIX (BEAM bench): emit the structured fields the prompt now asks for
      // (entity/attribute/value/event_date/order_index/contradiction_with) plus the
      // REQUIRED source_quote (anti-hallucination). The store layer maps these onto
      // the new schema columns (see memory-store.mjs). order_index falls back to array
      // position so ordering is always present.
      return memories.filter(m => m.text && m.type).map((m, i) => ({
        text: m.text.trim().substring(0, 500),
        type: VALID_TYPES.includes(m.type) ? m.type.substring(0, 50) : 'fact',
        source_quote: (m.source_quote || '').toString().trim().substring(0, 500),
        source_turn_id: m.source_turn_id ? String(m.source_turn_id).substring(0, 100) : null,
        entity: m.entity ? String(m.entity).substring(0, 200) : null,
        attribute: m.attribute ? String(m.attribute).substring(0, 200) : null,
        value: m.value != null ? String(m.value).substring(0, 500) : null,
        event_date: m.event_date ? String(m.event_date).substring(0, 40) : null,
        order_index: Number.isFinite(Number(m.order_index)) ? Number(m.order_index) : i,
        contradiction_with: m.contradiction_with ? String(m.contradiction_with).substring(0, 200) : null,
      }));
    } catch {
      return [];
    }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('Extraction timed out (LLM too slow)');
    } else {
      console.error('Extraction error:', err.message);
    }
    return [];
  }
}

// Lightweight extraction without LLM (rule-based fallback)
export function extractMemoriesSimple({ userMessage, assistantResponse }) {
  const memories = [];
  const msg = (userMessage || '') + ' ' + (assistantResponse || '');

  // Preference patterns
  const prefPatterns = [
    /I (?:prefer|like|love|enjoy|hate|dislike) (\w+(?: \w+){0,5})/gi,
    /my favorite (\w+(?: \w+){0,5}) is (\w+)/gi,
    /I use (\w+(?: \w+){0,5}) for/gi,
  ];
  for (const pat of prefPatterns) {
    const matches = msg.matchAll(pat);
    for (const m of matches) {
      memories.push({ text: `User prefers/mentions: ${m[0].substring(0, 200)}`, type: 'preference' });
    }
  }

  // Project patterns
  const projPatterns = [
    /I(?:'m| am) (?:building|working on|creating|making) (\w+(?: \w+){0,5})/gi,
    /my (?:project|app|tool) (\w+(?: \w+){0,3})/gi,
  ];
  for (const pat of projPatterns) {
    const matches = msg.matchAll(pat);
    for (const m of matches) {
      memories.push({ text: `User project mention: ${m[0].substring(0, 200)}`, type: 'project' });
    }
  }

  // Deduplicate by text
  const seen = new Set();
  return memories.filter(m => {
    if (seen.has(m.text)) return false;
    seen.add(m.text);
    return true;
  });
}
