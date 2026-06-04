export type SuggestionType = "distill" | "merge" | "conflict" | "archive" | "refine" | "relate" | "pattern";

export type SuggestionPriority = "high" | "medium" | "low";

export interface ProactiveSuggestion {
  type: SuggestionType;
  priority: SuggestionPriority;
  message: string;
  suggested_action?: string;
}

export interface ConflictPair {
  memory_a_id: string;
  memory_a_title: string;
  memory_b_id: string;
  memory_b_title: string;
  reason: string;
  overlap_score: number;
}

export interface PatternDetection {
  pattern_text: string;
  occurrences: number;
  memory_ids: string[];
  suggested_guide?: string;
  suggested_category?: string;
}

export interface ProjectProgress {
  project: string;
  total_sessions: number;
  total_memories: number;
  total_guides: number;
  knowledge_growth_rate: number;
  skill_coverage: Array<{ category: string; count: number; trend: "growing" | "stable" | "declining" }>;
  recent_insights: string[];
  health_score: number;
}

export interface TfidfVector {
  memory_id: string;
  terms: Map<string, number>;
  norm: number;
}
