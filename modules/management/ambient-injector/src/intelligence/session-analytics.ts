import type { LemmaDB } from "../db/database.js";
import type { ProjectProgress } from "./types.js";
import { logger } from "../logger.js";

interface SessionRow {
  id: string;
  task_type: string;
  outcome: string;
  technologies: string;
  project: string;
  started_at: string;
  ended_at: string;
}

interface MemoryRow {
  legacy_id: string;
  title: string;
  type: string;
  project: string | null;
  confidence: number;
  created_at: string;
}

interface GuideRow {
  guide: string;
  category: string;
  usage_count: number;
  success_count: number;
  failure_count: number;
  contexts?: string;
}

export function getProjectAnalytics(
  db: LemmaDB,
  project: string
): ProjectProgress {
  const projectLower = project.toLowerCase();

  const sessions = db.prepareCached(
    `SELECT id, task_type, outcome, technologies, project, started_at, ended_at
     FROM sessions WHERE lower(project) = ? ORDER BY started_at DESC`
  ).all(projectLower) as SessionRow[];

  const memories = db.prepareCached(
    `SELECT legacy_id, title, type, project, confidence, created_at
     FROM memories WHERE lower(project) = ? ORDER BY created_at DESC`
  ).all(projectLower) as MemoryRow[];

  const guides = db.prepareCached(
    `SELECT g.guide, g.category, g.usage_count, g.success_count, g.failure_count,
     (SELECT group_concat(gc.context) FROM guide_contexts gc WHERE gc.guide_id = g.id) as contexts
     FROM guides g ORDER BY g.usage_count DESC`
  ).all() as GuideRow[];

  const knowledgeGrowthRate = calculateGrowthRate(memories);

  const skillCoverage = calculateSkillCoverage(guides, sessions);

  const recentInsights = extractRecentInsights(memories, sessions);

  const healthScore = calculateHealthScore(sessions, memories, guides);

  const progress: ProjectProgress = {
    project,
    total_sessions: sessions.length,
    total_memories: memories.length,
    total_guides: guides.length,
    knowledge_growth_rate: knowledgeGrowthRate,
    skill_coverage: skillCoverage,
    recent_insights: recentInsights,
    health_score: healthScore,
  };

  logger.flow("analytics", "project", { project, sessions: sessions.length, memories: memories.length, health: healthScore });
  return progress;
}

export function getAllProjectsAnalytics(db: LemmaDB): ProjectProgress[] {
  const projects = db.prepareCached(
    `SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL
     UNION
     SELECT DISTINCT project FROM memories WHERE project IS NOT NULL`
  ).all() as { project: string }[];

  return projects
    .filter(p => p.project)
    .map(p => getProjectAnalytics(db, p.project));
}

function calculateGrowthRate(memories: MemoryRow[]): number {
  if (memories.length < 2) return 0;

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86400000;
  const fourteenDaysAgo = now - 14 * 86400000;

  const recentCount = memories.filter(m => new Date(m.created_at).getTime() > sevenDaysAgo).length;
  const olderCount = memories.filter(m => {
    const t = new Date(m.created_at).getTime();
    return t > fourteenDaysAgo && t <= sevenDaysAgo;
  }).length;

  if (olderCount === 0) return recentCount > 0 ? 1.0 : 0;
  return Math.round((recentCount / olderCount) * 100) / 100;
}

