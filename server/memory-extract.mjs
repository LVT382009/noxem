const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || ''; // empty = use LLM
const LLM_API_KEY = process.env.LLM_API_KEY || "";
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

export async function extractMemories({ userMessage, assistantResponse, llmUrl, llmModel }) {
  const url = llmUrl || LLM_URL;
  const model = llmModel || LLM_MODEL;

  const prompt = EXTRACTION_PROMPT
    .split('{{userMessage}}').join((userMessage || '').substring(0, 20000))
    .split('{{assistantResponse}}').join((assistantResponse || '').substring(0, 40000));

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
    temperature: 0.1,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { "Content-Type": "application/json", ...(LLM_API_KEY ? { "Authorization": "Bearer " + LLM_API_KEY } : {}) },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`LLM API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '[]';

  // Extract JSON array from response (non-greedy to handle multiple arrays)
  const matches = [...content.matchAll(/\[[\s\S]*?\]/g)];
  if (!matches.length) return [];
  for (const match of matches) {
    try {
      const memories = JSON.parse(match[0]);
      if (Array.isArray(memories) && memories.length > 0) {
        return memories.filter(m => m.text && m.type).map(m => ({
          text: m.text.trim().substring(0, 1000),
          type: VALID_TYPES.includes(m.type) ? m.type.substring(0, 50) : 'fact',
        }));
      }
    } catch (parseErr) { console.error('[Extract] JSON parse failed:', parseErr.message); }
  }
  return [];
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
  const msg = (userMessage || '');

  // English preference patterns
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

  // English project patterns
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

  // CJK preference patterns
  const cjkPrefPatterns = [
    /(?:喜欢|偏好|最[爱喜]|常用|习惯用)(.{1,20}?)(?:[，。、；\s]|$)/gu,
    /(?:讨厌|不喜欢|不爱)(.{1,20}?)(?:[，。、；\s]|$)/gu,
  ];
  for (const pat of cjkPrefPatterns) {
    const matches = msg.matchAll(pat);
    for (const m of matches) {
      const object = m[1]?.trim();
      if (object && object.length >= 2) {
        memories.push({ text: m[0].substring(0, 200), type: 'preference' });
      }
    }
  }

  // CJK project patterns
  const cjkProjPatterns = [
    /(?:在做|在开发|正在做|开发了?|构建)(.{1,20}?)(?:[，。、；\s]|$)/gu,
  ];
  for (const pat of cjkProjPatterns) {
    const matches = msg.matchAll(pat);
    for (const m of matches) {
      const object = m[1]?.trim();
      if (object && object.length >= 2) {
        memories.push({ text: m[0].substring(0, 200), type: 'project' });
      }
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

// Tier 2: Smarter LLM extraction with 6-type schema
// Better suited for small models like qwen3.6-plus-no-thinking
export async function extractMemoriesLLM({ user_message, assistant_response, alreadyExtracted = [] }) {
  const SMART_EXTRACTION_PROMPT = `You are a memory extraction AI. Analyze the conversation and extract facts worth remembering.

EXTRACTION RULES:
- Extract ONLY from the user's messages — ignore assistant content
- Each memory: complete sentence, 15-80 words, specific and factual
- Categorize into exactly one of: preference, profile, project, fact, event, relationship
- Extract entity (who/what) and attribute (which aspect) when identifiable
- Omit trivial information, greetings, and acknowledgments${alreadyExtracted.length > 0 ? `
Already extracted from this turn (do not re-extract):
${alreadyExtracted.map(t => '- ' + t).join('\n')}` : ''}

Conversation:
USER: {{userMessage}}
ASSISTANT: {{assistantResponse}}

Output ONLY a JSON array: [{"text": "...", "type": "preference", "entity": "user", "attribute": "editor"}]
If no memories worth extracting, output: []`;

  const prompt = SMART_EXTRACTION_PROMPT
    .split('{{userMessage}}').join((user_message || '').substring(0, 20000))
    .split('{{assistantResponse}}').join((assistant_response || '').substring(0, 40000));

  const url = LLM_URL;
  const model = EXTRACTION_MODEL || LLM_MODEL;

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
    temperature: 0.1,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { "Content-Type": "application/json", ...(LLM_API_KEY ? { "Authorization": "Bearer " + LLM_API_KEY } : {}) },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`LLM extraction API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '[]';

    const matches = [...content.matchAll(/\[[\s\S]*?\]/g)];
    if (!matches.length) return [];

    const SMART_TYPES = ['fact', 'preference', 'profile', 'project', 'event', 'relationship'];
    for (const match of matches) {
      try {
        const memories = JSON.parse(match[0]);
        if (Array.isArray(memories) && memories.length > 0) {
          return memories.filter(m => m.text && m.type).map(m => ({
            text: m.text.trim().substring(0, 1000),
            type: SMART_TYPES.includes(m.type) ? m.type : 'fact',
            entity: (m.entity || '').substring(0, 100) || null,
            attribute: (m.attribute || '').substring(0, 100) || null,
          }));
        }
      } catch (parseErr) { console.error('[Extract] JSON parse failed:', parseErr.message); }
    }
    return [];
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('LLM extraction timed out');
    } else {
      console.error('LLM extraction error:', err.message);
    }
    return [];
  }
}