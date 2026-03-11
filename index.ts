import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";
import { createAgentApp } from "@lucid-agents/hono";
import { z } from "zod";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings";

async function espnFetch(url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": "world-cup-2026-agent/1.0" },
  });
  if (!res.ok) throw new Error(`ESPN API error ${res.status} for ${url}`);
  return res.json() as Promise<any>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statVal(stats: any[], name: string): number {
  return stats?.find((s: any) => s.name === name)?.value ?? 0;
}

async function fetchAllStandings() {
  const data = await espnFetch(ESPN_STANDINGS);
  return (data.children ?? []).map((group: any) => ({
    group: group.name,
    teams: (group.standings?.entries ?? []).map((e: any) => ({
      name: e.team.displayName,
      abbreviation: e.team.abbreviation,
      played: statVal(e.stats, "gamesPlayed"),
      wins: statVal(e.stats, "wins"),
      draws: statVal(e.stats, "ties"),
      losses: statVal(e.stats, "losses"),
      goals_for: statVal(e.stats, "pointsFor"),
      goals_against: statVal(e.stats, "pointsAgainst"),
      goal_difference: statVal(e.stats, "pointDifferential"),
      points: statVal(e.stats, "points"),
    })),
  }));
}

// ── Build agent ───────────────────────────────────────────────────────────────

const agent = await createAgent({
  name: "world-cup-2026-agent",
  version: "1.0.0",
  description:
    "Real-time FIFA World Cup 2026 intelligence: group standings, match schedules, live scores, and team profiles. Powered by ESPN's public data with no authentication required.",
})
  .use(http())
  .use(
    payments({
      config: paymentsFromEnv(),
      storage: { type: "in-memory" },
    })
  )
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// ── Endpoint 1: overview (FREE) ───────────────────────────────────────────────
addEntrypoint({
  key: "overview",
  description:
    "Free overview of the 2026 FIFA World Cup: tournament name, season dates, current phase, number of participating teams, and total groups.",
  input: z.object({}),
  output: z.object({
    tournament: z.string(),
    season: z.number(),
    start_date: z.string(),
    end_date: z.string(),
    current_phase: z.string(),
    total_teams: z.number(),
    total_groups: z.number(),
    host_countries: z.array(z.string()),
  }),
  async handler() {
    const [scoreData, teamsData] = await Promise.all([
      espnFetch(`${ESPN_BASE}/scoreboard`),
      espnFetch(`${ESPN_BASE}/teams`),
    ]);
    const league = scoreData.leagues?.[0];
    const season = league?.season;
    const allTeams = teamsData.sports?.[0]?.leagues?.[0]?.teams ?? [];
    return {
      output: {
        tournament: league?.name ?? "2026 FIFA World Cup",
        season: season?.year ?? 2026,
        start_date: season?.startDate ?? "2026-06-11",
        end_date: season?.endDate ?? "2026-07-19",
        current_phase: season?.type?.name ?? "Group Stage",
        total_teams: allTeams.length,
        total_groups: 12,
        host_countries: ["United States", "Canada", "Mexico"],
      },
    };
  },
});

// ── Endpoint 2: standings (paid $0.001) ───────────────────────────────────────
addEntrypoint({
  key: "standings",
  description:
    "Full FIFA World Cup 2026 group standings. Returns all groups (A–L) with each team's matches played, wins, draws, losses, goals for/against, goal difference, and points.",
  price: "0.001",
  input: z.object({
    group: z
      .string()
      .optional()
      .describe("Filter by group letter, e.g. 'A', 'B'. Leave empty for all groups."),
  }),
  output: z.object({
    groups: z.array(
      z.object({
        group: z.string(),
        teams: z.array(
          z.object({
            name: z.string(),
            abbreviation: z.string(),
            played: z.number(),
            wins: z.number(),
            draws: z.number(),
            losses: z.number(),
            goals_for: z.number(),
            goals_against: z.number(),
            goal_difference: z.number(),
            points: z.number(),
          })
        ),
      })
    ),
  }),
  async handler({ input }) {
    const groups = await fetchAllStandings();
    const filtered =
      input.group
        ? groups.filter((g: any) =>
            g.group.toLowerCase().includes(input.group!.toLowerCase())
          )
        : groups;
    return { output: { groups: filtered } };
  },
});

