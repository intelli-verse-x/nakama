import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NakamaApiClient } from "../client.js";

// QuizVerse production game UUID (matches QUIZVERSE_GAME_ID in
// console/ui/dist/analytics.html). The whole analytics dashboard is scoped
// to this game.
const QUIZVERSE_GAME_ID = "126bf539-dae2-4bcf-964d-316c0fa1f92b";

/**
 * Section → RPC map. These are the exact RPCs the analytics.html dashboard
 * calls per tab. Each entry can list multiple RPCs; results are merged under
 * the section. Keep this in sync with the dashboard's TAB_LOADERS.
 */
const SECTION_RPCS: Record<string, string[]> = {
  overview: ["analytics_dashboard"],
  sessions: ["analytics_session_stats"],
  retention: ["analytics_retention_curves", "analytics_retention_milestones"],
  revenue: ["analytics_arpu", "analytics_monetization_detail"],
  economy: ["analytics_economy_health"],
  quiz: ["analytics_quiz_performance"],
  modes: [
    "analytics_modes_breakdown",
    "analytics_modes_transitions",
    "analytics_modes_retention",
  ],
  ai: ["analytics_ai_features"],
  features: ["analytics_feature_adoption"],
  funnel: ["analytics_funnel", "analytics_dropoff_funnel"],
  dropoff: ["analytics_per_question_dropoff", "analytics_screen_exit_heatmap"],
  platforms: ["analytics_platform_breakdown"],
  audience: ["analytics_audience_breakdown"],
  players: ["analytics_top_players", "analytics_churn_signals"],
  heatmap: ["analytics_home_heatmap"],
  pipeline: [
    "analytics_health",
    "analytics_freshness_check",
    "analytics_enforcement_status",
    "analytics_failed_events_recent",
  ],
};

const ALL_SECTIONS = Object.keys(SECTION_RPCS);

function num(v: unknown, d = 0): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : d;
}

function pct(n: number): number {
  return Math.round(n * 1000) / 10;
}

/**
 * Build a compact, LLM-friendly headline from the well-known section shapes.
 * Anything not explicitly summarized is still available in the section data.
 */
function buildHeadline(sections: Record<string, any>): Record<string, unknown> {
  const head: Record<string, unknown> = {};
  const ov = sections.overview?.analytics_dashboard;
  if (ov && !ov._error) {
    head.dau = num(ov.dau);
    head.wau = num(ov.wau);
    head.mau = num(ov.mau);
    head.dau_mau_ratio = Math.round(num(ov.dau_mau_ratio) * 1000) / 1000;
    head.new_users_today = num(ov.new_users_today);
    head.returning_users_today = num(ov.returning_users_today);
    head.avg_session_seconds = num(ov.avg_session_duration_seconds);
  }
  const ses = sections.sessions?.analytics_session_stats;
  if (ses && !ses._error) {
    head.total_sessions = num(ses.total_sessions);
    head.median_session_seconds = num(ses.median_duration_seconds);
    head.sessions_per_day = num(ses.sessions_per_day_avg);
  }
  const ret = sections.retention?.analytics_retention_curves;
  if (ret && !ret._error && ret.summary) {
    head.retention = {
      d1_pct: ret.summary.avg_d1_pct ?? null,
      d3_pct: ret.summary.avg_d3_pct ?? null,
      d7_pct: ret.summary.avg_d7_pct ?? null,
      d30_pct: ret.summary.avg_d30_pct ?? null,
    };
  }
  const eco = sections.economy?.analytics_economy_health;
  if (eco && !eco._error) {
    const ratio = eco.source_sink_ratio;
    head.economy = {
      gini: eco.gini_coefficient ?? eco.gini ?? null,
      total_coins: num(eco.total_coins),
      whale_count: num(eco.whale_count),
      source_sink_ratio:
        typeof ratio === "object" ? ratio?.ratio ?? null : ratio ?? null,
    };
  }
  const fun = sections.funnel?.analytics_funnel;
  if (fun && !fun._error && Array.isArray(fun.steps)) {
    let worst = { name: "none", drop_off_pct: 0 };
    for (const s of fun.steps) {
      if (num(s.drop_off_pct) > worst.drop_off_pct) {
        worst = { name: s.name, drop_off_pct: num(s.drop_off_pct) };
      }
    }
    head.funnel_worst_dropoff = worst;
  }
  const modes = sections.modes?.analytics_modes_breakdown;
  if (modes && !modes._error && Array.isArray(modes.modes)) {
    head.top_modes_by_starts = [...modes.modes]
      .sort((a: any, b: any) => num(b.starts) - num(a.starts))
      .slice(0, 5)
      .map((m: any) => ({
        mode: m.mode,
        starts: num(m.starts),
        completion_rate_pct: num(m.completion_rate_pct),
      }));
  }
  const pipe = sections.pipeline?.analytics_health;
  if (pipe && !pipe._error) {
    head.pipeline_health = pipe.overall ?? "unknown";
  }
  return head;
}

