// sq_core.ts
// ─────────────────────────────────────────────────────────────────────────────
// QuizVerse Seed Questions ("Staged Questions") — core types + shared helpers.
//
// Hosted surface: seedquestions.intelli-verse-x.ai (see deploy/seedquestions/)
// which routes to Nakama's /v2/rpc/quizverse_seedq_* endpoints.
//
// The Staged Questions engine keeps 2–3 ready-to-play question SETS staged
// per (user, mode, topic) so the iOS/Android client always has fresh,
// never-seen-before, difficulty-adapted content available instantly —
// even offline-first (client caches the staged payload).
//
// Guarantees (the four checklist items):
//   1. Question Quality  — every question passes structural auto-QA at ingest
//                          (sq_quality.ts) and stays subject to user review /
//                          quarantine after ship.
//   2. Unique per userID — staged sets exclude every id in the user's qv_seen
//                          ledger (shared with the rest of QuizVerse via
//                          globalThis.__qvsSeen) AND every id already staged.
//                          Consuming a set merges its ids back into qv_seen.
//   3. Adaptive per userID+topic — target difficulty derived from the user's
//                          per-topic accuracy in quiz-verse_quiz_history,
//                          served as a 60/20/20 difficulty mix.
//   4. Fresh seeding     — 13 content-source connectors (sq_sources.ts) feed
//                          the pool; quizverse_seedq_ingest_tick rotates
//                          through them on a cron cadence.
//
// Storage layout
// ──────────────
//   sq_pool         SYSTEM   key {mode}_{topic}   { questions[], updated_ms }
//   sq_pool_index   SYSTEM   key "index"          { keys: { poolKey: true } }
//   sq_review       SYSTEM   key {mode}_{topic}   { [qid]: {up,down,flags,reasons,status} }
//   sq_staged       PER-USER key {mode}_{topic}   { sets: StagedSet[], updated_ms }
//   sq_source_cache SYSTEM   key {provider}:{sig} { fetched_ms, ttl_ms, data }
//   sq_ingest_state SYSTEM   key "state"          { cursor, runs, last_run_ms }
//   sq_focus_tracks SYSTEM   key "tracks"         { fetched_ms, tracks[] }
//
// ES5 / Goja rules honored: no Node built-ins, no module-level mutable state,
// string-literal registerRpc ids, single-arg register() (sq_rpcs.ts).

declare var __qvsSeen: any; // provided by data/modules/quizverse_seen/quizverse_seen.js

namespace SeedQ {

  export var MODULE_VERSION = "seed-questions/1.2.0";
  export var CACHE_SCHEMA_VERSION = 2;

  // ── Collections ────────────────────────────────────────────────────────────
  export var COLL_POOL = "sq_pool";
  export var COLL_POOL_INDEX = "sq_pool_index";
  export var COLL_REVIEW = "sq_review";
  export var COLL_STAGED = "sq_staged";
  export var COLL_SOURCE_CACHE = "sq_source_cache";
  export var COLL_INGEST_STATE = "sq_ingest_state";
  export var COLL_FOCUS_TRACKS = "sq_focus_tracks";

  // ── Tunables ────────────────────────────────────────────────────────────────
  export var TARGET_READY_SETS = 3;    // keep 2–3 sets staged; top up to 3
  export var MIN_READY_SETS = 2;
  export var DEFAULT_SET_SIZE = 10;
  export var MAX_SET_SIZE = 25;
  export var POOL_MAX_QUESTIONS = 400; // per (mode, topic) pool doc
  export var MODE_PRODUCTION_MIN = DEFAULT_SET_SIZE * 5; // 3 live sets + 2-set no-repeat reserve
  export var CONSUMED_SET_TTL_MS = 7 * 86400 * 1000;
  export var READY_SET_TTL_MS = 24 * 3600 * 1000;
  export var SEEN_SCOPE = "seedq";     // qv_seen scope for this engine
  export var HISTORY_READ_CAP = 200;   // newest history entries for adaptive calc
  export var GEO_RELEVANT_PERCENT = 60;
  export var REVIEW_VERSION = "auto_qa/1";

