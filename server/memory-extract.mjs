const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '60000');
import { llmFetch } from './llm-fetch.mjs';
import { LLM_URL, LLM_MODEL } from './llm-config.mjs';
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || ''; // empty = use LLM
const VALID_TYPES = ['general', 'fact', 'preference', 'profile', 'project', 'goal', 'pattern', 'entity', 'event', 'issue', 'setup', 'learning', 'request', 'reflection', 'summary'];

const EXTRACTION_PROMPT = `You are a memory extraction AI. Analyze the conversation below and extract factual memories that the AI agent should remember for future conversations.

Rules:
- Extract ONLY factual, non-obvious information
- Each memory must be a complete sentence
- Categorize as: preference, fact, entity, event, pattern, or goal
- Omit obvious/generic information
- Return ONLY a JSON array, nothing else

Example output:
[
{"text": "User prefers Python over JavaScript for backend development.", "type": "preference"},
{"text": "User is building a Hermes Agent memory system with local AI.", "type": "project"},
{"text": "User's name is Tam.", "type": "entity"}
]

Conversation:
USER: {{userMessage}}
ASSISTANT: {{assistantResponse}}

Memories:`;

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
    .split('{{userMessage}}').join((userMessage || '').substring(0, 2000))
    .split('{{assistantResponse}}').join((assistantResponse || '').substring(0, 4000));

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
    temperature: 0.1,
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
      if (Array.isArray(memories) && memories.length > 0) {
        return memories.filter(m => m.text && m.type).map(m => ({
          text: m.text.trim().substring(0, 500),
          type: VALID_TYPES.includes(m.type) ? m.type.substring(0, 50) : 'fact',
        }));
      }
    } catch {}
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
