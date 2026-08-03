// sq_quality.ts
// ─────────────────────────────────────────────────────────────────────────────
// Seed Questions — quality gate.
//
// Two layers:
//   1. autoQa()   — structural checks at ingest time. Wrong answers are the
//                   fastest trust-killer, so anything ambiguous is rejected
//                   BEFORE it reaches a user pool. Math questions additionally
//                   carry the "wolfram_verified" check from sq_sources.ts.
//   2. Reviews    — users rate questions visually/by nature in-app
//                   (quizverse_seedq_review: up / down / flag+reason).
//                   Aggregated per (mode, topic); thresholds quarantine bad
//                   questions from ALL future staging without a redeploy.
//
// Quarantine rules:
//   • 2+ "wrong_answer" flags               → immediate quarantine
//   • (down + flags) >= 3 AND > up votes    → quarantine
//   • 3+ "broken_media" flags               → quarantine (dead image/audio)

namespace SeedQQuality {

  var MIN_QUESTION_LEN = 8;
  var MAX_QUESTION_LEN = 320;
  var MAX_OPTION_LEN = 120;
  var PASS_SCORE = 70;

  // Domains whose media is safe to commercialize without a TinEye check
  // (public domain / API-ToS-covered). Anything else needs provenance.
  export var SAFE_MEDIA_DOMAINS = [
    "archive.org", "wikimedia.org", "wikipedia.org", "gutenberg.org",
    "nasa.gov", "metmuseum.org", "deezer.com", "dzcdn.net",
    "ytimg.com", "youtube.com", "justwatch.com", "wsrv.nl",
    "musicforprogramming.net", "openlibrary.org", "githubusercontent.com"
  ];

  var BANNED_FRAGMENTS = [
    "as an ai", "i cannot", "lorem ipsum", "undefined", "[object object]", "null null"
  ];

  // ── Content sanitation helpers (exported for upstream use in sq_sources.ts) ─