  // ── Types ───────────────────────────────────────────────────────────────────
  export interface Provenance {
    source_domain: string;
    license: string;            // "public_domain" | "cc" | "api_tos" | "unknown"
    checked: boolean;
    method: string;             // "tineye" | "domain_whitelist" | "none"
  }

  export interface QualityInfo {
    score: number;              // 0..100
    status: string;             // "approved" | "quarantined" | "rejected"
    checks: string[];           // passed check names (e.g. "wolfram_verified")
  }

  export interface ReviewInfo {
    reviewed: boolean;
    reviewer: string;           // "auto_qa" | "agent"; never claim human review
    reviewed_at: string;
    checks: string[];
    version: string;
    experience_checks?: string[];
  }

  export interface SeedQuestion {
    id: string;                 // sq_{source}_{hash12}
    question: string;
    options: string[];
    correct_index: number;
    explanation: string;
    category: string;
    topic: string;
    mode: string;               // Unity QuizModeType name (opaque to server)
    difficulty: number;         // 1..5
    question_type: string;      // "Text" | "Image" | "Audio" | "Video"
    media_url: string;          // optimized at serve time (wsrv.nl proxy)
    media_provenance: Provenance | null;
    source: string;             // connector id (see sq_sources.ts)
    citation: string;           // E-E-A-T citation string (semanticscholar etc.)
    lang: string;
    created_ms: number;
    quality: QualityInfo;
    review?: ReviewInfo;
    country_codes?: string[];   // ISO-3166 alpha-2; absent/empty means global
    locale?: string;
    geo_relevance?: number;     // 0..100 source/editor relevance signal
    geo_reason?: string;
    media_alt?: string;
    media_mime?: string;
    behavior_tags?: string[];
    selection_reasons?: string[];
  }

  export interface StagedSet {
    schema_version: number;
    set_id: string;
    mode: string;
    topic: string;
    status: string;             // "ready" | "consumed"
    difficulty_target: number;
    question_ids: string[];
    questions: SeedQuestion[];
    fresh_count?: number;        // never-seen questions in this set (D1 §6.2)
    review_count?: number;       // disclosed "Smart Review" repeats in this set
    created_ms: number;
    expires_ms: number;
    generated_at: string;
    expires_at: string;
    consumed_ms: number;
    country_code?: string;
  }

  export interface ModeDefinition {
    mode: string;
    aliases: string[];
    source: string;
    default_topic: string;
    media: string;
    support: string;            // "direct" | "fallback"
    fallback_mode: string;
    reason: string;
  }

