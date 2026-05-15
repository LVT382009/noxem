const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || ''; // empty = use LLM

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
    .replace('{{userMessage}}', (userMessage || '').substring(0, 2000))
    .replace('{{assistantResponse}}', (assistantResponse || '').substring(0, 4000));

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
    temperature: 0.1,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`LLM API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '[]';

    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const memories = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(memories)) return [];

    return memories.filter(m => m.text && m.type).map(m => ({
      text: m.text.trim().substring(0, 500),
      type: m.type.substring(0, 50),
    }));
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