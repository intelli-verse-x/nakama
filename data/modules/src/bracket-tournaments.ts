namespace BracketTournaments {
  type Flavor = "ROUND_ROBIN" | "SINGLE_ELIMINATION" | "SWISS";
  type LifecycleState = "draft" | "created" | "seeded" | "active" | "completed" | "archived" | "error";

  interface BracketConfig {
    baseUrl: string;
    email: string;
    password: string;
    clubId: number;
    dashboardBaseUrl: string;
  }

  interface TournamentMapping {
    game_id: string;
    tournament_slug: string;
    storage_key: string;
    flavor: Flavor;
    state: LifecycleState;
    recurrence: any;
    bracket: any;
    teams: { [externalId: string]: any };
    players: { [externalId: string]: any };
    matches: { [matchId: string]: any };
    results: { [matchId: string]: any };
    created_at: string;
    updated_at: string;
    created_by: string;
    last_error?: string;
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  function normalizeGameId(data: any): string {
    var gameId = RpcHelpers.gameId(data);
    if (!gameId) throw new Error("game_id is required");
    return gameId;
  }

  function normalizeFlavor(value: any): Flavor {
    var flavor = String(value || "").toUpperCase();
    if (flavor === "ROUND_ROBIN" || flavor === "SINGLE_ELIMINATION" || flavor === "SWISS") {
      return flavor as Flavor;
    }
    throw new Error("flavor must be ROUND_ROBIN, SINGLE_ELIMINATION, or SWISS");
  }

  function sanitizeSlugPart(value: string): string {
    var raw = String(value || "").toLowerCase();
    var out = "";
    var lastDash = false;
    for (var i = 0; i < raw.length; i++) {
      var c = raw.charAt(i);
      var ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
      if (ok) {
        out += c;
        lastDash = false;
      } else if (!lastDash && out.length > 0) {
        out += "-";
        lastDash = true;
      }
    }
    while (out.length > 0 && out.charAt(out.length - 1) === "-") out = out.slice(0, -1);
    return out || "tournament";
  }

  function recurrenceWindow(recurrence: any): string {
    if (!recurrence || !recurrence.period) return "once";
    if (recurrence.window_start || recurrence.windowStart) {
      return sanitizeSlugPart(String(recurrence.window_start || recurrence.windowStart).slice(0, 10));
    }
    var d = new Date();
    var year = d.getUTCFullYear();
    var month = d.getUTCMonth() + 1;
    var monthStr = month < 10 ? "0" + month : String(month);
    var period = String(recurrence.period).toLowerCase();
    if (period === "monthly") return year + "-" + monthStr;
    if (period === "weekly") {
      var day = d.getUTCDay();
      var delta = day === 0 ? 6 : day - 1;
      var monday = new Date(d.getTime() - delta * 24 * 60 * 60 * 1000);
      var m = monday.getUTCMonth() + 1;
      var dd = monday.getUTCDate();
      return monday.getUTCFullYear() + "-" + (m < 10 ? "0" + m : String(m)) + "-" + (dd < 10 ? "0" + dd : String(dd));
    }
    return sanitizeSlugPart(period);
  }

  function resolveSlug(gameId: string, flavor: Flavor, data: any): string {
    var explicit = data.tournament_slug || data.tournamentSlug || data.slug;
    if (explicit) return sanitizeSlugPart(String(explicit));
    var recurrence = data.recurrence || null;
    var period = recurrence && recurrence.period ? String(recurrence.period).toLowerCase() : "oneoff";
    var name = data.name ? String(data.name) : gameId.slice(0, 8) + "-" + flavor.toLowerCase();
    return sanitizeSlugPart(name + "-" + flavor + "-" + period + "-" + recurrenceWindow(recurrence));
  }

  function storageKey(gameId: string, slug: string): string {
    return gameId + ":" + slug;
  }

  function readMapping(nk: nkruntime.Nakama, key: string): TournamentMapping | null {
    return Storage.readSystemJson<TournamentMapping>(nk, Constants.BRACKET_TOURNAMENTS_COLLECTION, key);
  }

  function writeMapping(nk: nkruntime.Nakama, mapping: TournamentMapping): void {
    mapping.updated_at = nowIso();
    Storage.writeSystemJson(nk, Constants.BRACKET_TOURNAMENTS_COLLECTION, mapping.storage_key, mapping);
  }

  function config(ctx: nkruntime.Context): BracketConfig {
    var env = ctx.env || {};
    var baseUrl = env["BRACKET_BASE_URL"] || "";
    var email = env["BRACKET_ADMIN_EMAIL"] || "";
    var password = env["BRACKET_ADMIN_PASSWORD"] || "";
    var clubIdRaw = env["BRACKET_CLUB_ID"] || "";
    if (!baseUrl || !email || !password || !clubIdRaw) {
      throw new Error("BRACKET_BASE_URL, BRACKET_ADMIN_EMAIL, BRACKET_ADMIN_PASSWORD, and BRACKET_CLUB_ID runtime env are required");
    }
    if (baseUrl.charAt(baseUrl.length - 1) === "/") baseUrl = baseUrl.slice(0, -1);
    return {
      baseUrl: baseUrl,
      email: email,
      password: password,
      clubId: parseInt(clubIdRaw, 10),
      dashboardBaseUrl: env["BRACKET_DASHBOARD_BASE_URL"] || ""
    };
  }

  function parseJson(body: string): any {
    if (!body) return {};
    return JSON.parse(body);
  }

  // Soft-cap timeouts so a slow Bracket can't hang a client RPC for 15s × N
  // sub-calls. status() does up to 7 sub-calls — at 8s each that caps at 56s
  // worst case, which is still gated by Nakama's RPC timeout. Worth tuning
  // per-call if needed (write methods may legitimately need more).
  var BRACKET_REQUEST_TIMEOUT_MS = 8000;

  function bracketRequest(nk: nkruntime.Nakama, cfg: BracketConfig, method: nkruntime.RequestMethod, path: string, body: any, token: string): any {
    var headers: { [key: string]: string } = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    };
    var payload = body === null || body === undefined ? "" : JSON.stringify(body);
    var resp: any = nk.httpRequest(cfg.baseUrl + path, method, headers, payload, BRACKET_REQUEST_TIMEOUT_MS);

    // 401 = token expired or revoked mid-session. Refresh once and retry.
    if (resp.code === 401) {
      invalidateBracketToken(cfg);
      var freshToken = bracketLogin(nk, cfg);
      headers["Authorization"] = "Bearer " + freshToken;
      resp = nk.httpRequest(cfg.baseUrl + path, method, headers, payload, BRACKET_REQUEST_TIMEOUT_MS);
    }
    if (resp.code < 200 || resp.code >= 300) {
      throw new Error("Bracket " + method.toUpperCase() + " " + path + " failed: HTTP " + resp.code + " " + resp.body);
    }
    return parseJson(resp.body);
  }

  // ── Token cache ──────────────────────────────────────────────────────
  // Bracket access tokens are JWTs that survive minutes-to-hours; logging in
  // on every RPC saturates the auth endpoint AND ships username/password over
  // the wire N times per minute. We cache by baseUrl+email; cache lives in
  // module scope (per goja instance, fine for our deployment topology).
  var __bracketTokenCache: { [cacheKey: string]: { token: string; fetchedAt: number } } = {};
  var BRACKET_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

  function bracketTokenCacheKey(cfg: BracketConfig): string {
    return cfg.baseUrl + "|" + cfg.email;
  }

  function bracketLogin(nk: nkruntime.Nakama, cfg: BracketConfig): string {
    var key = bracketTokenCacheKey(cfg);
    var cached = __bracketTokenCache[key];
    if (cached && (Date.now() - cached.fetchedAt) < BRACKET_TOKEN_TTL_MS) {
      return cached.token;
    }
    var body = "username=" + encodeURIComponent(cfg.email) + "&password=" + encodeURIComponent(cfg.password);
    var resp: any = nk.httpRequest(
      cfg.baseUrl + "/token",
      "post",
      { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      10000
    );
    if (resp.code < 200 || resp.code >= 300) {
      throw new Error("Bracket login failed: HTTP " + resp.code + " " + resp.body);
    }
    var parsed = parseJson(resp.body);
    if (!parsed.access_token) throw new Error("Bracket login response did not include access_token");
    __bracketTokenCache[key] = { token: parsed.access_token, fetchedAt: Date.now() };
    return parsed.access_token;
  }

  function invalidateBracketToken(cfg: BracketConfig): void {
    delete __bracketTokenCache[bracketTokenCacheKey(cfg)];
  }

  function dashboardUrl(cfg: BracketConfig, slug: string): string {
    if (!cfg.dashboardBaseUrl) return "";
    var base = cfg.dashboardBaseUrl.charAt(cfg.dashboardBaseUrl.length - 1) === "/"
      ? cfg.dashboardBaseUrl.slice(0, -1)
      : cfg.dashboardBaseUrl;
    return base + "/" + slug;
  }

  function response(mapping: TournamentMapping, extra?: any): any {
    var result: any = {
      game_id: mapping.game_id,
      tournament_slug: mapping.tournament_slug,
      flavor: mapping.flavor,
      state: mapping.state,
      recurrence: mapping.recurrence || null,
      bracket: mapping.bracket,
      teams: mapping.teams,
      players: mapping.players,
      matches: mapping.matches,
      results: mapping.results,
      sync: mapping.bracket ? mapping.bracket.sync : null,
      created_at: mapping.created_at,
      updated_at: mapping.updated_at
    };
    if (mapping.last_error) result.last_error = mapping.last_error;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) result[k] = extra[k];
      }
    }
    return result;
  }

  function extractData(apiResponse: any): any {
    if (apiResponse && apiResponse.data !== undefined) return apiResponse.data;
    return apiResponse;
  }

  function findStageItem(stages: any[], stageItemId: number): any {
    for (var s = 0; s < stages.length; s++) {
      var items = stages[s].stage_items || [];
      for (var i = 0; i < items.length; i++) {
        if (Number(items[i].id) === Number(stageItemId)) return items[i];
      }
    }
    return null;
  }

  function findMatchInStages(stages: any[], matchId: number): any {
    for (var s = 0; s < stages.length; s++) {
      var items = stages[s].stage_items || [];
      for (var i = 0; i < items.length; i++) {
        var rounds = items[i].rounds || [];
        for (var r = 0; r < rounds.length; r++) {
          var matches = rounds[r].matches || [];
          for (var m = 0; m < matches.length; m++) {
            if (Number(matches[m].id) === Number(matchId)) return matches[m];
          }
        }
      }
    }
    return null;
  }

  function flattenMatches(stages: any[]): any[] {
    var result: any[] = [];
    for (var s = 0; s < stages.length; s++) {
      var stage = stages[s];
      var items = stage.stage_items || [];
      for (var i = 0; i < items.length; i++) {
        var stageItem = items[i];
        var rounds = stageItem.rounds || [];
        for (var r = 0; r < rounds.length; r++) {
          var round = rounds[r];
          var matches = round.matches || [];
          for (var m = 0; m < matches.length; m++) {
            var match = matches[m];
            if (!match || match.id === undefined || match.id === null) continue;
            result.push({
              tournament_id: stage.tournament_id,
              stage_id: stage.id,
              stage_name: stage.name,
              stage_item_id: stageItem.id,
              stage_item_name: stageItem.name,
              stage_item_type: stageItem.type,
              round_id: round.id,
              round_name: round.name,
              round_is_draft: round.is_draft,
              match: match
            });
          }
        }
      }
    }
    return result;
  }

  function buildResultsSnapshot(matches: any[]): any {
    var completed: any[] = [];
    var pending: any[] = [];
    for (var i = 0; i < matches.length; i++) {
      var match = matches[i].match;
      var hasScore = Number(match.stage_item_input1_score || 0) !== 0
        || Number(match.stage_item_input2_score || 0) !== 0;
      if (hasScore) completed.push(matches[i]);
      else pending.push(matches[i]);
    }
    return {
      matches: matches,
      completed_matches: completed,
      pending_matches: pending,
      completed_count: completed.length,
      pending_count: pending.length
    };
  }

  function softGet(nk: nkruntime.Nakama, cfg: BracketConfig, token: string, path: string, fallback: any): any {
    // Used for endpoints that can legitimately 404/500 on a fresh tournament
    // (rankings before any match played, next_stage_rankings on single-stage).
    // The primary tournament/stages/players/teams calls MUST succeed.
    try {
      return extractData(bracketRequest(nk, cfg, "get", path, null, token));
    } catch (e) {
      return fallback;
    }
  }

  function refreshBracketSnapshot(nk: nkruntime.Nakama, cfg: BracketConfig, token: string, mapping: TournamentMapping): void {
    var tournament = extractData(bracketRequest(nk, cfg, "get", "/tournaments/" + mapping.bracket.tournament_id, null, token));
    var playersResp = extractData(bracketRequest(nk, cfg, "get", "/tournaments/" + mapping.bracket.tournament_id + "/players?limit=100", null, token));
    var teamsResp = extractData(bracketRequest(nk, cfg, "get", "/tournaments/" + mapping.bracket.tournament_id + "/teams?limit=100", null, token));
    var stagesResp = bracketRequest(nk, cfg, "get", "/tournaments/" + mapping.bracket.tournament_id + "/stages", null, token);
    var stages = extractData(stagesResp) || [];
    var courts = softGet(nk, cfg, token, "/tournaments/" + mapping.bracket.tournament_id + "/courts", []) || [];
    var rankings = softGet(nk, cfg, token, "/tournaments/" + mapping.bracket.tournament_id + "/rankings", []) || [];
    var nextStageRankings = softGet(nk, cfg, token, "/tournaments/" + mapping.bracket.tournament_id + "/next_stage_rankings", {}) || {};
    var allMatches = flattenMatches(stages);
    var stageItem = findStageItem(stages, mapping.bracket.stage_item_id);
    var players = playersResp && playersResp.players ? playersResp.players : [];
    var teams = teamsResp && teamsResp.teams ? teamsResp.teams : [];

    mapping.bracket.tournament = tournament;
    mapping.bracket.stages = stages;
    mapping.bracket.players = players;
    mapping.bracket.teams = teams;
    mapping.bracket.courts = courts;
    mapping.bracket.rankings = rankings;
    mapping.bracket.next_stage_rankings = nextStageRankings;
    mapping.bracket.planning = {
      courts: courts,
      matches: allMatches,
      match_count: allMatches.length
    };
    mapping.bracket.results = buildResultsSnapshot(allMatches);
    mapping.bracket.sync = {
      players: { count: playersResp && playersResp.count !== undefined ? playersResp.count : players.length, records: players },
      teams: { count: teamsResp && teamsResp.count !== undefined ? teamsResp.count : teams.length, records: teams },
      stages: { count: stages.length, records: stages },
      planning: mapping.bracket.planning,
      results: mapping.bracket.results,
      rankings: { count: rankings.length, records: rankings, next_stage_rankings: nextStageRankings },
      refreshed_at: nowIso()
    };
    mapping.matches = {};
    if (!stageItem) return;

    var inputs = stageItem.inputs || [];
    mapping.bracket.stage_item_inputs = inputs;
    var rounds = stageItem.rounds || [];
    for (var r = 0; r < rounds.length; r++) {
      var matches = rounds[r].matches || [];
      for (var m = 0; m < matches.length; m++) {
        var match = matches[m];
        if (!match || match.id === undefined || match.id === null) continue;
        mapping.matches[String(match.id)] = {
          bracket_match_id: match.id,
          round_id: match.round_id,
          stage_item_input1_id: match.stage_item_input1_id,
          stage_item_input2_id: match.stage_item_input2_id,
          stage_item_input1_team_id: match.stage_item_input1 && match.stage_item_input1.team_id ? match.stage_item_input1.team_id : null,
          stage_item_input2_team_id: match.stage_item_input2 && match.stage_item_input2.team_id ? match.stage_item_input2.team_id : null,
          stage_item_input1_score: match.stage_item_input1_score,
          stage_item_input2_score: match.stage_item_input2_score
        };
      }
    }
  }

  function teamExternalId(team: any, index: number): string {
    return String(team.external_id || team.externalId || team.team_id || team.teamId || team.user_id || team.userId || ("team_" + (index + 1)));
  }

  function playerExternalId(player: any, teamExternalIdValue: string, index: number): string {
    return String(player.external_id || player.externalId || player.user_id || player.userId || (teamExternalIdValue + ":player_" + (index + 1)));
  }

  function safeDelete(nk: nkruntime.Nakama, cfg: BracketConfig, token: string, path: string): void {
    try {
      bracketRequest(nk, cfg, "delete", path, null, token);
    } catch (e) {
      // best-effort cleanup; intentionally swallow
    }
  }

  function createBracketTournament(nk: nkruntime.Nakama, cfg: BracketConfig, token: string, data: any, gameId: string, flavor: Flavor, slug: string): TournamentMapping {
    var startTime = data.starts_at || data.startsAt || new Date().toISOString();
    var teamCount = Number(data.team_count || data.teamCount || (data.teams ? data.teams.length : 0));
    if (!teamCount || teamCount < 2) throw new Error("team_count or at least two teams are required");
    if (teamCount > 256) throw new Error("team_count must be <= 256 (Bracket service hard cap)");

    var tournament = extractData(bracketRequest(nk, cfg, "post", "/tournaments", {
      club_id: cfg.clubId,
      name: data.name || slug,
      start_time: startTime,
      dashboard_public: data.dashboard_public !== false,
      dashboard_endpoint: slug,
      players_can_be_in_multiple_teams: data.players_can_be_in_multiple_teams === true,
      auto_assign_courts: data.auto_assign_courts === true,
      duration_minutes: Number(data.duration_minutes || data.durationMinutes || 15),
      margin_minutes: Number(data.margin_minutes || data.marginMinutes || 5)
    }, token));

    // From here on, anything that throws must roll back the orphan tournament
    // in Bracket so a retry doesn't leak rows.
    var stage: any;
    var stageItem: any;
    try {
      stage = extractData(bracketRequest(nk, cfg, "post", "/tournaments/" + tournament.id + "/stages", {}, token));
      stageItem = extractData(bracketRequest(nk, cfg, "post", "/tournaments/" + tournament.id + "/stage_items", {
        stage_id: stage.id,
        name: data.stage_item_name || data.stageItemName || data.name || null,
        type: flavor,
        team_count: teamCount,
        ranking_id: data.ranking_id || data.rankingId || null
      }, token));
    } catch (e) {
      safeDelete(nk, cfg, token, "/tournaments/" + tournament.id);
      throw e;
    }

    var created = nowIso();
    var mapping: TournamentMapping = {
      game_id: gameId,
      tournament_slug: slug,
      storage_key: storageKey(gameId, slug),
      flavor: flavor,
      state: "created",
      recurrence: data.recurrence || null,
      bracket: {
        tournament_id: tournament.id,
        stage_id: stage.id,
        stage_item_id: stageItem.id,
        dashboard_endpoint: slug,
        dashboard_url: dashboardUrl(cfg, slug)
      },
      teams: {},
      players: {},
      matches: {},
      results: {},
      created_at: created,
      updated_at: created,
      created_by: data.user_id || data.userId || ""
    };
    refreshBracketSnapshot(nk, cfg, token, mapping);
    return mapping;
  }

  function seedTeams(nk: nkruntime.Nakama, cfg: BracketConfig, token: string, mapping: TournamentMapping, teamsPayload: any[]): void {
    if (!teamsPayload || teamsPayload.length < 1) throw new Error("teams are required");
    var inputs = mapping.bracket.stage_item_inputs || [];
    if (teamsPayload.length > inputs.length) throw new Error("more teams supplied than Bracket stage item inputs");

    for (var i = 0; i < teamsPayload.length; i++) {
      var sourceTeam = teamsPayload[i] || {};
      var externalTeamId = teamExternalId(sourceTeam, i);
      var existingTeam = mapping.teams[externalTeamId];
      var bracketTeamId = existingTeam && existingTeam.bracket_team_id ? existingTeam.bracket_team_id : null;
      var playerIds: number[] = [];

      var players = sourceTeam.players || sourceTeam.player_names || sourceTeam.playerNames || [];
      for (var p = 0; p < players.length; p++) {
        var sourcePlayer = typeof players[p] === "string" ? { name: players[p] } : players[p];
        var externalPlayerId = playerExternalId(sourcePlayer, externalTeamId, p);
        if (mapping.players[externalPlayerId] && mapping.players[externalPlayerId].bracket_player_id) {
          playerIds.push(Number(mapping.players[externalPlayerId].bracket_player_id));
          continue;
        }
        var player = extractData(bracketRequest(nk, cfg, "post", "/tournaments/" + mapping.bracket.tournament_id + "/players", {
          name: sourcePlayer.name || sourcePlayer.display_name || sourcePlayer.displayName || externalPlayerId,
          active: sourcePlayer.active !== false
        }, token));
        mapping.players[externalPlayerId] = {
          external_id: externalPlayerId,
          bracket_player_id: player.id,
          name: player.name
        };
        playerIds.push(Number(player.id));
      }

      if (!bracketTeamId) {
        var team = extractData(bracketRequest(nk, cfg, "post", "/tournaments/" + mapping.bracket.tournament_id + "/teams", {
          name: sourceTeam.name || externalTeamId,
          active: sourceTeam.active !== false,
          player_ids: playerIds
        }, token));
        bracketTeamId = team.id;
        mapping.teams[externalTeamId] = {
          external_id: externalTeamId,
          bracket_team_id: team.id,
          name: team.name,
          seed_slot: i + 1,
          player_ids: playerIds
        };
      }

      var input = inputs[i];
      if (!input || !input.id) throw new Error("missing Bracket input slot " + (i + 1));
      if (Number(input.team_id || 0) !== Number(bracketTeamId)) {
        bracketRequest(nk, cfg, "put", "/tournaments/" + mapping.bracket.tournament_id + "/stage_items/" + mapping.bracket.stage_item_id + "/inputs/" + input.id, {
          team_id: bracketTeamId
        }, token);
      }
    }
    mapping.state = "seeded";
    refreshBracketSnapshot(nk, cfg, token, mapping);
  }

  function resultHash(data: any): string {
    return JSON.stringify({
      input1: Number(data.stage_item_input1_score || data.score1 || data.team1_score || data.team1Score || 0),
      input2: Number(data.stage_item_input2_score || data.score2 || data.team2_score || data.team2Score || 0),
      winner: data.winner_team_id || data.winnerTeamId || data.winner_external_id || data.winnerExternalId || null,
      source: data.source_match_id || data.sourceMatchId || data.nakama_match_id || data.nakamaMatchId || null
    });
  }

  function submitMatchResult(ctx: nkruntime.Context, nk: nkruntime.Nakama, cfg: BracketConfig, token: string, mapping: TournamentMapping, data: any): any {
    refreshBracketSnapshot(nk, cfg, token, mapping);
    var matchId = Number(data.bracket_match_id || data.bracketMatchId || data.match_id || data.matchId);
    if (!matchId) throw new Error("bracket_match_id is required");
    var match = findMatchInStages(mapping.bracket.stages || [], matchId);
    if (!match) throw new Error("Bracket match not found in current tournament snapshot");

    var hash = resultHash(data);
    var existing = mapping.results[String(matchId)];
    if (existing && existing.result_hash === hash) {
      return { duplicate: true, match_id: matchId };
    }
    if (existing && existing.result_hash !== hash) {
      if (data.force !== true) {
        throw new Error("result already submitted with a different score; pass force=true (admin only) to overwrite");
      }
      // force=true is a destructive overwrite — gate to admin or the original
      // creator. Without this, any player could rewrite any other player's
      // result.
      var callerId = ctx.userId || "";
      var isAdmin = false;
      try {
        RpcHelpers.requireAdmin(ctx, nk);
        isAdmin = true;
      } catch (e) {
        isAdmin = false;
      }
      if (!isAdmin && callerId !== mapping.created_by) {
        throw new Error("force=true overwrite requires admin context or matching created_by");
      }
    }

    var score1 = Number(data.stage_item_input1_score || data.score1 || data.team1_score || data.team1Score || 0);
    var score2 = Number(data.stage_item_input2_score || data.score2 || data.team2_score || data.team2Score || 0);
    bracketRequest(nk, cfg, "put", "/tournaments/" + mapping.bracket.tournament_id + "/matches/" + matchId, {
      round_id: match.round_id,
      stage_item_input1_score: score1,
      stage_item_input2_score: score2,
      court_id: match.court_id || null,
      custom_duration_minutes: match.custom_duration_minutes || null,
      custom_margin_minutes: match.custom_margin_minutes || null
    }, token);

    mapping.results[String(matchId)] = {
      bracket_match_id: matchId,
      result_hash: hash,
      submitted_at: nowIso(),
      submitted_by: data.player_user_id || data.playerUserId || data.user_id || data.userId || null,
      source_match_id: data.source_match_id || data.sourceMatchId || data.nakama_match_id || data.nakamaMatchId || null,
      score1: score1,
      score2: score2,
      payload: data.result || data.quiz_result || data.quizResult || null
    };
    mapping.state = "active";
    refreshBracketSnapshot(nk, cfg, token, mapping);
    if (Object.keys(mapping.matches).length > 0 && Object.keys(mapping.results).length >= Object.keys(mapping.matches).length) {
      mapping.state = "completed";
    }
    return { duplicate: false, match_id: matchId };
  }

  function requireMapping(nk: nkruntime.Nakama, data: any): TournamentMapping {
    var gameId = normalizeGameId(data);
    var flavor = data.flavor ? normalizeFlavor(data.flavor) : "ROUND_ROBIN" as Flavor;
    var slug = resolveSlug(gameId, flavor, data);
    var mapping = readMapping(nk, storageKey(gameId, slug));
    if (!mapping) throw new Error("Bracket tournament mapping not found for " + gameId + ":" + slug);
    return mapping;
  }

  function rpcCreate(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      RpcHelpers.requireAdmin(ctx, nk);
      var data = RpcHelpers.parseRpcPayload(payload);
      var gameId = normalizeGameId(data);
      var flavor = normalizeFlavor(data.flavor);
      var slug = resolveSlug(gameId, flavor, data);
      var key = storageKey(gameId, slug);
      var existing = readMapping(nk, key);
      if (existing) return RpcHelpers.successResponse(response(existing, { idempotent: true }));

      var cfg = config(ctx);
      var token = bracketLogin(nk, cfg);
      var mapping = createBracketTournament(nk, cfg, token, data, gameId, flavor, slug);
      mapping.created_by = ctx.userId || data.created_by || data.createdBy || "server";
      if (data.teams && data.teams.length > 0) {
        seedTeams(nk, cfg, token, mapping, data.teams);
      }
      writeMapping(nk, mapping);
      return RpcHelpers.successResponse(response(mapping, { idempotent: false }));
    } catch (err: any) {
      logger.error("[BracketTournaments] create failed: " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse(err && err.message ? err.message : String(err));
    }
  }

  function rpcSeed(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      RpcHelpers.requireAdmin(ctx, nk);
      var data = RpcHelpers.parseRpcPayload(payload);
      var mapping = requireMapping(nk, data);
      var cfg = config(ctx);
      var token = bracketLogin(nk, cfg);
      seedTeams(nk, cfg, token, mapping, data.teams || []);
      writeMapping(nk, mapping);
      return RpcHelpers.successResponse(response(mapping));
    } catch (err: any) {
      logger.error("[BracketTournaments] seed failed: " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse(err && err.message ? err.message : String(err));
    }
  }

  function rpcStart(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      RpcHelpers.requireAdmin(ctx, nk);
      var data = RpcHelpers.parseRpcPayload(payload);
      var mapping = requireMapping(nk, data);
      var cfg = config(ctx);
      var token = bracketLogin(nk, cfg);
      if (mapping.flavor === "SWISS") {
        bracketRequest(nk, cfg, "post", "/tournaments/" + mapping.bracket.tournament_id + "/stage_items/" + mapping.bracket.stage_item_id + "/start_next_round", {
          adjust_to_time: data.adjust_to_time || data.adjustToTime || null
        }, token);
      } else if (data.schedule_matches !== false && data.scheduleMatches !== false) {
        bracketRequest(nk, cfg, "post", "/tournaments/" + mapping.bracket.tournament_id + "/schedule_matches", {}, token);
      }
      mapping.state = "active";
      refreshBracketSnapshot(nk, cfg, token, mapping);
      writeMapping(nk, mapping);
      return RpcHelpers.successResponse(response(mapping));
    } catch (err: any) {
      logger.error("[BracketTournaments] start failed: " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse(err && err.message ? err.message : String(err));
    }
  }

  function rpcSubmitResult(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var data = RpcHelpers.parseRpcPayload(payload);
      var mapping = requireMapping(nk, data);
      var cfg = config(ctx);
      var token = bracketLogin(nk, cfg);
      var submit = submitMatchResult(ctx, nk, cfg, token, mapping, data);
      writeMapping(nk, mapping);
      return RpcHelpers.successResponse(response(mapping, submit));
    } catch (err: any) {
      logger.error("[BracketTournaments] submit_result failed: " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse(err && err.message ? err.message : String(err));
    }
  }

  function rpcList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var data = RpcHelpers.parseRpcPayload(payload);
      var gameId = data.game_id || data.gameId || null;
      var limit = Math.min(Math.max(Number(data.limit || 50), 1), 200);

      // Storage list returns all keys in the collection; filter by game_id
      // prefix when given. Storage keys are "game_id:slug".
      var listResp: any = nk.storageList(null, Constants.BRACKET_TOURNAMENTS_COLLECTION, limit, undefined);
      var items: TournamentMapping[] = [];
      var objects = (listResp && listResp.objects) || [];
      for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        if (!obj || !obj.value) continue;
        if (gameId && obj.key.indexOf(gameId + ":") !== 0) continue;
        items.push(obj.value as TournamentMapping);
      }
      // Lightweight projection — list view doesn't need the full bracket
      // snapshot for every row.
      var summary = items.map(function (m) {
        return {
          game_id: m.game_id,
          tournament_slug: m.tournament_slug,
          flavor: m.flavor,
          state: m.state,
          created_at: m.created_at,
          updated_at: m.updated_at,
          team_count: Object.keys(m.teams || {}).length,
          match_count: Object.keys(m.matches || {}).length,
          result_count: Object.keys(m.results || {}).length,
          dashboard_url: m.bracket && m.bracket.dashboard_url ? m.bracket.dashboard_url : ""
        };
      });
      return RpcHelpers.successResponse({ tournaments: summary, count: summary.length });
    } catch (err: any) {
      logger.error("[BracketTournaments] list failed: " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse(err && err.message ? err.message : String(err));
    }
  }

  function rpcCancel(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      RpcHelpers.requireAdmin(ctx, nk);
      var data = RpcHelpers.parseRpcPayload(payload);
      var mapping = requireMapping(nk, data);
      if (mapping.state === "completed" || mapping.state === "archived") {
        throw new Error("cannot cancel a tournament in state " + mapping.state);
      }
      // Best-effort delete in Bracket; the Nakama mapping is always archived.
      if (data.delete_bracket === true || data.deleteBracket === true) {
        var cfg = config(ctx);
        var token = bracketLogin(nk, cfg);
        safeDelete(nk, cfg, token, "/tournaments/" + mapping.bracket.tournament_id);
      }
      mapping.state = "archived";
      mapping.last_error = data.reason ? String(data.reason).slice(0, 240) : undefined;
      writeMapping(nk, mapping);
      return RpcHelpers.successResponse(response(mapping));
    } catch (err: any) {
      logger.error("[BracketTournaments] cancel failed: " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse(err && err.message ? err.message : String(err));
    }
  }

  function rpcStatus(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var data = RpcHelpers.parseRpcPayload(payload);
      var gameId = normalizeGameId(data);
      var flavor = data.flavor ? normalizeFlavor(data.flavor) : "ROUND_ROBIN" as Flavor;
      var slug = resolveSlug(gameId, flavor, data);
      var mapping = readMapping(nk, storageKey(gameId, slug));
      if (!mapping) {
        return RpcHelpers.successResponse({
          active: false,
          game_id: gameId,
          tournament_slug: slug,
          flavor: flavor,
          state: "missing"
        });
      }
      if (data.sync !== false && data.refresh !== false) {
        var cfg = config(ctx);
        var token = bracketLogin(nk, cfg);
        refreshBracketSnapshot(nk, cfg, token, mapping);
        writeMapping(nk, mapping);
      }
      return RpcHelpers.successResponse(response(mapping, { active: true }));
    } catch (err: any) {
      logger.error("[BracketTournaments] status failed: " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse(err && err.message ? err.message : String(err));
    }
  }

  // NOTE: The register() signature is intentionally single-arg (initializer only).
  // The postbuild AST walker rewrites the string-literal registerRpc() calls below
  // into `__rpc_<name> = <handler>` global assignments, and ALSO auto-invokes any
  // no-arg-callable register() at IIFE scope. A multi-arg signature (e.g.
  // `register(initializer, logger)`) makes the postbuild skip the auto-invoke and
  // the globals stay `undefined` in pooled Goja VMs → RPCs fail at invocation
  // with "JavaScript runtime function invalid". See QA report on PR #54.
  // The boot-time info log moved to main.ts (which still has the logger ref).
  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("bracket_tournament_create", rpcCreate);
    initializer.registerRpc("bracket_tournament_seed", rpcSeed);
    initializer.registerRpc("bracket_tournament_start", rpcStart);
    initializer.registerRpc("bracket_tournament_submit_result", rpcSubmitResult);
    initializer.registerRpc("bracket_tournament_status", rpcStatus);
    initializer.registerRpc("bracket_tournament_list", rpcList);
    initializer.registerRpc("bracket_tournament_cancel", rpcCancel);
  }
}
