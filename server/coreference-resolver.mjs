// v2: Rule-based English coreference resolver (ported from M-Flow patterns)
// Resolves pronouns to antecedents from session memory context

const PRONOUNS = /\b(he|she|it|they|this|that|these|those|his|her|its|their|him|them)\b/gi;

// Entity candidate extraction: capitalized words that could be antecedents
const ENTITY_RE = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/g;

/**
 * Resolve coreferences in text using session memories as context.
 * @param {string} text - Input text with possible pronouns
 * @param {Array} sessionMemories - Recent memories from same session for antecedent lookup
 * @returns {string} Text with pronouns replaced by antecedents where resolved
 */
export function resolveCoreference(text, sessionMemories = []) {
  if (!text || !sessionMemories.length) return text;

  // Build entity index from session memories (most recent first)
  const entityIndex = buildEntityIndex(sessionMemories);
  if (entityIndex.size === 0) return text;

  // Replace pronouns with resolved antecedents
 // Replace pronouns right-to-left to avoid offset drift
 const matches = [...text.matchAll(PRONOUNS)];
 let result = text;
 for (let i = matches.length - 1; i >= 0; i--) {
 const [match, pronoun] = matches[i];
 const offset = matches[i].index;
 const resolved = resolvePronoun(pronoun, offset, text, entityIndex);
 if (resolved) {
 result = result.substring(0, offset) + resolved + result.substring(offset + match.length);
 }
 }
 return result;
}

function buildEntityIndex(memories) {
  const index = new Map(); // lowercase entity -> { name, count, lastSeen }
  for (const m of memories) {
    if (m.entity) {
      const key = m.entity.toLowerCase();
      const existing = index.get(key);
      if (existing) {
        existing.count++;
      } else {
        index.set(key, { name: m.entity, count: 1 });
      }
    }
    // Also extract capitalized names from text
    const names = m.text?.match(ENTITY_RE) || [];
    for (const name of names) {
      const key = name.toLowerCase();
      if (key.length < 2 || PRONOUN_LIST.has(key)) continue;
      const existing = index.get(key);
      if (existing) {
        existing.count++;
      } else {
        index.set(key, { name, count: 1 });
      }
    }
  }
  return index;
}

const PRONOUN_LIST = new Set([
  'he', 'she', 'it', 'they', 'this', 'that', 'these', 'those',
  'his', 'her', 'its', 'their', 'him', 'them',
  'the', 'and', 'but', 'for', 'not', 'yes', 'no',
]);

const GENDER_MAP = {
  he: 'male', his: 'male', him: 'male',
  she: 'female', her: 'female',
  it: 'neuter', its: 'neuter',
  they: 'plural', their: 'plural', them: 'plural',
  this: 'demonstrative', that: 'demonstrative',
  these: 'demonstrative', those: 'demonstrative',
};

function resolvePronoun(pronoun, offset, text, entityIndex) {
  const pLower = pronoun.toLowerCase();
  const gender = GENDER_MAP[pLower];

  // For demonstrative pronouns (this/that), try to find nearest preceding entity
  if (gender === 'demonstrative') {
    return findNearestEntity(offset, text, entityIndex);
  }

  // For personal pronouns, find the most likely antecedent by gender + frequency
  let bestEntity = null;
  let bestScore = 0;

  for (const [, info] of entityIndex) {
    const entityGender = guessGender(info.name);
    // Filter by gender: skip entities that clearly don't match
    if (gender === 'female' && entityGender === 'male') continue;
    if (gender === 'male' && entityGender === 'female') continue;
    if (gender === 'neuter' && entityGender === 'male') continue;
    if (gender === 'neuter' && entityGender === 'female') continue;
    if (gender === 'male' && entityGender === 'neuter') continue;
    if (gender === 'female' && entityGender === 'neuter') continue;

    let score = info.count;
    // Prefer entities mentioned in preceding text
    const preceding = text.substring(Math.max(0, offset - 200), offset);
    if (preceding.toLowerCase().includes(info.name.toLowerCase())) {
      score += 5;
    }
    // Boost entities whose gender matches the pronoun
    if (entityGender === gender) score += 3;
    if (score > bestScore) {
      bestScore = score;
      bestEntity = info.name;
    }
  }

  return bestEntity;
}

// Simple gender heuristic for entity names
const FEMALE_ENDINGS = /^(?:[a-zA-Z]+[aeixy]|Maria|Anna|Sarah|Lisa|Emma|Kate|Jane|Mary|Julia|Laura|Emily|Olivia|Sophia|Alice|Rose|Grace|Helen|Diana|Clara|Elena|Nina|Rosa|Tina|Julia|Sara|Lena|Eva|Mia|Ana)$/i;
const MALE_ENDINGS = /^(?:[a-zA-Z]+[ousnrkd]|James|John|Robert|Michael|David|William|Richard|Thomas|Mark|Steve|Paul|Daniel|Chris|Peter|Alex|Kevin|Brian|Ryan|Nick|Matt|Ryan)$/i;
function guessGender(name) {
  // Technical terms (Redis, PostgreSQL, Docker, etc.) are neuter — check FIRST
  if (/^(?:Redis|PostgreSQL|MySQL|MongoDB|Docker|Kubernetes|nginx|Node|Python|Java|Ruby|Elastic|Kafka|RabbitMQ|SQLite|Mongo|Supabase)/i.test(name)) return 'neuter';
  if (FEMALE_ENDINGS.test(name)) return 'female';
  if (MALE_ENDINGS.test(name)) return 'male';
  return 'unknown';
}

function findNearestEntity(offset, text, entityIndex) {
  const preceding = text.substring(Math.max(0, offset - 150), offset);
  let bestEntity = null;
  let bestPos = -1;

  for (const [, info] of entityIndex) {
    const idx = preceding.toLowerCase().lastIndexOf(info.name.toLowerCase());
    if (idx > bestPos) {
      bestPos = idx;
      bestEntity = info.name;
    }
  }
  return bestEntity;
}

/**
 * Batch resolve coreferences for multiple texts sharing same session context.
 * @param {string[]} texts - Array of texts to resolve
 * @param {Array} sessionMemories - Shared session context
 * @returns {string[]} Array of resolved texts
 */
export function resolveCoreferencesBatch(texts, sessionMemories = []) {
  return texts.map(t => resolveCoreference(t, sessionMemories));
}