export function registerAnalyticsDashboardTools(
  server: McpServer,
  api: NakamaApiClient
) {
  server.tool(
    "quizverse_analytics_dashboard",
    "Full QuizVerse analytics dashboard data (everything behind https://nakama.intelli-verse-x.ai/analytics.html) in one LLM-readable payload. " +
      "Authenticates as analytics admin and fetches every dashboard section: overview (DAU/WAU/MAU), sessions, retention curves, revenue, economy, quiz performance, modes, AI features, feature adoption, funnel, drop-off, platforms, audience, top players/churn, heatmap, and pipeline health. " +
      "Returns a compact `headline` of key metrics plus per-section detail. Use this to answer ANY question about QuizVerse player engagement, retention, monetization, or content performance.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Look-back window in days (default 30). Dashboard supports 1/7/30/90/180/365."),
      sections: z
        .array(z.enum(ALL_SECTIONS as [string, ...string[]]))
        .optional()
        .describe(
          `Limit to specific sections. Default = all. Options: ${ALL_SECTIONS.join(", ")}`
        ),
      quiz_mode: z
        .string()
        .optional()
        .describe("Optional quiz mode filter (e.g. 'GuessAnime'). Applies to mode-aware sections."),
      from_date: z.string().optional().describe("Custom range start (YYYY-MM-DD). Overrides days when set."),
      to_date: z.string().optional().describe("Custom range end (YYYY-MM-DD)."),
      include_raw: z
        .boolean()
        .optional()
        .describe("Include the full raw RPC responses per section (default true). Set false for a leaner headline-only payload."),
    },
    async ({ days, sections, quiz_mode, from_date, to_date, include_raw }) => {
      const lookbackDays = days ?? 30;
      const wanted = sections && sections.length > 0 ? sections : ALL_SECTIONS;
      const includeRaw = include_raw !== false;

      const basePayload: Record<string, unknown> = {
        gameId: QUIZVERSE_GAME_ID,
        days: lookbackDays,
      };
      if (quiz_mode) basePayload.quiz_mode = quiz_mode;
      if (from_date) basePayload.from_date = from_date;
      if (to_date) basePayload.to_date = to_date;

      // Fetch every RPC for the requested sections in parallel.
      const jobs: Array<Promise<{ section: string; rpc: string; data: any }>> = [];
      for (const section of wanted) {
        for (const rpc of SECTION_RPCS[section] ?? []) {
          jobs.push(
            api
              .callAdminRpc(rpc, basePayload)
              .then((data) => ({ section, rpc, data }))
              .catch((e: any) => ({
                section,
                rpc,
                data: { _error: e?.message ?? String(e), _rpc: rpc },
              }))
          );
        }
      }

      const results = await Promise.all(jobs);

      const sectionData: Record<string, Record<string, any>> = {};
      const errors: Array<{ section: string; rpc: string; error: string }> = [];
      for (const { section, rpc, data } of results) {
        if (!sectionData[section]) sectionData[section] = {};
        sectionData[section][rpc] = data;
        if (data && data._error) {
          errors.push({ section, rpc, error: data._error });
        }
      }

      const headline = buildHeadline(sectionData);

      const report: Record<string, unknown> = {
        source: "https://nakama.intelli-verse-x.ai/analytics.html",
        game: "QuizVerse",
        game_id: QUIZVERSE_GAME_ID,
        generated_at: new Date().toISOString(),
        window: from_date
          ? { from_date, to_date: to_date ?? null }
          : { days: lookbackDays },
        sections_included: wanted,
        headline,
        errors: errors.length > 0 ? errors : undefined,
      };
      if (includeRaw) {
        report.sections = sectionData;
      }

      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );
}
