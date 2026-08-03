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

  export var MODULE_VERSION = "seed-questions/1.0.0";

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
  export var CONSUMED_SET_TTL_MS = 7 * 86400 * 1000;
  export var SEEN_SCOPE = "seedq";     // qv_seen scope for this engine
  export var HISTORY_READ_CAP = 200;   // newest history entries for adaptive calc

  // ── Per-Topic Configuration ─────────────────────────────────────────────────
  // Curated search strategies per topic — replaces the one-size-fits-all keyword
  // search in archive.org. Controls query boosting, negative filters, NSFW
  // blocklists, Wikipedia web-scraping fallback, and question templates.
  export interface TopicConfig {
    query_boost: string;           // appended to archive.org search query
    negative_filter: string[];     // reject items matching these in title/subject
    wikipedia_list_page: string;   // Wikipedia list article for web-scraping titles
    franchise_creators: string[];  // required creator/subject values for franchise topics
    nsfw_block: string[];          // extra NSFW terms to reject for this topic
    min_title_words: number;       // minimum readable words in item title
    question_templates: string[];  // per-topic question text variations
  }

  // Global NSFW blocklist applied to ALL topics before per-topic nsfw_block.
  export var GLOBAL_NSFW_TERMS: string[] = [
    "18+", "nsfw", "hentai", "porn", "xxx", "erotic", "nude", "naked",
    "gore", "dismember", "torture", "snuff", "slaughter", "corpse",
    "racial slur", "white power", "hate speech", "extremist",
    "child abuse", "exploitation", "pedophil"
  ];

  export var DEFAULT_TOPIC_CONFIG: TopicConfig = {
    query_boost: "",
    negative_filter: ["scam", "spam", "advertisement", "broken link", "test upload"],
    wikipedia_list_page: "",
    franchise_creators: [],
    nsfw_block: [],
    min_title_words: 2,
    question_templates: [
      "What is shown in this image?",
      "Can you identify what this image shows?",
      "Name what you see in this picture."
    ]
  };

  export var TOPIC_CONFIGS: { [slug: string]: TopicConfig } = {
    "anime": {
      query_boost: 'AND (subject:("animation" OR "manga" OR "japanese animation"))',
      negative_filter: ["convention", "cosplay", "expo", "gathering", "newsletter", "program guide",
        "retail", "store display", "gamescom", "psx", "playstation", "xbox",
        "game trade", "magazine", "sell sheet", "central park media",
        "personal photo", "selfie", "graduation", "receipt"],
      wikipedia_list_page: "List_of_anime_series",
      franchise_creators: [],
      nsfw_block: ["hentai", "ecchi", "eroge", "visual novel 18", "doujin"],
      min_title_words: 2,
      question_templates: [
        "Which anime is shown in this image?",
        "Can you identify this anime?",
        "Name the anime shown here.",
        "What anime does this image belong to?"
      ]
    },
    "dog": {
      query_boost: 'AND (subject:("dogs" OR "canine" OR "dog breed" OR "puppy"))',
      negative_filter: ["collar ad", "leash ad", "pet store", "retail", "graduation",
        "thunderstorm", "restaurant", "hot dog", "certificate", "newsletter",
        "clipart", "line art", "coloring page"],
      wikipedia_list_page: "List_of_dog_breeds",
      franchise_creators: [],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "What breed of dog is shown?",
        "Can you identify this dog breed?",
        "Name the dog breed in this image.",
        "What kind of dog is this?"
      ]
    },
    "cat": {
      query_boost: 'AND (subject:("cats" OR "feline" OR "cat breed" OR "kitten"))',
      negative_filter: ["caterpillar", "catalog", "category", "pet store", "retail",
        "clipart", "coloring page", "line art"],
      wikipedia_list_page: "List_of_cat_breeds",
      franchise_creators: [],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "What breed of cat is shown?",
        "Can you identify this cat breed?",
        "Name the cat breed in this image.",
        "What kind of cat is this?"
      ]
    },
    "ghibli": {
      query_boost: 'AND (subject:("studio ghibli" OR "hayao miyazaki" OR "isao takahata"))',
      negative_filter: ["mr beast", "mrbeast", "personal photo", "selfie", "convention",
        "cosplay", "merchandise", "bootleg", "fan art"],
      wikipedia_list_page: "Studio_Ghibli_filmography",
      franchise_creators: ["Studio Ghibli", "Hayao Miyazaki", "Isao Takahata"],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "Which Studio Ghibli film is this from?",
        "Name the Ghibli movie shown here.",
        "Identify this Studio Ghibli scene.",
        "What Ghibli film does this belong to?"
      ]
    },
    "disney": {
      query_boost: 'AND (subject:("walt disney" OR "disney animation" OR "disney pixar"))',
      negative_filter: ["personal photo", "selfie", "vacation", "family photo",
        "theme park", "disneyland line", "merchandise", "bootleg"],
      wikipedia_list_page: "List_of_Walt_Disney_Animation_Studios_films",
      franchise_creators: ["Walt Disney", "Disney", "Pixar"],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "Which Disney film is this from?",
        "Name the Disney movie shown here.",
        "Identify this Disney character or scene.",
        "What Disney production is this?"
      ]
    },
    "marvel": {
      query_boost: 'AND (subject:("marvel" OR "avengers" OR "marvel comics"))',
      negative_filter: ["personal photo", "selfie", "cosplay", "convention",
        "merchandise", "toy", "action figure", "bootleg"],
      wikipedia_list_page: "List_of_Marvel_Cinematic_Universe_films",
      franchise_creators: ["Marvel", "Marvel Studios", "Marvel Comics"],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "Which Marvel movie or character is this?",
        "Name the Marvel character shown.",
        "Identify this Marvel scene.",
        "What Marvel property is this from?"
      ]
    },
    "pokemon": {
      query_boost: 'AND (subject:("pokemon" OR "pokémon" OR "pocket monsters"))',
      negative_filter: ["personal photo", "selfie", "bootleg", "knockoff",
        "rom hack", "fan game", "merchandise"],
      wikipedia_list_page: "List_of_Pokémon",
      franchise_creators: ["Nintendo", "Game Freak", "The Pokémon Company"],
      nsfw_block: [],
      min_title_words: 1,
      question_templates: [
        "Which Pokémon is shown here?",
        "Name this Pokémon.",
        "Can you identify this Pokémon?",
        "What Pokémon is in this image?"
      ]
    },
    "naruto": {
      query_boost: 'AND (subject:("naruto" OR "naruto shippuden" OR "boruto"))',
      negative_filter: ["personal photo", "selfie", "cosplay", "convention",
        "merchandise", "bootleg", "fan art"],
      wikipedia_list_page: "List_of_Naruto_characters",
      franchise_creators: ["Masashi Kishimoto", "Studio Pierrot"],
      nsfw_block: [],
      min_title_words: 1,
      question_templates: [
        "Which Naruto character is shown?",
        "Name this Naruto character.",
        "Identify this scene from Naruto.",
        "Who is this Naruto character?"
      ]
    },
    "one_piece": {
      query_boost: 'AND (subject:("one piece" OR "eiichiro oda"))',
      negative_filter: ["personal photo", "selfie", "cosplay", "convention",
        "merchandise", "bootleg", "fan art", "one piece swimsuit"],
      wikipedia_list_page: "List_of_One_Piece_characters",
      franchise_creators: ["Eiichiro Oda", "Toei Animation"],
      nsfw_block: [],
      min_title_words: 1,
      question_templates: [
        "Which One Piece character is shown?",
        "Name this One Piece character.",
        "Identify this scene from One Piece.",
        "Who is this One Piece character?"
      ]
    },
    "dragon_ball": {
      query_boost: 'AND (subject:("dragon ball" OR "akira toriyama" OR "dragon ball z"))',
      negative_filter: ["personal photo", "selfie", "cosplay", "convention",
        "merchandise", "bootleg", "fan art"],
      wikipedia_list_page: "List_of_Dragon_Ball_characters",
      franchise_creators: ["Akira Toriyama", "Toei Animation"],
      nsfw_block: [],
      min_title_words: 1,
      question_templates: [
        "Which Dragon Ball character is shown?",
        "Name this Dragon Ball character.",
        "Identify this Dragon Ball scene.",
        "Who is this Dragon Ball character?"
      ]
    },
    "harry_potter": {
      query_boost: 'AND (subject:("harry potter" OR "wizarding world" OR "hogwarts"))',
      negative_filter: ["personal photo", "selfie", "cosplay", "convention",
        "merchandise", "bootleg", "theme park", "universal studios"],
      wikipedia_list_page: "Harry_Potter",
      franchise_creators: ["Warner Bros", "J. K. Rowling"],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "Which Harry Potter character or scene is this?",
        "Name the Harry Potter character shown.",
        "Identify this scene from Harry Potter.",
        "What Harry Potter movie is this from?"
      ]
    },
    "history": {
      query_boost: 'AND (subject:("history" OR "historical" OR "vintage" OR "antique"))',
      negative_filter: ["scam", "spam", "advertisement", "test", "unknown"],
      wikipedia_list_page: "",
      franchise_creators: [],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "What historical subject is shown in this image?",
        "Can you identify this historical image?",
        "Name the historical item or event shown."
      ]
    },
    "nature": {
      query_boost: 'AND (subject:("nature" OR "wildlife" OR "landscape" OR "flora" OR "fauna"))',
      negative_filter: ["advertisement", "product", "test", "logo"],
      wikipedia_list_page: "",
      franchise_creators: [],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "What natural subject is shown in this image?",
        "Can you identify what's in this nature photo?",
        "Name the animal or plant shown here."
      ]
    },
    "science": {
      query_boost: 'AND (subject:("science" OR "scientific" OR "physics" OR "chemistry" OR "biology"))',
      negative_filter: ["pseudoscience", "flat earth", "anti-vax", "conspiracy"],
      wikipedia_list_page: "",
      franchise_creators: [],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "What scientific concept or discovery is shown?",
        "Can you identify this scientific image?",
        "Name the scientific subject in this image."
      ]
    },
    "geography": {
      query_boost: 'AND (subject:("geography" OR "countries" OR "landmarks" OR "maps"))',
      negative_filter: ["advertisement", "product", "test", "logo"],
      wikipedia_list_page: "",
      franchise_creators: [],
      nsfw_block: [],
      min_title_words: 2,
      question_templates: [
        "What place or landmark is shown in this image?",
        "Can you identify this location?",
        "Name the country or landmark shown here."
      ]
    }
  };

  /** Resolve a topic string to its curated config, falling back to defaults. */
  export function topicConfig(topic: string): TopicConfig {
    return TOPIC_CONFIGS[slugify(topic)] || DEFAULT_TOPIC_CONFIG;
  }

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
  }

  export interface StagedSet {
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
    consumed_ms: number;
  }

  // ── Small helpers ───────────────────────────────────────────────────────────
  export function nowMs(): number {
    return Date.now();
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

  // ── Security helpers ────────────────────────────────────────────────────────
  var MAX_HTTP_BODY_BYTES = 1048576; // 1 MiB — reject oversized cache rows
  var PRIVATE_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|metadata\.google\.internal)$/i;

  /** Admin/cron RPCs: http_key only (ctx.userId empty). Optional service_token when env is set. */
  export function isHttpKeyAdmin(ctx: nkruntime.Context, data: any): boolean {
    if (ctx.userId) return false;
    var expected = "" + ((ctx.env && ctx.env["SEEDQ_SERVICE_TOKEN"]) || "");
    if (!expected) return true;
    var token = data && data.service_token;
    return token === expected;
  }

  /** Block SSRF targets (RFC1918, link-local, metadata) for outbound fetches. */
  export function isPublicHttpsUrl(url: string): boolean {
    if (!url || url.indexOf("https://") !== 0) return false;
    var m = /^https:\/\/([^\/\?#:]+)(?::(\d+))?/i.exec(url);
    if (!m) return false;
    var host = m[1].toLowerCase();
    if (PRIVATE_HOST_RE.test(host)) return false;
    if (host.indexOf("169.254.") === 0) return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false;
    if (host === "[::1]" || host.indexOf("fe80:") === 0) return false;
    return true;
  }

  // Rewrites media URLs through the wsrv.nl image proxy (already used by the
  // Unity client's MediaProxyUtility) so every staged image ships resized +
  // JPG-compressed — Unity's Texture2D.LoadImage reliably decodes JPEG/PNG but
  // NOT WebP in production builds. 1024px width at quality 85 is crisp on
  // modern 1080p+ mobile screens while keeping file sizes reasonable.
  export function optimizeMediaUrl(url: string): string {
    if (!url || url.indexOf("http") !== 0) return url || "";
    if (url.indexOf("wsrv.nl") >= 0) return url;
    // Only images benefit; leave audio/video untouched.
    var lower = url.toLowerCase();
    var isAudioVideo = /\.(mp3|m4a|ogg|wav|mp4|webm|mov)(\?|$)/.test(lower);
    if (isAudioVideo) return url;
    return "https://wsrv.nl/?url=" + encodeURIComponent(url) + "&w=1024&q=85&output=jpg";
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
        if (resp.body.length > MAX_HTTP_BODY_BYTES) {
          logger.warn("[SeedQ] http GET body too large " + logUrl + " bytes=" + resp.body.length);
          return (cached && cached.body) ? cached.body : null;
        }
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