// ── Endpoint 3: schedule (paid $0.002) ────────────────────────────────────────
addEntrypoint({
  key: "schedule",
  description:
    "FIFA World Cup 2026 match schedule. Optionally filter by date (YYYYMMDD format). Returns upcoming and recent matches with date, teams, venue, and status.",
  price: "0.002",
  input: z.object({
    date: z
      .string()
      .optional()
      .describe("Date in YYYYMMDD format, e.g. '20260615'. Defaults to today."),
    limit: z.number().int().min(1).max(20).default(10).describe("Number of matches to return (1-20)"),
  }),
  output: z.object({
    date_queried: z.string(),
    matches: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        date: z.string(),
        status: z.string(),
        venue: z.string(),
        home_team: z.string(),
        away_team: z.string(),
        home_score: z.string(),
        away_score: z.string(),
      })
    ),
    total: z.number(),
  }),
  async handler({ input }) {
    const dateParam = input.date ? `?dates=${input.date}` : "";
    const data = await espnFetch(`${ESPN_BASE}/scoreboard${dateParam}`);
    const events: any[] = data.events ?? [];
    const matches = events.slice(0, input.limit ?? 10).map((e: any) => {
      const comp = e.competitions?.[0];
      const competitors = comp?.competitors ?? [];
      const home = competitors.find((c: any) => c.homeAway === "home") ?? competitors[0];
      const away = competitors.find((c: any) => c.homeAway === "away") ?? competitors[1];
      return {
        id: e.id,
        name: e.name,
        date: e.date,
        status: e.status?.type?.description ?? "Scheduled",
        venue: comp?.venue?.fullName ?? "TBD",
        home_team: home?.team?.displayName ?? "TBD",
        away_team: away?.team?.displayName ?? "TBD",
        home_score: home?.score ?? "0",
        away_score: away?.score ?? "0",
      };
    });
    return {
      output: {
        date_queried: input.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        matches,
        total: events.length,
      },
    };
  },
});

// ── Endpoint 4: team (paid $0.002) ────────────────────────────────────────────
addEntrypoint({
  key: "team",
  description:
    "FIFA World Cup 2026 team profile. Look up any participating team by name or abbreviation (e.g. 'Brazil', 'BRA', 'France', 'FRA'). Returns team colors, logo, and ESPN links.",
  price: "0.002",
  input: z.object({
    query: z.string().describe("Team name or abbreviation, e.g. 'Brazil', 'BRA', 'France', 'FRA'"),
  }),
  output: z.object({
    found: z.boolean(),
    id: z.string(),
    name: z.string(),
    abbreviation: z.string(),
    slug: z.string(),
    primary_color: z.string(),
    alternate_color: z.string(),
    logo_url: z.string(),
    espn_url: z.string(),
  }),
  async handler({ input }) {
    const data = await espnFetch(`${ESPN_BASE}/teams`);
    const teams: any[] = data.sports?.[0]?.leagues?.[0]?.teams ?? [];
    const q = input.query.toLowerCase();
    const match = teams.find(
      ({ team: t }: any) =>
        t.displayName.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.abbreviation.toLowerCase() === q ||
        t.slug.toLowerCase().includes(q)
    );
    if (!match) {
      return {
        output: {
          found: false,
          id: "",
          name: input.query,
          abbreviation: "",
          slug: "",
          primary_color: "",
          alternate_color: "",
          logo_url: "",
          espn_url: "",
        },
      };
    }
    const t = match.team;
    return {
      output: {
        found: true,
        id: t.id,
        name: t.displayName,
        abbreviation: t.abbreviation,
        slug: t.slug,
        primary_color: `#${t.color}`,
        alternate_color: `#${t.alternateColor}`,
        logo_url: t.logos?.[0]?.href ?? "",
        espn_url:
          t.links?.find((l: any) => l.rel?.includes("clubhouse"))?.href ?? "",
      },
    };
  },
});