  // Canonical union of the QuizModeType names exposed by the backend's
  // chat-launch contract plus backend-only content modes and legacy aliases.
  // Adding a client mode requires adding it here before SeedQ will accept it.
  export function modeRegistry(): ModeDefinition[] {
    return [
      { mode:"SoloChallenge",aliases:["Classic","Solo"],source:"wolfram",default_topic:"general",media:"none",support:"fallback",fallback_mode:"CustomTopic",reason:"generic approved pool" },
      { mode:"SurvivalQuiz",aliases:["Survival"],source:"wolfram",default_topic:"general",media:"none",support:"fallback",fallback_mode:"CustomTopic",reason:"generic approved pool" },
      { mode:"SpeedQuiz",aliases:["Speed"],source:"wolfram",default_topic:"arithmetic",media:"none",support:"direct",fallback_mode:"CustomTopic",reason:"template-computed STEM" },
      { mode:"BrainSprint",aliases:["Brain Sprint"],source:"wolfram",default_topic:"arithmetic",media:"none",support:"direct",fallback_mode:"CustomTopic",reason:"template-computed STEM" },
      { mode:"DailyQuiz",aliases:["Daily","DailyChallenge"],source:"gutenberg",default_topic:"general",media:"optional",support:"fallback",fallback_mode:"CustomTopic",reason:"daily authored pool preferred; safe global fallback" },
      { mode:"WeeklyQuiz",aliases:["Weekly"],source:"gutenberg",default_topic:"general",media:"optional",support:"fallback",fallback_mode:"CustomTopic",reason:"weekly authored pool preferred; safe global fallback" },
      { mode:"ViralIQ",aliases:["Viral IQ"],source:"justwatch",default_topic:"trending",media:"optional",support:"direct",fallback_mode:"MediaQuiz",reason:"trending titles" },
      { mode:"TrueFalseQuiz",aliases:["TrueFalse","True False"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"CustomTopic",reason:"MCQ payload remains compatible" },
      { mode:"MultipleChoiceQuiz",aliases:["MultipleChoice","MCQ"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"CustomTopic",reason:"generic approved MCQ pool" },
      { mode:"ImageQuiz",aliases:["ImageGuess","Image Quiz"],source:"archive_org",default_topic:"history",media:"image",support:"direct",fallback_mode:"MediaQuiz",reason:"public-domain images" },
      { mode:"AudioQuiz",aliases:["MusicQuiz","Music Quiz"],source:"music_tv",default_topic:"music",media:"optional",support:"direct",fallback_mode:"MediaQuiz",reason:"music metadata and cover art" },
      { mode:"VideoQuiz",aliases:["Video Quiz","YouTubeQuiz"],source:"youtube_quiz",default_topic:"video",media:"video",support:"fallback",fallback_mode:"CustomTopic",reason:"LLM connector is env-gated; generic pool fallback" },
      { mode:"GuessAnime",aliases:["AnimeQuiz"],source:"archive_org",default_topic:"anime",media:"image",support:"fallback",fallback_mode:"ImageQuiz",reason:"licensed authored pack preferred; public-domain image fallback" },
      { mode:"GuessDog",aliases:["DogQuiz"],source:"archive_org",default_topic:"dogs",media:"image",support:"direct",fallback_mode:"ImageQuiz",reason:"public-domain images" },
      { mode:"GuessDish",aliases:["DishQuiz","FoodQuiz"],source:"archive_org",default_topic:"food",media:"image",support:"direct",fallback_mode:"ImageQuiz",reason:"public-domain images" },
      { mode:"GuessPokemon",aliases:["PokemonQuiz"],source:"archive_org",default_topic:"creatures",media:"image",support:"fallback",fallback_mode:"ImageQuiz",reason:"trademarked authored pack required; generic image fallback" },
      { mode:"SportsQuiz",aliases:["Sports"],source:"archive_org",default_topic:"sports",media:"optional",support:"direct",fallback_mode:"CustomTopic",reason:"public-domain sports archive" },
      { mode:"SpaceTrivia",aliases:["SpaceQuiz"],source:"archive_org",default_topic:"space",media:"image",support:"direct",fallback_mode:"CustomTopic",reason:"public-domain space archive" },
      { mode:"EmojiQuiz",aliases:["Emoji"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"CustomTopic",reason:"authored emoji pack preferred; generic fallback" },
      { mode:"HealthQuiz",aliases:["Health"],source:"scholar",default_topic:"health",media:"none",support:"direct",fallback_mode:"CustomTopic",reason:"cited research metadata" },
      { mode:"FortuneQuiz",aliases:["Fortune"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"CustomTopic",reason:"entertainment-only generic fallback" },
      { mode:"PredictionQuiz",aliases:["Prediction"],source:"justwatch",default_topic:"trending",media:"optional",support:"fallback",fallback_mode:"ViralIQ",reason:"trending factual questions; no fabricated predictions" },
      { mode:"GeoExplore",aliases:["GeoQuiz","GeographyQuiz"],source:"archive_org",default_topic:"maps",media:"image",support:"direct",fallback_mode:"ImageQuiz",reason:"public-domain maps" },
      { mode:"WhosThat",aliases:["Who's That","WhoIsThat"],source:"archive_org",default_topic:"portraits",media:"image",support:"direct",fallback_mode:"ImageQuiz",reason:"public-domain portraits" },
      { mode:"AIHost",aliases:["AI Host"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"CustomTopic",reason:"host presentation mode uses approved generic questions" },
      { mode:"AITutor",aliases:["AI Tutor"],source:"scholar",default_topic:"science",media:"none",support:"fallback",fallback_mode:"CustomTopic",reason:"tutor presentation mode uses cited/global fallback" },
      { mode:"AIFortuneTeller",aliases:["AI Fortune Teller"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"FortuneQuiz",reason:"entertainment-only approved fallback" },
      { mode:"LocalBattle",aliases:["Local Battle"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"SoloChallenge",reason:"delivery shell; approved generic questions" },
      { mode:"LiveArena",aliases:["Live Arena"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"SoloChallenge",reason:"multiplayer shell; approved generic questions" },
      { mode:"Tournament",aliases:["TournamentQuiz"],source:"gutenberg",default_topic:"general",media:"none",support:"fallback",fallback_mode:"SoloChallenge",reason:"competition shell; approved generic questions" },
      { mode:"CustomTopic",aliases:["Custom Topic"],source:"wolfram",default_topic:"math",media:"optional",support:"direct",fallback_mode:"MultipleChoiceQuiz",reason:"topic-specific connector matrix" },
      { mode:"PickATopic",aliases:["Pick A Topic","TopicPicker"],source:"gutenberg",default_topic:"history",media:"none",support:"direct",fallback_mode:"CustomTopic",reason:"public-domain topic packs" },
      { mode:"MediaQuiz",aliases:["MoviesQuiz","MovieQuiz","Movie Quiz"],source:"justwatch",default_topic:"film",media:"image",support:"direct",fallback_mode:"ImageQuiz",reason:"film/show metadata and archive media" },
      { mode:"SubjectiveQuiz",aliases:["Subjective","LearnMode"],source:"scholar",default_topic:"science",media:"none",support:"direct",fallback_mode:"CustomTopic",reason:"cited study questions" },
      { mode:"NewsQuiz",aliases:["News","CurrentAffairs"],source:"justwatch",default_topic:"news",media:"optional",support:"fallback",fallback_mode:"ViralIQ",reason:"dedicated news RPC remains primary; factual trending fallback" },
      { mode:"FocusMode",aliases:["Focus","StudyMode"],source:"scholar",default_topic:"study",media:"none",support:"fallback",fallback_mode:"SubjectiveQuiz",reason:"focus audio is separate; approved study-question fallback" }
    ];
  }

  export function resolveMode(input: string): ModeDefinition | null {
    var wanted = slugify(input);
    var defs = modeRegistry();
    for (var i = 0; i < defs.length; i++) {
      if (slugify(defs[i].mode) === wanted) return defs[i];
      for (var a = 0; a < defs[i].aliases.length; a++) {
        if (slugify(defs[i].aliases[a]) === wanted) return defs[i];
      }
    }
    return null;
  }

  // ISO-3166 alpha-2 allowlist. This rejects syntactically valid but invented
  // codes; "XX" is reserved internally for global and is never accepted.
  var ISO_COUNTRIES = ("AD,AE,AF,AG,AI,AL,AM,AO,AQ,AR,AS,AT,AU,AW,AX,AZ,BA,BB,BD,BE,BF,BG,BH,BI,BJ,BL,BM,BN,BO,BQ,BR,BS,BT,BV,BW,BY,BZ,CA,CC,CD,CF,CG,CH,CI,CK,CL,CM,CN,CO,CR,CU,CV,CW,CX,CY,CZ,DE,DJ,DK,DM,DO,DZ,EC,EE,EG,EH,ER,ES,ET,FI,FJ,FK,FM,FO,FR,GA,GB,GD,GE,GF,GG,GH,GI,GL,GM,GN,GP,GQ,GR,GS,GT,GU,GW,GY,HK,HM,HN,HR,HT,HU,ID,IE,IL,IM,IN,IO,IQ,IR,IS,IT,JE,JM,JO,JP,KE,KG,KH,KI,KM,KN,KP,KR,KW,KY,KZ,LA,LB,LC,LI,LK,LR,LS,LT,LU,LV,LY,MA,MC,MD,ME,MF,MG,MH,MK,ML,MM,MN,MO,MP,MQ,MR,MS,MT,MU,MV,MW,MX,MY,MZ,NA,NC,NE,NF,NG,NI,NL,NO,NP,NR,NU,NZ,OM,PA,PE,PF,PG,PH,PK,PL,PM,PN,PR,PS,PT,PW,PY,QA,RE,RO,RS,RU,RW,SA,SB,SC,SD,SE,SG,SH,SI,SJ,SK,SL,SM,SN,SO,SR,SS,ST,SV,SX,SY,SZ,TC,TD,TF,TG,TH,TJ,TK,TL,TM,TN,TO,TR,TT,TV,TW,TZ,UA,UG,UM,US,UY,UZ,VA,VC,VE,VG,VI,VN,VU,WF,WS,YE,YT,ZA,ZM,ZW").split(",");

  export function validCountry(value: any): string {
    var cc = ("" + (value || "")).trim().toUpperCase();
    return cc.length === 2 && ISO_COUNTRIES.indexOf(cc) >= 0 ? cc : "";
  }

  export interface GeoProfile {
    country: string;
    basis: string;
    locale: string;
  }

  export function resolveGeo(ctx: nkruntime.Context, nk: nkruntime.Nakama, userId: string, data: any): GeoProfile {
    data = data || {};
    var explicitCountry = validCountry(data.country || data.country_code);
    var explicitLocale = ("" + (data.locale || data.language || "")).substring(0, 20);
    if (explicitCountry) return { country: explicitCountry, basis: "payload_country", locale: explicitLocale };
    var localeMatch = /[-_]([A-Za-z]{2})$/.exec(explicitLocale);
    if (localeMatch) {
      var localeCountry = validCountry(localeMatch[1]);
      if (localeCountry) return { country: localeCountry, basis: "payload_locale", locale: explicitLocale };
    }
    try {
      var account: any = nk.accountGetId(userId);
      var user: any = account && account.user ? account.user : {};
      var md: any = user.metadata || {};
      if (typeof md === "string") { try { md = JSON.parse(md); } catch (e) { md = {}; } }
      var profileCountry = validCountry(md.country_code || md.country || user.location);
      if (profileCountry) return { country: profileCountry, basis: "profile_country", locale: "" + (user.langTag || "") };
      var accountLocale = "" + (user.langTag || md.locale || md.language || "");
      var accountMatch = /[-_]([A-Za-z]{2})$/.exec(accountLocale);
      if (accountMatch) {
        var accountCountry = validCountry(accountMatch[1]);
        if (accountCountry) return { country: accountCountry, basis: "profile_locale", locale: accountLocale };
      }
    } catch (e2) { /* privacy-safe global fallback */ }
    var contextLocale = "" + (((ctx as any).lang || (ctx as any).langTag || ""));
    var contextMatch = /[-_]([A-Za-z]{2})$/.exec(contextLocale);
    if (contextMatch) {
      var contextCountry = validCountry(contextMatch[1]);
      if (contextCountry) return { country: contextCountry, basis: "context_locale", locale: contextLocale };
    }
    return { country: "", basis: "global", locale: explicitLocale || contextLocale };
  }

  // ── Small helpers ───────────────────────────────────────────────────────────
  export function nowMs(): number {
    return Date.now();
  }

  export function isoTime(ms: number): string {
    return new Date(ms).toISOString();
  }

  export function slugify(s: string): string {
    return ("" + (s || ""))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .substring(0, 64) || "general";
  }

  export function poolKey(mode: string, topic: string): string {
    return slugify(mode) + "_" + slugify(topic);
  }

  export function stagedKey(mode: string, topic: string, country: string): string {
    return poolKey(mode, topic) + "_geo_" + (validCountry(country) || "global").toLowerCase();
  }

  // Stable content-hash id — mirrors quizverse_quiz_generate.js convention so
  // the same question sourced twice always dedupes.
  export function questionId(nk: nkruntime.Nakama, source: string, question: string, options: string[]): string {
    var sorted = (options || []).slice(0).sort();
    var raw = slugify(question).substring(0, 48) + "|" + sorted.join("|").toLowerCase();
    var hex = nk.sha256Hash(raw);
    return "sq_" + slugify(source).substring(0, 12) + "_" + hex.substring(0, 12);
  }

  export function shuffle<T>(arr: T[]): T[] {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  export function randSuffix(): string {
    return Math.random().toString(36).slice(2, 8);
  }

  export function clampInt(v: any, lo: number, hi: number, dflt: number): number {
    var n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  // ── Storage helpers ─────────────────────────────────────────────────────────
  export function readSystem(nk: nkruntime.Nakama, collection: string, key: string): any {
    try {
      var rows = nk.storageRead([{ collection: collection, key: key, userId: "00000000-0000-0000-0000-000000000000" }]);
      if (rows && rows.length > 0 && rows[0].value) return rows[0].value;
    } catch (e) { /* not found is fine */ }
    return null;
  }

  export function writeSystem(nk: nkruntime.Nakama, collection: string, key: string, value: any): void {
    nk.storageWrite([{
      collection: collection,
      key: key,
      userId: "00000000-0000-0000-0000-000000000000",
      value: value,
      permissionRead: 2,
      permissionWrite: 0
    }]);
  }

  export function readUser(nk: nkruntime.Nakama, collection: string, key: string, userId: string): any {
    try {
      var rows = nk.storageRead([{ collection: collection, key: key, userId: userId }]);
      if (rows && rows.length > 0 && rows[0].value) return rows[0].value;
    } catch (e) { /* not found is fine */ }
    return null;
  }

  export function writeUser(nk: nkruntime.Nakama, collection: string, key: string, userId: string, value: any): void {
    nk.storageWrite([{
      collection: collection,
      key: key,
      userId: userId,
      value: value,
      permissionRead: 1,
      permissionWrite: 0
    }]);
  }

  // ── Seen-ledger bridge (uniqueness guarantee) ───────────────────────────────
  // Uses the battle-tested OCC implementation from quizverse_seen.js when
  // present (always true in the merged bundle); falls back to a local ledger
  // in the sq_staged collection so unit contexts don't explode.
  export function seenTopic(mode: string, topic: string): string {
    return slugify(mode) + "_" + slugify(topic);
  }

  export function getSeenIdSet(nk: nkruntime.Nakama, userId: string, mode: string, topic: string): { [id: string]: boolean } {
    try {
      if (typeof __qvsSeen !== "undefined" && __qvsSeen && __qvsSeen.getIdSet) {
        return __qvsSeen.getIdSet(nk, userId, SEEN_SCOPE, seenTopic(mode, topic)) || {};
      }
    } catch (e) { /* fall through */ }
    var doc = readUser(nk, COLL_STAGED, "seen_fallback_" + seenTopic(mode, topic), userId);
    return (doc && doc.ids) ? doc.ids : {};
  }

  export function mergeSeenIds(nk: nkruntime.Nakama, userId: string, mode: string, topic: string, ids: string[]): void {
    if (!ids || ids.length === 0) return;
    try {
      if (typeof __qvsSeen !== "undefined" && __qvsSeen && __qvsSeen.merge) {
        __qvsSeen.merge(nk, userId, SEEN_SCOPE, seenTopic(mode, topic), ids);
        return;
      }
    } catch (e) { /* fall through */ }
    var key = "seen_fallback_" + seenTopic(mode, topic);
    var doc = readUser(nk, COLL_STAGED, key, userId) || { ids: {} };
    for (var i = 0; i < ids.length; i++) doc.ids[ids[i]] = nowMs();
    writeUser(nk, COLL_STAGED, key, userId, doc);
  }

  // ── Adaptive difficulty (per userID + topic) ────────────────────────────────
  // Reads the same quiz-verse_quiz_history document that quiz_results.js
  // appends to and quizverse_depth.js aggregates for the knowledge map.
  // Topic-specific accuracy wins when we have >=5 samples; otherwise overall.
  export interface AdaptiveProfile {
    target_difficulty: number;    // 1..5
    basis: string;                // "topic" | "overall" | "default"
    sample_size: number;
    accuracy_pct: number;
  }

  export interface BehaviorProfile {
    basis: string;
    signals_used: string[];
    samples: number;
    minimum_samples: number;
    weakest_topics: string[];
    recent_miss_topics: string[];
    avg_response_ms: number;
    generated_at: string;
    unsupported_signals: string[];
  }

  // Uses the persisted per-user quiz history written by quiz_submit_result.
  // It intentionally does not invent preferred-mode, abandon, or media-affinity
  // signals: those events exist in analytics_events but are not currently
  // materialized into a cheap user-owned read model.
  export function computeBehaviorProfile(nk: nkruntime.Nakama, userId: string): BehaviorProfile {
    var history: any = readUser(nk, "quiz-verse_quiz_history", "history", userId);
    var entries: any[] = (history && history.entries) ? history.entries : [];
    if (entries.length > HISTORY_READ_CAP) entries = entries.slice(entries.length - HISTORY_READ_CAP);
    var stats: { [topic: string]: any } = {};
    var recentMisses: string[] = [];
    var totalMs = 0, timed = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i] || {};
      var topic = slugify(e.category || e.categoryName || e.categoryId || "general");
      if (!stats[topic]) stats[topic] = { total: 0, correct: 0 };
      stats[topic].total++;
      var correct = e.correct !== undefined ? !!e.correct : !!e.was_correct;
      if (correct) stats[topic].correct++;
      else if (i >= entries.length - 20 && recentMisses.indexOf(topic) < 0) recentMisses.push(topic);
      var ms = parseInt(e.time_ms || e.timeMs || 0, 10);
      if (ms > 0 && ms < 120000) { totalMs += ms; timed++; }
    }
    var topics = Object.keys(stats);
    topics.sort(function (a: string, b: string): number {
      var aa = stats[a].correct / stats[a].total;
      var ba = stats[b].correct / stats[b].total;
      if (aa !== ba) return aa - ba;
      if (stats[a].total !== stats[b].total) return stats[b].total - stats[a].total;
      return a < b ? -1 : 1;
    });
    var signals: string[] = [];
    if (entries.length >= 5) signals.push("topic_accuracy");
    if (recentMisses.length > 0) signals.push("recent_misses");
    if (timed >= 5) signals.push("response_latency");
    return {
      basis: entries.length >= 5 ? "quiz_history" : "sparse_history_fallback",
      signals_used: signals,
      samples: entries.length,
      minimum_samples: 5,
      weakest_topics: entries.length >= 5 ? topics.slice(0, 3) : [],
      recent_miss_topics: recentMisses.slice(0, 5),
      avg_response_ms: timed > 0 ? Math.round(totalMs / timed) : 0,
      generated_at: isoTime(nowMs()),
      unsupported_signals: ["preferred_modes", "skip_abandon_frustration", "media_affinity"]
    };
  }

  export function computeAdaptiveProfile(nk: nkruntime.Nakama, userId: string, topic: string): AdaptiveProfile {
    var history: any = readUser(nk, "quiz-verse_quiz_history", "history", userId);
    var entries = (history && history.entries && history.entries.length) ? history.entries : [];
    if (entries.length > HISTORY_READ_CAP) entries = entries.slice(entries.length - HISTORY_READ_CAP);

    var topicSlug = slugify(topic);
    var tTotal = 0, tCorrect = 0, oTotal = 0, oCorrect = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e !== "object") continue;
      var correct = e.correct !== undefined ? !!e.correct : !!e.was_correct;
      oTotal++;
      if (correct) oCorrect++;
      var cat = slugify(e.category || e.categoryName || e.categoryId || "");
      if (cat && (cat === topicSlug || cat.indexOf(topicSlug) >= 0 || topicSlug.indexOf(cat) >= 0)) {
        tTotal++;
        if (correct) tCorrect++;
      }
    }

    var basis = "default";
    var total = 0, correctN = 0;
    if (tTotal >= 5) { basis = "topic"; total = tTotal; correctN = tCorrect; }
    else if (oTotal >= 5) { basis = "overall"; total = oTotal; correctN = oCorrect; }

    var acc = total > 0 ? Math.round((correctN / total) * 100) : 0;
    var target = 2; // sensible default for a fresh user
    if (basis !== "default") {
      if (acc >= 90) target = 5;
      else if (acc >= 75) target = 4;
      else if (acc >= 55) target = 3;
      else if (acc >= 35) target = 2;
      else target = 1;
    }

    return { target_difficulty: target, basis: basis, sample_size: total, accuracy_pct: acc };
  }

  // ── Media optimization (squoosh-equivalent, source #7) ─────────────────────
  // Rewrites media URLs through the wsrv.nl image proxy (already used by the
  // Unity client's MediaProxyUtility) so every staged image ships resized +
  // webp-compressed — smaller loads, faster D1 quiz starts, no WASM needed
  // server-side.
  export function optimizeMediaUrl(url: string): string {
    if (!url || url.indexOf("http") !== 0) return url || "";
    if (url.indexOf("wsrv.nl") >= 0) return url;
    // Only images benefit; leave audio/video untouched.
    var lower = url.toLowerCase();
    var isAudioVideo = /\.(mp3|m4a|ogg|wav|mp4|webm|mov)(\?|$)/.test(lower);
    if (isAudioVideo) return url;
    return "https://wsrv.nl/?url=" + encodeURIComponent(url) + "&w=720&q=72&output=webp";
  }

  // ── HTTP helper with system-storage cache ───────────────────────────────────
  export function cachedHttpGet(nk: nkruntime.Nakama, logger: nkruntime.Logger, url: string, ttlMs: number, headers?: any): string | null {
    var cacheKey = "get:" + nk.sha256Hash(url).substring(0, 24);
    var cached = readSystem(nk, COLL_SOURCE_CACHE, cacheKey);
    if (cached && cached.body && (nowMs() - (cached.fetched_ms || 0)) < (cached.ttl_ms || ttlMs)) {
      return cached.body;
    }
    // NOTE: log the URL without its query string — Nakama's Go logger treats
    // the message as a printf format string, so percent-escapes get mangled.
    var logUrl = url.split("?")[0];
    try {
      var resp = nk.httpRequest(url, "get", headers || { "Accept": "application/json" }, "", 15000);
      if (resp.code >= 200 && resp.code < 300 && resp.body) {
        // Cap what we cache — Goja strings are fine but storage rows shouldn't balloon.
        if (resp.body.length < 400000) {
          writeSystem(nk, COLL_SOURCE_CACHE, cacheKey, { fetched_ms: nowMs(), ttl_ms: ttlMs, url: url, body: resp.body });
        }
        return resp.body;
      }
      logger.warn("[SeedQ] http GET " + logUrl + " -> " + resp.code);
    } catch (err: any) {
      logger.warn("[SeedQ] http GET failed " + logUrl + ": " + (err && err.message ? err.message : String(err)));
    }
    // Serve stale cache on failure rather than nothing.
    return (cached && cached.body) ? cached.body : null;
  }
}