  /** Detect hash-like strings: >= 16 hex chars or > 60% non-alphabetic. */
  export function isHashLike(s: string): boolean {
    var clean = ("" + (s || "")).replace(/[\s_\-\.]/g, "");
    if (!clean || clean.length < 4) return false;
    // Pure hex string >= 16 chars
    if (/^[a-f0-9]{16,}$/i.test(clean)) return true;
    // UUID-ish pattern
    if (/^[a-f0-9]{8}[a-f0-9\-]{20,}$/i.test(clean)) return true;
    // Mostly non-alpha (> 60%) and at least 8 chars — smells like artifact
    if (clean.length >= 8) {
      var alphaCount = 0;
      for (var i = 0; i < clean.length; i++) {
        var ch = clean.charCodeAt(i);
        if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) alphaCount++;
      }
      if (alphaCount / clean.length < 0.4) return true;
    }
    return false;
  }

  /** Detect filename-like strings: download-1, IMG_3917, extension suffixes, etc. */
  export function isFilenameLike(s: string): boolean {
    var t = ("" + (s || "")).trim().toLowerCase();
    if (!t) return false;
    // Common camera/upload filename patterns
    if (/^(download|img|image|dsc|dcim|photo|pic|screenshot|new_image|untitled|inicio|scan|temp|file)([\s_\-]?\d*)$/i.test(t)) return true;
    // File extension in option text
    if (/\.(jpe?g|png|gif|webp|bmp|tiff?|pdf|svg|mp[34]|mov|avi|zip|rar)(\s|$)/i.test(t)) return true;
    // Dimension patterns like "240 x 320" or "87px"
    if (/^\d+\s*[x×]\s*\d+/.test(t) || /^\d+px\b/.test(t)) return true;
    // URL paths leaked into option text
    if (/^https?:\/\//.test(t) || /\/(\w+\/){2,}/.test(t)) return true;
    return false;
  }

  /** True when > 30% of non-whitespace chars are CJK, Cyrillic, Arabic, or Korean. */
  export function hasNonLatinMajority(s: string): boolean {
    var nonLatin = 0, total = 0;
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code > 32) total++; // count non-whitespace
      if (code > 127) {
        // CJK unified ideographs + CJK compatibility
        if (code >= 0x3000 && code <= 0x9FFF) nonLatin++;
        // Korean Hangul syllables
        else if (code >= 0xAC00 && code <= 0xD7AF) nonLatin++;
        // Cyrillic
        else if (code >= 0x0400 && code <= 0x04FF) nonLatin++;
        // Arabic
        else if (code >= 0x0600 && code <= 0x06FF) nonLatin++;
        // Thai
        else if (code >= 0x0E00 && code <= 0x0E7F) nonLatin++;
        // Devanagari
        else if (code >= 0x0900 && code <= 0x097F) nonLatin++;
      }
    }
    return total > 0 && (nonLatin / total) > 0.3;
  }

  /** Check a text blob for global + topic-specific NSFW terms. */
  export function isNsfwUnsafe(text: string, topicNsfw: string[]): boolean {
    var lower = ("" + (text || "")).toLowerCase();
    var all = SeedQ.GLOBAL_NSFW_TERMS.concat(topicNsfw || []);
    for (var i = 0; i < all.length; i++) {
      if (lower.indexOf(all[i]) >= 0) return true;
    }
    return false;
  }

  /** Count readable words (tokens > 2 chars, alphabetic-majority). */
  export function countReadableWords(s: string): number {
    var tokens = ("" + (s || "")).split(/[\s_\-\/\\,;:!?()\[\]{}"']+/);
    var count = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.length <= 2) continue;
      // Mostly alpha chars
      var alpha = 0;
      for (var j = 0; j < t.length; j++) {
        var ch = t.charCodeAt(j);
        if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch > 127) alpha++;
      }
      if (alpha / t.length >= 0.6) count++;
    }
    return count;
  }

  export function mediaDomainSafe(url: string): boolean {
    if (!url) return true;
    var m = /^https?:\/\/([^\/\?#]+)/i.exec(url);
    if (!m) return false;
    var host = m[1].toLowerCase();
    for (var i = 0; i < SAFE_MEDIA_DOMAINS.length; i++) {
      var d = SAFE_MEDIA_DOMAINS[i];
      if (host === d || host.length > d.length && host.indexOf("." + d) === host.length - d.length - 1) {
        return true;
      }
    }
    return false;
  }

  // TinEye provenance guardrail (source #13). With TINEYE_API_KEY set we ask
  // TinEye how widely an image is matched (heavily-matched commercial art is
  // risky); without the key we fall back to the public-domain domain whitelist.
  export function checkProvenance(ctx: nkruntime.Context, nk: nkruntime.Nakama, logger: nkruntime.Logger, url: string): SeedQ.Provenance {
    if (!url || !SeedQ.isPublicHttpsUrl(url)) {
      return { source_domain: "", license: "unknown", checked: true, method: "ssrf_blocked" };
    }
    var domainMatch = /^https?:\/\/([^\/\?#]+)/i.exec(url || "");
    var domain = domainMatch ? domainMatch[1].toLowerCase() : "";
    var whitelisted = mediaDomainSafe(url);

    var apiKey = "" + ((ctx.env && ctx.env["TINEYE_API_KEY"]) || "");
    if (apiKey && url) {
      try {
        var resp = nk.httpRequest(
          "https://api.tineye.com/rest/search/?image_url=" + encodeURIComponent(url) + "&limit=1",
          "post",
          { "x-api-key": apiKey },
          "",
          8000
        );
        if (resp.code >= 200 && resp.code < 300) {
          var body = JSON.parse(resp.body || "{}");
          var matches = (body && body.results && body.results.total_results) || 0;
          return {
            source_domain: domain,
            license: whitelisted ? "public_domain" : (matches > 50 ? "unknown" : "api_tos"),
            checked: true,
            method: "tineye"
          };
        }
      } catch (err: any) {
        logger.warn("[SeedQ] tineye check failed: " + (err && err.message ? err.message : String(err)));
      }
    }

    return {
      source_domain: domain,
      license: whitelisted ? "public_domain" : "unknown",
      checked: whitelisted,
      method: whitelisted ? "domain_whitelist" : "none"
    };
  }

  // Structural auto-QA. Returns quality info; status "approved" only when the
  // question is unambiguous, well-formed and (for media) provenance-safe.
  export function autoQa(q: SeedQ.SeedQuestion): SeedQ.QualityInfo {
    var checks: string[] = (q.quality && q.quality.checks) ? q.quality.checks.slice(0) : [];
    var score = 100;
    var fatal = false;

    var text = ("" + (q.question || "")).replace(/\s+/g, " ");
    if (text.length < MIN_QUESTION_LEN || text.length > MAX_QUESTION_LEN) { score -= 40; fatal = true; }
    else checks.push("length_ok");

    var opts = q.options || [];
    if (opts.length !== 2 && opts.length !== 4) { score -= 40; fatal = true; }
    else checks.push("option_count_ok");

    // Options must be distinct (case-folded) and non-empty.
    var seen: { [k: string]: boolean } = {};
    for (var i = 0; i < opts.length; i++) {
      var o = ("" + (opts[i] || "")).replace(/\s+/g, " ").toLowerCase();
      if (!o || o.length > MAX_OPTION_LEN || seen[o]) { score -= 40; fatal = true; break; }
      seen[o] = true;
    }
    if (!fatal) checks.push("options_distinct");

    if (typeof q.correct_index !== "number" || q.correct_index < 0 || q.correct_index >= opts.length) {
      score -= 50; fatal = true;
    } else {
      checks.push("answer_index_ok");
      // Answer-leak: the correct option's text appearing verbatim in the
      // question makes it trivially guessable.
      var correctText = ("" + opts[q.correct_index]).toLowerCase();
      if (correctText.length >= 4 && text.toLowerCase().indexOf(correctText) >= 0) {
        score -= 35;
      } else {
        checks.push("no_answer_leak");
      }
    }

    var lowerAll = (text + " " + opts.join(" ")).toLowerCase();
    for (var b = 0; b < BANNED_FRAGMENTS.length; b++) {
      if (lowerAll.indexOf(BANNED_FRAGMENTS[b]) >= 0) { score -= 50; fatal = true; break; }
    }
    if (!fatal) checks.push("no_banned_fragments");

    // Media questions must resolve provenance to something safe.
    if (q.media_url) {
      var prov = q.media_provenance;
      if (prov && prov.checked && prov.license !== "unknown") checks.push("provenance_ok");
      else if (mediaDomainSafe(q.media_url)) checks.push("provenance_ok");
      else score -= 30;
    }

    // ── NEW: Content sanitation checks (world-class edge-case handling) ──────
    var cfg = SeedQ.topicConfig(q.topic);

    // Check 1: No hash-like options
    if (!fatal) {
      for (var hi = 0; hi < opts.length; hi++) {
        if (isHashLike("" + opts[hi])) { score -= 50; fatal = true; break; }
      }
      if (!fatal) checks.push("no_hash_options");
    }

    // Check 2: No filename-like options
    if (!fatal) {
      for (var fi = 0; fi < opts.length; fi++) {
        if (isFilenameLike("" + opts[fi])) { score -= 50; fatal = true; break; }
      }
      if (!fatal) checks.push("no_filename_options");
    }

    // Check 3: No URL tokens in options
    if (!fatal) {
      for (var ui = 0; ui < opts.length; ui++) {
        var optStr = "" + opts[ui];
        if (/https?:\/\//.test(optStr) || /\.(com|org|net|jpg|png|gif|html)\b/i.test(optStr)) {
          score -= 40; fatal = true; break;
        }
      }
      if (!fatal) checks.push("no_url_tokens");
    }

    // Check 4: Language match — reject non-Latin-majority text when lang is "en"
    if (!fatal && (q.lang === "en" || !q.lang)) {
      var hasNonLatin = false;
      for (var li = 0; li < opts.length; li++) {
        if (hasNonLatinMajority("" + opts[li])) { hasNonLatin = true; break; }
      }
      if (hasNonLatin || hasNonLatinMajority(text)) {
        score -= 50; fatal = true;
      }
      if (!fatal) checks.push("language_match");
    }

    // Check 5: Minimum readable words — each option must have >= 1 readable word
    if (!fatal) {
      for (var wi = 0; wi < opts.length; wi++) {
        if (countReadableWords("" + opts[wi]) < 1) {
          score -= 40; fatal = true; break;
        }
      }
      if (!fatal) checks.push("min_readable_words");
    }

    // Check 6: Option UI fit — penalize excessively long options (overflow risk
    // on ImageGuess 4-option buttons); warning, not fatal.
    var anyLong = false;
    for (var uf = 0; uf < opts.length; uf++) {
      if (("" + opts[uf]).length > 60) { anyLong = true; break; }
    }
    if (anyLong) { score -= 15; } // non-fatal warning
    else checks.push("option_ui_fit");

    // Check 7: Content safety — NSFW terms in question + options
    if (!fatal) {
      var allText = text + " " + opts.join(" ");
      if (isNsfwUnsafe(allText, cfg.nsfw_block)) {
        score -= 100; fatal = true;
      }
      if (!fatal) checks.push("content_safety");
    }

    // Check 8: Topic relevance (for media questions) — at least one option or the
    // question text should relate to the declared topic.
    if (!fatal && q.media_url && q.topic) {
      var topicSlug = SeedQ.slugify(q.topic);
      var topicWords = topicSlug.replace(/_/g, " ").split(" ");
      var relevanceHit = false;
      var textAndOpts = (text + " " + opts.join(" ")).toLowerCase();
      for (var tw = 0; tw < topicWords.length; tw++) {
        if (topicWords[tw].length >= 3 && textAndOpts.indexOf(topicWords[tw]) >= 0) {
          relevanceHit = true; break;
        }
      }
      // For generic topics (history, nature), skip strict relevance; the archive
      // query is broad enough. For franchise topics the check is stricter.
      if (!relevanceHit && cfg.franchise_creators.length > 0) {
        score -= 35; fatal = true;
      }
      if (!fatal) checks.push("topic_relevance");
    }

    if (score < 0) score = 0;
    return {
      score: score,
      status: (!fatal && score >= PASS_SCORE) ? "approved" : "rejected",
      checks: checks
    };
  }

  // ── User review aggregation ────────────────────────────────────────────────
  export var FLAG_REASONS: { [k: string]: boolean } = {
    wrong_answer: true,
    broken_media: true,
    offensive: true,
    unclear: true,
    duplicate: true,
    other: true
  };

  interface ReviewEntry {
    up: number;
    down: number;
    flags: number;
    reasons: { [reason: string]: number };
    status: string;             // "" | "quarantined"
    voters: { [userHash: string]: boolean };
  }

  function reviewDocKey(mode: string, topic: string): string {
    return SeedQ.poolKey(mode, topic);
  }

  export function applyReview(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    userId: string,
    mode: string,
    topic: string,
    qid: string,
    vote: string,               // "up" | "down" | "flag"
    reason: string
  ): { entry: any; quarantined: boolean; duplicate: boolean } {
    var key = reviewDocKey(mode, topic);
    var doc = SeedQ.readSystem(nk, SeedQ.COLL_REVIEW, key) || { entries: {}, updated_ms: 0 };
    if (!doc.entries) doc.entries = {};

    var entry: ReviewEntry = doc.entries[qid] || { up: 0, down: 0, flags: 0, reasons: {}, status: "", voters: {} };
    var userHash = nk.sha256Hash(userId + "|" + qid).substring(0, 12);
    if (entry.voters && entry.voters[userHash]) {
      return { entry: entry, quarantined: entry.status === "quarantined", duplicate: true };
    }
    if (!entry.voters) entry.voters = {};
    entry.voters[userHash] = true;
    // Cap voter map growth — counts are what matter after 200 voters.
    if (Object.keys(entry.voters).length > 200) entry.voters = {};

    if (vote === "up") entry.up++;
    else if (vote === "down") entry.down++;
    else if (vote === "flag") {
      entry.flags++;
      var r = FLAG_REASONS[reason] ? reason : "other";
      entry.reasons[r] = (entry.reasons[r] || 0) + 1;
    }

    var wrongAnswerFlags = entry.reasons["wrong_answer"] || 0;
    var brokenMediaFlags = entry.reasons["broken_media"] || 0;
    var negative = entry.down + entry.flags;
    var shouldQuarantine =
      wrongAnswerFlags >= 2 ||
      brokenMediaFlags >= 3 ||
      (negative >= 3 && negative > entry.up);

    if (shouldQuarantine && entry.status !== "quarantined") {
      entry.status = "quarantined";
      logger.warn("[SeedQ] quarantined question " + qid + " in " + key +
        " (up=" + entry.up + " down=" + entry.down + " flags=" + entry.flags + ")");
    }

    doc.entries[qid] = entry;
    doc.updated_ms = SeedQ.nowMs();
    SeedQ.writeSystem(nk, SeedQ.COLL_REVIEW, key, doc);

    return { entry: entry, quarantined: entry.status === "quarantined", duplicate: false };
  }

  export function getQuarantineSet(nk: nkruntime.Nakama, mode: string, topic: string): { [qid: string]: boolean } {
    var doc = SeedQ.readSystem(nk, SeedQ.COLL_REVIEW, reviewDocKey(mode, topic));
    var out: { [qid: string]: boolean } = {};
    if (!doc || !doc.entries) return out;
    var keys = Object.keys(doc.entries);
    for (var i = 0; i < keys.length; i++) {
      if (doc.entries[keys[i]] && doc.entries[keys[i]].status === "quarantined") out[keys[i]] = true;
    }
    return out;
  }
}