// ── Endpoint 5: scores (paid $0.003) ──────────────────────────────────────────
addEntrypoint({
  key: "scores",
  description:
    "Recent and live FIFA World Cup 2026 match scores. Returns current scoreboard with match status, scores, venue, and broadcast info.",
  price: "0.003",
  input: z.object({
    date: z
      .string()
      .optional()
      .describe("Date in YYYYMMDD format to get scores for a specific day. Defaults to today."),
  }),
  output: z.object({
    generated_at: z.string(),
    matches: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        date: z.string(),
        status: z.string(),
        status_detail: z.string(),
        clock: z.string(),
        venue: z.string(),
        city: z.string(),
        home_team: z.string(),
        home_score: z.string(),
        home_record: z.string(),
        away_team: z.string(),
        away_score: z.string(),
        away_record: z.string(),
        broadcast: z.string(),
      })
    ),
    total_matches: z.number(),
  }),
  async handler({ input }) {
    const dateParam = input.date ? `?dates=${input.date}` : "";
    const data = await espnFetch(`${ESPN_BASE}/scoreboard${dateParam}`);
    const events: any[] = data.events ?? [];
    const matches = events.map((e: any) => {
      const comp = e.competitions?.[0];
      const competitors = comp?.competitors ?? [];
      const home = competitors.find((c: any) => c.homeAway === "home") ?? competitors[0];
      const away = competitors.find((c: any) => c.homeAway === "away") ?? competitors[1];
      const status = e.status;
      const broadcasts = comp?.broadcasts?.flatMap((b: any) => b.names ?? []) ?? [];
      return {
        id: e.id,
        name: e.name,
        date: e.date,
        status: status?.type?.description ?? "Scheduled",
        status_detail: status?.type?.detail ?? "",
        clock: status?.displayClock ?? "0:00",
        venue: comp?.venue?.fullName ?? "TBD",
        city: [comp?.venue?.address?.city, comp?.venue?.address?.state]
          .filter(Boolean)
          .join(", ") || "TBD",
        home_team: home?.team?.displayName ?? "TBD",
        home_score: home?.score ?? "0",
        home_record: home?.records?.[0]?.summary ?? "",
        away_team: away?.team?.displayName ?? "TBD",
        away_score: away?.score ?? "0",
        away_record: away?.records?.[0]?.summary ?? "",
        broadcast: broadcasts.join(", ") || "TBD",
      };
    });
    return {
      output: {
        generated_at: new Date().toISOString(),
        matches,
        total_matches: matches.length,
      },
    };
  },
});

// ── Endpoint 6: report (paid $0.005) ─────────────────────────────────────────
addEntrypoint({
  key: "report",
  description:
    "Full FIFA World Cup 2026 intelligence report: tournament overview, all group standings, today's match schedule, and complete list of participating teams. Ideal for sports apps, AI agents, and analysts.",
  price: "0.005",
  input: z.object({}),
  output: z.object({
    generated_at: z.string(),
    tournament: z.string(),
    season: z.number(),
    current_phase: z.string(),
    host_countries: z.array(z.string()),
    total_teams: z.number(),
    groups: z.array(
      z.object({
        group: z.string(),
        leader: z.string(),
        teams: z.array(
          z.object({
            name: z.string(),
            points: z.number(),
            played: z.number(),
            goal_difference: z.number(),
          })
        ),
      })
    ),
    upcoming_matches: z.array(
      z.object({
        name: z.string(),
        date: z.string(),
        venue: z.string(),
        status: z.string(),
      })
    ),
    teams: z.array(z.object({ name: z.string(), abbreviation: z.string() })),
  }),
  async handler() {
    const [scoreData, standingsGroups, teamsData] = await Promise.all([
      espnFetch(`${ESPN_BASE}/scoreboard`),
      fetchAllStandings(),
      espnFetch(`${ESPN_BASE}/teams`),
    ]);
    const league = scoreData.leagues?.[0];
    const season = league?.season;
    const allTeams: any[] = teamsData.sports?.[0]?.leagues?.[0]?.teams ?? [];
    const events: any[] = scoreData.events ?? [];

    const groups = standingsGroups.map((g: any) => ({
      group: g.group,
      leader: g.teams[0]?.name ?? "",
      teams: g.teams.map((t: any) => ({
        name: t.name,
        points: t.points,
        played: t.played,
        goal_difference: t.goal_difference,
      })),
    }));

    const upcoming = events.slice(0, 5).map((e: any) => {
      const comp = e.competitions?.[0];
      return {
        name: e.name,
        date: e.date,
        venue: comp?.venue?.fullName ?? "TBD",
        status: e.status?.type?.description ?? "Scheduled",
      };
    });

    const teams = allTeams.map(({ team: t }: any) => ({
      name: t.displayName,
      abbreviation: t.abbreviation,
    }));

    return {
      output: {
        generated_at: new Date().toISOString(),
        tournament: league?.name ?? "2026 FIFA World Cup",
        season: season?.year ?? 2026,
        current_phase: season?.type?.name ?? "Group Stage",
        host_countries: ["United States", "Canada", "Mexico"],
        total_teams: allTeams.length,
        groups,
        upcoming_matches: upcoming,
        teams,
      },
    };
  },
});

// ── Start server ──────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3000");
export default {
  port,
  fetch: (req: Request) => {
    const url = new URL(req.url);
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return app.fetch(new Request(url.toString(), req));
    }
    return app.fetch(req);
  },
};

console.log(`World Cup 2026 Agent running on http://localhost:${port}`);
