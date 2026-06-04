export type { ProactiveSuggestion, ConflictPair, PatternDetection, ProjectProgress, TfidfVector, SuggestionType, SuggestionPriority } from "./types.js";

export { detectConflict, scanForConflicts, formatConflictResults } from "./conflict.js";

export {
  checkAfterMemoryAdd,
  checkAfterGuidePractice,
  checkAfterMemoryRead,
  runFullAnalysis,
  formatSuggestions,
} from "./proactive.js";

export {
  getProjectAnalytics,
  getAllProjectsAnalytics,
  formatProjectProgress,
} from "./session-analytics.js";

export {
  buildVectors,
  findSemanticSimilar,
  findSemanticSimilarPairs,
  semanticSearch,
} from "./semantic.js";