function calculateSkillCoverage(
  guides: GuideRow[],
  sessions: SessionRow[]
): Array<{ category: string; count: number; trend: "growing" | "stable" | "declining" }> {
  const categoryMap = new Map<string, { total: number; recent: number }>();

  for (const g of guides) {
    const cat = g.category || "uncategorized";
    const entry = categoryMap.get(cat) || { total: 0, recent: 0 };
    entry.total += g.usage_count;
    categoryMap.set(cat, entry);
  }

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86400000;

  for (const session of sessions) {
    if (new Date(session.started_at).getTime() > sevenDaysAgo) {
      try {
        const techs = JSON.parse(session.technologies || "[]") as string[];
        for (const tech of techs) {
          const guide = guides.find(g => {
            if (g.guide === tech) return true;
            const ctxList = g.contexts ? g.contexts.split(",") : [];
            return ctxList.some(c => c.trim() === tech);
          });
          if (guide) {
            const cat = guide.category || "uncategorized";
            const entry = categoryMap.get(cat);
            if (entry) entry.recent++;
          }
        }
      } catch {}
    }
  }

  const result: Array<{ category: string; count: number; trend: "growing" | "stable" | "declining" }> = [];
  for (const [category, data] of categoryMap) {
    let trend: "growing" | "stable" | "declining" = "stable";
    if (data.total > 0) {
      const ratio = data.recent / Math.max(data.total, 1);
      if (ratio > 0.3) trend = "growing";
      else if (ratio < 0.05 && data.total > 5) trend = "declining";
    }
    result.push({ category, count: data.total, trend });
  }

  return result.sort((a, b) => b.count - a.count);
}

function extractRecentInsights(memories: MemoryRow[], sessions: SessionRow[]): string[] {
  const insights: string[] = [];

  const successSessions = sessions.filter(s => s.outcome === "success");
  if (successSessions.length > 0) {
    const recentSuccess = successSessions.slice(0, 3);
    for (const s of recentSuccess) {
      if (s.task_type) {
        insights.push(`Completed ${s.task_type} task successfully (${s.started_at?.split("T")[0] || "unknown date"})`);
      }
    }
  }

  const highConfMemories = memories.filter(m => m.confidence > 0.8);
  if (highConfMemories.length > 0) {
    const typeCounts = new Map<string, number>();
    for (const m of highConfMemories) {
      typeCounts.set(m.type, (typeCounts.get(m.type) || 0) + 1);
    }
    const dominant = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (dominant) {
      insights.push(`Strong knowledge base in ${dominant[0]} (${dominant[1]} high-confidence fragments)`);
    }
  }

  const recentMemories = memories.slice(0, 3);
  for (const m of recentMemories) {
    insights.push(`Recent: "${m.title}" (${m.type})`);
  }

  return insights.slice(0, 8);
}

function calculateHealthScore(
  sessions: SessionRow[],
  memories: MemoryRow[],
  guides: GuideRow[]
): number {
  let score = 0.5;

  if (memories.length > 0) {
    const avgConf = memories.reduce((sum, m) => sum + m.confidence, 0) / memories.length;
    score += avgConf * 0.2;
  }

  if (sessions.length > 0) {
    const successRate = sessions.filter(s => s.outcome === "success").length / sessions.length;
    score += successRate * 0.15;
  }

  if (guides.length > 0) {
    const practicedGuides = guides.filter(g => g.usage_count > 1).length;
    score += Math.min(practicedGuides / guides.length, 1) * 0.15;
  }

  return Math.min(Math.round(score * 100) / 100, 1.0);
}

export function formatProjectProgress(progress: ProjectProgress): string {
  let output = `=== PROJECT ANALYTICS: ${progress.project} ===\n\n`;

  output += `Health Score: ${(progress.health_score * 100).toFixed(0)}%\n`;
  output += `Sessions: ${progress.total_sessions} | Memories: ${progress.total_memories} | Guides: ${progress.total_guides}\n`;
  output += `Knowledge Growth Rate: ${progress.knowledge_growth_rate}x (last 7 days vs prior 7 days)\n`;

  if (progress.skill_coverage.length > 0) {
    output += `\nSkill Coverage:\n`;
    for (const skill of progress.skill_coverage.slice(0, 10)) {
      const trendIcon = skill.trend === "growing" ? "↑" : skill.trend === "declining" ? "↓" : "→";
      output += `  ${trendIcon} ${skill.category}: ${skill.count}x usage\n`;
    }
  }

  if (progress.recent_insights.length > 0) {
    output += `\nRecent Activity:\n`;
    for (const insight of progress.recent_insights) {
      output += `  - ${insight}\n`;
    }
  }

  output += `\n====================`;
  return output;
}
