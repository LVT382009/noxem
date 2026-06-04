import type { MemoryFragment } from "../types.js";
import type { ConflictPair } from "./types.js";
import { logger } from "../logger.js";

const NEGATION_PATTERNS = [
  /\b(not|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|shouldn'?t|can'?t|cannot|never|no\s)\b/i,
  /\b(wrong|incorrect|bad|avoid|never|anti[- ]?pattern|pitfall|mistake|error)\b/i,
  /\b(however|but|instead|rather|conversely|on the contrary|actually)\b/i,
  /\b(deprecated|obsolete|outdated|legacy|removed)\b/i,
];

const CONTRADICTION_SIGNALS = [
  { pattern_a: /\balways\b/i, pattern_b: /\bnever\b/i, weight: 0.9 },
  { pattern_a: /\bgood\b/i, pattern_b: /\bbad\b/i, weight: 0.7 },
  { pattern_a: /\bfast\b/i, pattern_b: /\bslow\b/i, weight: 0.6 },
  { pattern_a: /\bsimple\b/i, pattern_b: /\bcomplex\b/i, weight: 0.6 },
  { pattern_a: /\bbest\b/i, pattern_b: /\bworst\b/i, weight: 0.8 },
  { pattern_a: /\brecommended\b/i, pattern_b: /\bavoid\b/i, weight: 0.8 },
  { pattern_a: /\buse\b/i, pattern_b: /\bdon'?t use\b/i, weight: 0.9 },
  { pattern_a: /\bprefer\b/i, pattern_b: /\bavoid\b/i, weight: 0.8 },
];

function hasNegation(text: string): boolean {
  return NEGATION_PATTERNS.some(p => p.test(text));
}

function extractTopicSignature(text: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "no", "nor", "not", "only", "own",
    "same", "so", "than", "too", "very", "just", "because", "but", "and",
    "or", "if", "while", "about", "up", "it", "its", "this", "that",
    "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
    "him", "his", "she", "her", "they", "them", "their", "what", "which",
    "who", "whom", "am",
  ]);
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  );
}

function topicOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const term of a) {
    if (b.has(term)) overlap++;
  }
  return overlap / Math.min(a.size, b.size);
}

function detectContradictionSignals(textA: string, textB: string): number {
  let maxScore = 0;
  for (const signal of CONTRADICTION_SIGNALS) {
    const aHas = signal.pattern_a.test(textA) && signal.pattern_b.test(textB);
    const bHas = signal.pattern_b.test(textA) && signal.pattern_a.test(textB);
    if (aHas || bHas) {
      maxScore = Math.max(maxScore, signal.weight);
    }
  }
  return maxScore;
}

export function detectConflict(
  newFragment: MemoryFragment,
  existingFragments: MemoryFragment[],
  topN = 3
): ConflictPair[] {
  const conflicts: ConflictPair[] = [];
  const newTopic = extractTopicSignature(newFragment.fragment);
  const newHasNegation = hasNegation(newFragment.fragment);

  for (const existing of existingFragments) {
    if (existing.id === newFragment.id) continue;

    const overlap = topicOverlap(newTopic, extractTopicSignature(existing.fragment));
    if (overlap < 0.3) continue;

    const existingHasNegation = hasNegation(existing.fragment);

    let conflictScore = 0;

    if (newHasNegation !== existingHasNegation && overlap >= 0.5) {
      conflictScore = 0.6 + (overlap - 0.5) * 0.4;
    }

    const signalScore = detectContradictionSignals(newFragment.fragment, existing.fragment);
    conflictScore = Math.max(conflictScore, signalScore * overlap);

    if (conflictScore >= 0.4) {
      conflicts.push({
        memory_a_id: newFragment.id,
        memory_a_title: newFragment.title,
        memory_b_id: existing.id,
        memory_b_title: existing.title,
        reason: newHasNegation !== existingHasNegation
          ? "Opposing sentiment on same topic"
          : "Contradiction signals detected",
        overlap_score: Math.round(conflictScore * 100) / 100,
      });
    }
  }

  conflicts.sort((a, b) => b.overlap_score - a.overlap_score);
  logger.flow("conflict", "detected", { new_id: newFragment.id, conflict_count: conflicts.length });
  return conflicts.slice(0, topN);
}

export function scanForConflicts(allFragments: MemoryFragment[]): ConflictPair[] {
  const conflicts: ConflictPair[] = [];
  const signatures = new Map<string, Set<string>>();
  const negationMap = new Map<string, boolean>();

  for (const frag of allFragments) {
    signatures.set(frag.id, extractTopicSignature(frag.fragment));
    negationMap.set(frag.id, hasNegation(frag.fragment));
  }

  for (let i = 0; i < allFragments.length; i++) {
    for (let j = i + 1; j < allFragments.length; j++) {
      const a = allFragments[i];
      const b = allFragments[j];
      const overlap = topicOverlap(signatures.get(a.id)!, signatures.get(b.id)!);
      if (overlap < 0.4) continue;

      const aNeg = negationMap.get(a.id)!;
      const bNeg = negationMap.get(b.id)!;

      let conflictScore = 0;
      if (aNeg !== bNeg && overlap >= 0.5) {
        conflictScore = 0.5 + (overlap - 0.5) * 0.5;
      }

      const signalScore = detectContradictionSignals(a.fragment, b.fragment);
      conflictScore = Math.max(conflictScore, signalScore * overlap);

      if (conflictScore >= 0.4) {
        conflicts.push({
          memory_a_id: a.id,
          memory_a_title: a.title,
          memory_b_id: b.id,
          memory_b_title: b.title,
          reason: aNeg !== bNeg
            ? "Opposing sentiment on same topic"
            : "Contradiction signals detected",
          overlap_score: Math.round(conflictScore * 100) / 100,
        });
      }
    }
  }

  conflicts.sort((a, b) => b.overlap_score - a.overlap_score);
  logger.flow("conflict", "full_scan", { fragment_count: allFragments.length, conflict_count: conflicts.length });
  return conflicts;
}

export function formatConflictResults(conflicts: ConflictPair[]): string {
  if (conflicts.length === 0) return "No conflicts detected.";

  let output = `=== CONFLICT DETECTION ===\nFound ${conflicts.length} potential conflict(s):\n\n`;
  for (const c of conflicts) {
    output += `  [${c.overlap_score}] [${c.memory_a_id}] "${c.memory_a_title}" vs [${c.memory_b_id}] "${c.memory_b_title}"\n`;
    output += `    Reason: ${c.reason}\n`;
  }
  output += `\nUse memory_relate with type "contradicts" to link these.`;
  return output;
}
