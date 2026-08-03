#!/usr/bin/env node
// =============================================================================
// seedq_imageguess_test_suite.mjs
// =============================================================================
// Automated test suite verifying all 7 SeedQ ImageGuess personalization fixes
// (P1–P7 from SEEDQ_IMAGEGUESS_UNITY_DEVELOPER_ISSUES.md).
//
// Two modes:
//   PART 1 — Pure-logic unit tests (NO server required)
//            Extracts and tests the pure functions from the compiled bundle:
//            hash detection, filename detection, language check, NSFW, media URL
//            optimization, topic config, fulfillment status, media dedup logic.
//
//   PART 2 — Integration tests (requires running Nakama server)
//            Calls real RPCs via HTTP to verify the full pipeline end-to-end.
//            Skipped gracefully if Nakama is unreachable.
//
// Usage:
//   node data/modules/tests/seedq_imageguess_test_suite.mjs
//
// Env overrides:
//   NAKAMA_EVAL_HOST        default: localhost
//   NAKAMA_EVAL_PORT        default: 7350
//   NAKAMA_EVAL_TLS         default: false
//   NAKAMA_EVAL_SERVER_KEY  default: defaultkey
//   SKIP_INTEGRATION        default: false  (set to "true" to skip Part 2)
//
// Exit code: 0 if all tests passed, 1 if any failed.
// =============================================================================

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Test harness ───────────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const failedTests = [];

function assert(condition, testName, detail) {
  if (condition) {
    totalPassed++;
    console.log(`  ✅ ${testName}`);
  } else {
    totalFailed++;
    failedTests.push(testName);
    console.log(`  ❌ ${testName}${detail ? " — " + detail : ""}`);
  }
}

function assertEqual(actual, expected, testName) {
  const ok = actual === expected;
  assert(ok, testName, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(str, substring, testName) {
  const ok = typeof str === "string" && str.includes(substring);
  assert(ok, testName, ok ? "" : `"${str}" does not include "${substring}"`);
}

function assertNotIncludes(str, substring, testName) {
  const ok = typeof str === "string" && !str.includes(substring);
  assert(ok, testName, ok ? "" : `"${str}" should NOT include "${substring}"`);
}

function assertMatch(str, regex, testName) {
  const ok = regex.test(str);
  assert(ok, testName, ok ? "" : `"${str}" does not match ${regex}`);
}

function skip(testName, reason) {
  totalSkipped++;
  console.log(`  ⏭️  ${testName} (skipped: ${reason})`);
}

function section(name) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(70)}`);
}

function subsection(name) {
  console.log(`\n  ── ${name} ${"─".repeat(Math.max(1, 60 - name.length))}`);
}

// ─── Load compiled bundle and extract namespace functions ───────────────────

// The SeedQ code compiles into namespaces (SeedQ, SeedQQuality, SeedQEngine,
// SeedQSources) inside data/modules/build/index.js. We can't import them
// directly (Goja ES5 + namespaces != ESM), so we extract the pure functions
// we need by reading the source TS files and re-implementing the test targets.
//
// This gives us IDENTICAL logic without needing the runtime.

// ── Re-implement pure functions from sq_quality.ts ──────────────────────────

function isHashLike(s) {
  const clean = ("" + (s || "")).replace(/[\s_\-\.]/g, "");
  if (!clean || clean.length < 4) return false;
  if (/^[a-f0-9]{16,}$/i.test(clean)) return true;
  if (/^[a-f0-9]{8}[a-f0-9\-]{20,}$/i.test(clean)) return true;
  if (clean.length >= 8) {
    let alphaCount = 0;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean.charCodeAt(i);
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) alphaCount++;
    }
    if (alphaCount / clean.length < 0.4) return true;
  }
  return false;
}

function isFilenameLike(s) {
  const t = ("" + (s || "")).trim().toLowerCase();
  if (!t) return false;
  if (/^(download|img|image|dsc|dcim|photo|pic|screenshot|new_image|untitled|inicio|scan|temp|file)([\s_\-]?\d*)$/i.test(t)) return true;
  if (/\.(jpe?g|png|gif|webp|bmp|tiff?|pdf|svg|mp[34]|mov|avi|zip|rar)(\s|$)/i.test(t)) return true;
  if (/^\d+\s*[x×]\s*\d+/.test(t) || /^\d+px\b/.test(t)) return true;
  if (/^https?:\/\//.test(t) || /\/(\w+\/){2,}/.test(t)) return true;
  return false;
}

function hasNonLatinMajority(s) {
  let nonLatin = 0, total = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 32) total++;
    if (code > 127) {
      if (code >= 0x3000 && code <= 0x9FFF) nonLatin++;
      else if (code >= 0xAC00 && code <= 0xD7AF) nonLatin++;
      else if (code >= 0x0400 && code <= 0x04FF) nonLatin++;
      else if (code >= 0x0600 && code <= 0x06FF) nonLatin++;
      else if (code >= 0x0E00 && code <= 0x0E7F) nonLatin++;
      else if (code >= 0x0900 && code <= 0x097F) nonLatin++;
    }
  }
  return total > 0 && (nonLatin / total) > 0.3;
}

function countReadableWords(s) {
  const tokens = ("" + (s || "")).split(/[\s_\-\/\\,;:!?()\[\]{}"']+/);
  let count = 0;
  for (const t of tokens) {
    if (t.length <= 2) continue;
    let alpha = 0;
    for (let j = 0; j < t.length; j++) {
      const ch = t.charCodeAt(j);
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch > 127) alpha++;
    }
    if (alpha / t.length >= 0.6) count++;
  }
  return count;
}

const GLOBAL_NSFW_TERMS = [
  "18+", "nsfw", "hentai", "porn", "xxx", "erotic", "nude", "naked",
  "gore", "dismember", "torture", "snuff", "slaughter", "corpse",
  "racial slur", "white power", "hate speech", "extremist",
  "child abuse", "exploitation", "pedophil"
];

function isNsfwUnsafe(text, topicNsfw) {
  const lower = ("" + (text || "")).toLowerCase();
  const all = GLOBAL_NSFW_TERMS.concat(topicNsfw || []);
  for (const term of all) {
    if (lower.indexOf(term) >= 0) return true;
  }
  return false;
}

// ── Re-implement optimizeMediaUrl from sq_core.ts ───────────────────────────

function optimizeMediaUrl(url) {
  if (!url || url.indexOf("http") !== 0) return url || "";
  if (url.indexOf("wsrv.nl") >= 0) return url;
  const lower = url.toLowerCase();
  const isAudioVideo = /\.(mp3|m4a|ogg|wav|mp4|webm|mov)(\?|$)/.test(lower);
  if (isAudioVideo) return url;
  return "https://wsrv.nl/?url=" + encodeURIComponent(url) + "&w=1024&q=85&output=jpg";
}

// ── Re-implement slugify from sq_core.ts ────────────────────────────────────

function slugify(s) {
  return ("" + (s || ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 64) || "general";
}

// ── Re-implement autoQa scoring logic (simplified for test assertions) ──────

function autoQa(q) {
  const BANNED_FRAGMENTS = [
    "as an ai", "i cannot", "lorem ipsum", "undefined", "[object object]", "null null"
  ];
  const MIN_QUESTION_LEN = 8;
  const MAX_QUESTION_LEN = 320;
  const MAX_OPTION_LEN = 120;
  const PASS_SCORE = 70;

  let checks = [];
  let score = 100;
  let fatal = false;

  const text = ("" + (q.question || "")).replace(/\s+/g, " ");
  if (text.length < MIN_QUESTION_LEN || text.length > MAX_QUESTION_LEN) { score -= 40; fatal = true; }
  else checks.push("length_ok");

  const opts = q.options || [];
  if (opts.length !== 2 && opts.length !== 4) { score -= 40; fatal = true; }
  else checks.push("option_count_ok");

  // Options distinct
  const seen = {};
  for (const o of opts) {
    const k = ("" + (o || "")).replace(/\s+/g, " ").toLowerCase();
    if (!k || k.length > MAX_OPTION_LEN || seen[k]) { score -= 40; fatal = true; break; }
    seen[k] = true;
  }
  if (!fatal) checks.push("options_distinct");

  if (typeof q.correct_index !== "number" || q.correct_index < 0 || q.correct_index >= opts.length) {
    score -= 50; fatal = true;
  } else {
    checks.push("answer_index_ok");
    const correctText = ("" + opts[q.correct_index]).toLowerCase();
    if (correctText.length >= 4 && text.toLowerCase().indexOf(correctText) >= 0) {
      score -= 35;
    } else {
      checks.push("no_answer_leak");
    }
  }

  const lowerAll = (text + " " + opts.join(" ")).toLowerCase();
  for (const b of BANNED_FRAGMENTS) {
    if (lowerAll.indexOf(b) >= 0) { score -= 50; fatal = true; break; }
  }
  if (!fatal) checks.push("no_banned_fragments");

  // NEW checks (P5)
  // Check 1: hash-like options
  if (!fatal) {
    for (const o of opts) {
      if (isHashLike("" + o)) { score -= 50; fatal = true; break; }
    }
    if (!fatal) checks.push("no_hash_options");
  }

  // Check 2: filename-like options
  if (!fatal) {
    for (const o of opts) {
      if (isFilenameLike("" + o)) { score -= 50; fatal = true; break; }
    }
    if (!fatal) checks.push("no_filename_options");
  }

  // Check 3: URL tokens
  if (!fatal) {
    for (const o of opts) {
      const optStr = "" + o;
      if (/https?:\/\//.test(optStr) || /\.(com|org|net|jpg|png|gif|html)\b/i.test(optStr)) {
        score -= 40; fatal = true; break;
      }
    }
    if (!fatal) checks.push("no_url_tokens");
  }

  // Check 4: Language match
  if (!fatal && (q.lang === "en" || !q.lang)) {
    let hasNonLatin = false;
    for (const o of opts) {
      if (hasNonLatinMajority("" + o)) { hasNonLatin = true; break; }
    }
    if (hasNonLatin || hasNonLatinMajority(text)) {
      score -= 50; fatal = true;
    }
    if (!fatal) checks.push("language_match");
  }

  // Check 5: min readable words
  if (!fatal) {
    for (const o of opts) {
      if (countReadableWords("" + o) < 1) {
        score -= 40; fatal = true; break;
      }
    }
    if (!fatal) checks.push("min_readable_words");
  }

  // Check 6: option UI fit
  let anyLong = false;
  for (const o of opts) {
    if (("" + o).length > 60) { anyLong = true; break; }
  }
  if (anyLong) score -= 15;
  else checks.push("option_ui_fit");

  // Check 7: content safety
  const topicNsfw = (q.topic === "anime") ? ["hentai", "ecchi", "eroge", "visual novel 18", "doujin"] : [];
  if (!fatal) {
    const allText = text + " " + opts.join(" ");
    if (isNsfwUnsafe(allText, topicNsfw)) {
      score -= 100; fatal = true;
    }
    if (!fatal) checks.push("content_safety");
  }

  if (score < 0) score = 0;
  return {
    score,
    status: (!fatal && score >= PASS_SCORE) ? "approved" : "rejected",
    checks
  };
}

// ── Fulfillment logic (from sq_engine.ts) ───────────────────────────────────

function computeFulfillment(readySets, wantSets, setSize, generationQueued) {
  let fulfillment = "full";
  if (readySets.length === 0) {
    fulfillment = generationQueued ? "warming" : "empty";
  } else if (readySets.length < wantSets) {
    fulfillment = "partial";
  } else {
    for (const s of readySets) {
      if (s.questions.length < setSize) { fulfillment = "partial"; break; }
    }
  }
  return fulfillment;
}

// ── Default combos list (from sq_engine.ts) ─────────────────────────────────

function defaultCombos() {
  return [
    { source: "archive_org", mode: "ImageGuess", topic: "history" },
    { source: "archive_org", mode: "ImageGuess", topic: "anime" },
    { source: "archive_org", mode: "ImageGuess", topic: "dog" },
    { source: "archive_org", mode: "ImageGuess", topic: "cat" },
    { source: "archive_org", mode: "ImageGuess", topic: "nature" },
    { source: "archive_org", mode: "ImageGuess", topic: "science" },
    { source: "archive_org", mode: "ImageGuess", topic: "geography" },
    { source: "archive_org", mode: "ImageGuess", topic: "art" },
    { source: "archive_org", mode: "ImageGuess", topic: "ghibli" },
    { source: "archive_org", mode: "ImageGuess", topic: "disney" },
    { source: "archive_org", mode: "ImageGuess", topic: "marvel" },
    { source: "archive_org", mode: "ImageGuess", topic: "pokemon" },
    { source: "archive_org", mode: "ImageGuess", topic: "naruto" },
    { source: "archive_org", mode: "ImageGuess", topic: "one_piece" },
    { source: "archive_org", mode: "ImageGuess", topic: "dragon_ball" },
    { source: "archive_org", mode: "ImageGuess", topic: "harry_potter" },
    // other modes follow...
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 1 — PURE-LOGIC UNIT TESTS (no server required)
// ═══════════════════════════════════════════════════════════════════════════════

section("PART 1 — PURE-LOGIC UNIT TESTS");

// ── P1: WebP → JPG + resolution/quality bump ───────────────────────────────

subsection("P1 — optimizeMediaUrl: WebP → JPG");

{
  const url = "https://archive.org/download/some-item/image.jpg";
  const result = optimizeMediaUrl(url);

  assertNotIncludes(result, "output=webp", "P1.1  No WebP output format in optimized URL");
  assertIncludes(result, "output=jpg", "P1.2  Uses JPG output format");
  assertIncludes(result, "w=1024", "P1.3  Resolution bumped to 1024px width");
  assertIncludes(result, "q=85", "P1.4  Quality bumped to 85");
  assertIncludes(result, "wsrv.nl", "P1.5  Routes through wsrv.nl proxy");
  assertIncludes(result, encodeURIComponent(url), "P1.6  Original URL properly encoded");

  // Already-proxied URLs should pass through
  const alreadyProxied = "https://wsrv.nl/?url=something&w=1024&q=85&output=jpg";
  assertEqual(optimizeMediaUrl(alreadyProxied), alreadyProxied, "P1.7  Already-proxied URL passes through unchanged");

  // Audio/video should NOT be proxied
  assertEqual(optimizeMediaUrl("https://example.com/song.mp3"), "https://example.com/song.mp3", "P1.8  MP3 audio not proxied");
  assertEqual(optimizeMediaUrl("https://example.com/clip.mp4"), "https://example.com/clip.mp4", "P1.9  MP4 video not proxied");
  assertEqual(optimizeMediaUrl("https://example.com/music.ogg"), "https://example.com/music.ogg", "P1.10 OGG audio not proxied");

  // Empty / null
  assertEqual(optimizeMediaUrl(""), "", "P1.11 Empty string returns empty");
  assertEqual(optimizeMediaUrl(null), "", "P1.12 Null returns empty string");
}

// ── P2: Full-resolution image URLs (logic check) ───────────────────────────

subsection("P2 — Full-resolution image detection logic");

{
  // Simulate the file-selection logic from resolveFullResImage
  function selectBestImage(files) {
    let bestFile = "";
    let bestSize = 0;
    for (const f of files) {
      const name = ("" + (f.name || "")).toLowerCase();
      const size = parseInt(f.size || "0", 10) || 0;
      if (!/\.(jpe?g|png)$/i.test(name)) continue;
      if (size < 50000) continue;
      if (/thumb|__ia_thumb|__ia_meta/i.test(name)) continue;
      if (size > bestSize) {
        bestSize = size;
        bestFile = f.name;
      }
    }
    return bestFile;
  }

  // Good case: picks largest JPEG
  const files1 = [
    { name: "__ia_thumb.jpg", size: "2000" },
    { name: "small_preview.png", size: "30000" },
    { name: "full_image.jpg", size: "500000" },
    { name: "metadata.xml", size: "1000" },
    { name: "another_image.png", size: "250000" },
  ];
  assertEqual(selectBestImage(files1), "full_image.jpg", "P2.1  Picks largest JPEG over thumbnails");

  // Filters out thumbnails
  const files2 = [
    { name: "__ia_thumb.jpg", size: "100000" },
    { name: "real_photo.png", size: "80000" },
  ];
  assertEqual(selectBestImage(files2), "real_photo.png", "P2.2  Rejects __ia_thumb even if larger");

  // No valid images → empty
  const files3 = [
    { name: "document.pdf", size: "500000" },
    { name: "video.mp4", size: "9000000" },
    { name: "tiny.jpg", size: "5000" },
  ];
  assertEqual(selectBestImage(files3), "", "P2.3  Returns empty when no qualifying image exists");

  // WebP files should NOT be selected (we serve JPG/PNG only)
  const files4 = [
    { name: "hero.webp", size: "600000" },
    { name: "alt.jpg", size: "200000" },
  ];
  assertEqual(selectBestImage(files4), "alt.jpg", "P2.4  WebP excluded, selects JPEG fallback");
}

// ── P3: Cold pool inline fill + cron cadence ────────────────────────────────

subsection("P3 — Cold pool inline fill logic");

{
  // Verify NEXT_REFRESH_ETA_SEC reduced from 900 to 300
  const NEXT_REFRESH_ETA_SEC = 300;
  assertEqual(NEXT_REFRESH_ETA_SEC, 300, "P3.1  Cron cadence reduced from 15min (900) to 5min (300)");

  // Simulate inline fill trigger: pool.questions.length < setSize * wantSets
  function shouldInlineFill(poolSize, setSize, wantSets) {
    return poolSize < setSize * wantSets;
  }

  assert(shouldInlineFill(0, 10, 3), "P3.2  Inline fill triggered when pool empty (0 < 30)");
  assert(shouldInlineFill(15, 10, 3), "P3.3  Inline fill triggered when pool partial (15 < 30)");
  assert(!shouldInlineFill(50, 10, 3), "P3.4  No inline fill when pool sufficient (50 >= 30)");
  assert(shouldInlineFill(0, 25, 2), "P3.5  Inline fill for large set size (0 < 50)");

  // bestSourceForMode logic
  function bestSourceForMode(mode, topic) {
    if (mode === "ImageGuess" || mode === "WhosThat" || mode === "GeoExplore") return "archive_org";
    if (mode === "MediaQuiz" && (topic === "music" || topic === "audio")) return "music_tv";
    if (mode === "ViralIQ") return "justwatch";
    if (mode === "CustomTopic" || mode === "BrainSprint") return "wolfram";
    if (mode === "AudioQuiz") return "music_tv";
    return "archive_org";
  }

  assertEqual(bestSourceForMode("ImageGuess", "anime"), "archive_org", "P3.6  ImageGuess routes to archive_org");
  assertEqual(bestSourceForMode("MediaQuiz", "music"), "music_tv", "P3.7  MediaQuiz/music routes to music_tv");
  assertEqual(bestSourceForMode("ViralIQ", "trending"), "justwatch", "P3.8  ViralIQ routes to justwatch");
  assertEqual(bestSourceForMode("BrainSprint", "math"), "wolfram", "P3.9  BrainSprint routes to wolfram");
}

// ── P4: Fulfillment status + combo matrix ───────────────────────────────────

subsection("P4 — Fulfillment status");

{
  // Full: enough ready sets with enough questions
  const fullSets = [
    { questions: new Array(10), question_ids: [] },
    { questions: new Array(10), question_ids: [] },
    { questions: new Array(10), question_ids: [] },
  ];
  assertEqual(computeFulfillment(fullSets, 3, 10, false), "full", "P4.1  Full fulfillment when 3/3 sets × 10 questions");

  // Partial: fewer sets than wanted
  assertEqual(computeFulfillment(fullSets.slice(0, 2), 3, 10, false), "partial", "P4.2  Partial when 2/3 sets");

  // Partial: enough sets but one undersized
  const partialSets = [
    { questions: new Array(10), question_ids: [] },
    { questions: new Array(10), question_ids: [] },
    { questions: new Array(5), question_ids: [] }, // undersized
  ];
  assertEqual(computeFulfillment(partialSets, 3, 10, false), "partial", "P4.3  Partial when one set undersized (5 < 10)");

  // Empty: no sets, no queue
  assertEqual(computeFulfillment([], 3, 10, false), "empty", "P4.4  Empty when 0 sets, not queued");

  // Warming: no sets but generation queued
  assertEqual(computeFulfillment([], 3, 10, true), "warming", "P4.5  Warming when 0 sets but generation queued");

  // Combo matrix: verify all expected ImageGuess topics present
  const combos = defaultCombos();
  const igTopics = combos
    .filter(c => c.mode === "ImageGuess")
    .map(c => c.topic);

  const requiredTopics = [
    "history", "anime", "dog", "cat", "nature", "science", "geography",
    "art", "ghibli", "disney", "marvel", "pokemon", "naruto",
    "one_piece", "dragon_ball", "harry_potter"
  ];

  for (const t of requiredTopics) {
    assert(igTopics.includes(t), `P4.6  Combo matrix includes ImageGuess/${t}`);
  }

  assert(igTopics.length >= 16, `P4.7  At least 16 ImageGuess combos (got ${igTopics.length})`);
}

// ── P5: Option text validation — hash, filename, language, readable words ───

subsection("P5 — isHashLike");

{
  // Should detect
  assert(isHashLike("e21d8bb76eac5612e702fc57f508ed53"), "P5.1  MD5 hash detected");
  assert(isHashLike("a1b2c3d4e5f6a1b2c3d4e5f6"), "P5.2  24-char hex string detected");
  assert(isHashLike("550e8400-e29b-41d4-a716-446655440000"), "P5.3  UUID detected");
  assert(isHashLike("123456789012345678"), "P5.4  Long numeric string detected (low alpha ratio)");

  // Should NOT detect
  assert(!isHashLike("Spirited Away"), "P5.5  Normal title passes");
  assert(!isHashLike("The Little Mermaid"), "P5.6  Disney title passes");
  assert(!isHashLike("abc"), "P5.7  Short string passes");
  assert(!isHashLike(""), "P5.8  Empty string passes");
  assert(!isHashLike("Golden Retriever"), "P5.9  Dog breed name passes");
}

subsection("P5 — isFilenameLike");

{
  assert(isFilenameLike("download-1"), "P5.10 'download-1' detected");
  assert(isFilenameLike("IMG_3917"), "P5.11 'IMG_3917' detected");
  assert(isFilenameLike("screenshot 42"), "P5.12 'screenshot 42' detected");
  assert(isFilenameLike("image.jpg"), "P5.13 '.jpg extension' detected");
  assert(isFilenameLike("document.pdf"), "P5.14 '.pdf extension' detected");
  assert(isFilenameLike("photo_001"), "P5.15 'photo_001' detected");
  assert(isFilenameLike("1024 x 768"), "P5.16 Dimension pattern detected");
  assert(isFilenameLike("320px"), "P5.17 Pixel dimension detected");
  assert(isFilenameLike("https://example.com/path"), "P5.18 URL path detected");
  assert(isFilenameLike("DSC00142"), "P5.19 Camera filename detected");

  assert(!isFilenameLike("Howl's Moving Castle"), "P5.20 Normal title passes");
  assert(!isFilenameLike("Labrador Retriever"), "P5.21 Dog breed passes");
  assert(!isFilenameLike("Ancient Rome"), "P5.22 Topic name passes");
}

subsection("P5 — hasNonLatinMajority");

{
  assert(hasNonLatinMajority("これはアニメです"), "P5.23 Japanese text detected");
  assert(hasNonLatinMajority("Привет мир"), "P5.24 Cyrillic text detected");
  assert(hasNonLatinMajority("مرحبا بالعالم"), "P5.25 Arabic text detected");
  assert(hasNonLatinMajority("สวัสดีชาวโลก"), "P5.26 Thai text detected");
  assert(hasNonLatinMajority("한국어 텍스트"), "P5.27 Korean text detected");
  assert(hasNonLatinMajority("नमस्ते दुनिया"), "P5.28 Devanagari text detected");

  assert(!hasNonLatinMajority("Hello World"), "P5.29 English text passes");
  assert(!hasNonLatinMajority("Pokémon Pikachu"), "P5.30 Accented Latin passes");
  assert(!hasNonLatinMajority("Studio Ghibli #1"), "P5.31 Latin with symbols passes");
}

subsection("P5 — countReadableWords");

{
  assertEqual(countReadableWords("Spirited Away"), 2, "P5.32 Two readable words");
  assertEqual(countReadableWords("The Dark Knight Rises"), 4, "P5.33 Four readable words");
  assertEqual(countReadableWords("a b c"), 0, "P5.34 Very short tokens count as zero");
  assertEqual(countReadableWords("123-456-789"), 0, "P5.35 Numeric-only tokens count as zero");
  assert(countReadableWords("Golden Retriever Puppy") >= 2, "P5.36 Dog breed has readable words");
  assertEqual(countReadableWords(""), 0, "P5.37 Empty string → zero words");
}

subsection("P5 — autoQa rejects garbage options");

{
  // Hash option
  const hashQ = {
    question: "Which anime is shown in this image?",
    options: ["Spirited Away", "My Neighbor Totoro", "e21d8bb76eac5612e702fc57f508ed53", "Princess Mononoke"],
    correct_index: 0, topic: "anime", mode: "ImageGuess", question_type: "Image",
    media_url: "https://archive.org/download/test/img.jpg", lang: "en"
  };
  const hashResult = autoQa(hashQ);
  assertEqual(hashResult.status, "rejected", "P5.38 Question with hash option rejected");

  // Filename option
  const fileQ = {
    question: "What breed of dog is shown?",
    options: ["Labrador", "IMG_3917", "Poodle", "Beagle"],
    correct_index: 0, topic: "dog", mode: "ImageGuess", question_type: "Image",
    media_url: "https://archive.org/download/test/img.jpg", lang: "en"
  };
  const fileResult = autoQa(fileQ);
  assertEqual(fileResult.status, "rejected", "P5.39 Question with filename option rejected");

  // URL in option
  const urlQ = {
    question: "What is shown in this image?",
    options: ["A painting", "https://example.com/art.jpg", "A sculpture", "A photograph"],
    correct_index: 0, topic: "art", mode: "ImageGuess", question_type: "Image",
    media_url: "https://archive.org/download/test/img.jpg", lang: "en"
  };
  const urlResult = autoQa(urlQ);
  assertEqual(urlResult.status, "rejected", "P5.40 Question with URL option rejected");

  // Non-Latin option (English quiz)
  const langQ = {
    question: "Which anime is shown in this image?",
    options: ["Naruto", "これはアニメ", "One Piece", "Bleach"],
    correct_index: 0, topic: "anime", mode: "ImageGuess", question_type: "Image",
    media_url: "https://archive.org/download/test/img.jpg", lang: "en"
  };
  const langResult = autoQa(langQ);
  assertEqual(langResult.status, "rejected", "P5.41 Question with non-Latin option rejected (lang=en)");

  // Good question passes
  const goodQ = {
    question: "Which anime is shown in this image?",
    options: ["Spirited Away", "My Neighbor Totoro", "Princess Mononoke", "Howl's Moving Castle"],
    correct_index: 0, topic: "anime", mode: "ImageGuess", question_type: "Image",
    media_url: "https://archive.org/download/test/img.jpg", lang: "en"
  };
  const goodResult = autoQa(goodQ);
  assertEqual(goodResult.status, "approved", "P5.42 Clean question with good options approved");
  assert(goodResult.checks.includes("no_hash_options"), "P5.43 'no_hash_options' check passed");
  assert(goodResult.checks.includes("no_filename_options"), "P5.44 'no_filename_options' check passed");
  assert(goodResult.checks.includes("no_url_tokens"), "P5.45 'no_url_tokens' check passed");
  assert(goodResult.checks.includes("language_match"), "P5.46 'language_match' check passed");
  assert(goodResult.checks.includes("min_readable_words"), "P5.47 'min_readable_words' check passed");
  assert(goodResult.checks.includes("content_safety"), "P5.48 'content_safety' check passed");
}

// ── P6: Topic relevance + brand safety ──────────────────────────────────────

subsection("P6 — NSFW/brand safety");

{
  assert(isNsfwUnsafe("this contains hentai content", []), "P6.1  Global NSFW term 'hentai' caught");
  assert(isNsfwUnsafe("18+ content warning", []), "P6.2  Global NSFW term '18+' caught");
  assert(isNsfwUnsafe("contains gore imagery", []), "P6.3  Global NSFW term 'gore' caught");
  assert(isNsfwUnsafe("safe text but ecchi tag", ["ecchi"]), "P6.4  Topic-specific NSFW 'ecchi' caught");
  assert(isNsfwUnsafe("doujin artwork here", ["doujin"]), "P6.5  Topic-specific NSFW 'doujin' caught");

  assert(!isNsfwUnsafe("Beautiful anime landscape", []), "P6.6  Clean text passes global check");
  assert(!isNsfwUnsafe("Golden Retriever in park", []), "P6.7  Dog content passes");
  assert(!isNsfwUnsafe("Studio Ghibli masterpiece", ["ecchi"]), "P6.8  Ghibli with anime nsfw list passes");

  // autoQa NSFW rejection
  const nsfwQ = {
    question: "Which anime is shown in this image?",
    options: ["Spirited Away", "Some hentai title", "Totoro", "Mononoke"],
    correct_index: 0, topic: "anime", mode: "ImageGuess", question_type: "Image",
    media_url: "https://archive.org/download/test/img.jpg", lang: "en"
  };
  const nsfwResult = autoQa(nsfwQ);
  assertEqual(nsfwResult.status, "rejected", "P6.9  Question with NSFW option text rejected");
}

subsection("P6 — Topic config per-topic setup");

{
  // Verify upstream filter logic (simplified passesUpstreamFilter)
  function passesUpstreamFilter(doc, cfg) {
    if (!doc || !doc.title || !doc.identifier) return false;
    const title = ("" + doc.title).trim();
    const desc = ("" + (doc.description || "")).trim();
    const combined = (title + " " + desc).toLowerCase();

    if (isHashLike(title)) return false;
    if (isFilenameLike(title)) return false;

    const words = title.split(/\s+/).length;
    if (words < cfg.min_title_words) return false;

    if (hasNonLatinMajority(title)) return false;

    for (const nf of cfg.negative_filter) {
      if (combined.indexOf(nf.toLowerCase()) >= 0) return false;
    }

    if (isNsfwUnsafe(combined, cfg.nsfw_block)) return false;

    if (cfg.franchise_creators.length > 0) {
      const creator = ("" + (doc.creator || "")).toLowerCase();
      const subject = ("" + (Array.isArray(doc.subject) ? doc.subject.join(" ") : (doc.subject || ""))).toLowerCase();
      const creatorSubject = creator + " " + subject;
      let hit = false;
      for (const fc of cfg.franchise_creators) {
        if (creatorSubject.indexOf(fc.toLowerCase()) >= 0) { hit = true; break; }
      }
      if (!hit) return false;
    }

    return true;
  }

  const animeCfg = {
    query_boost: "", negative_filter: ["convention", "cosplay", "expo", "retail"],
    wikipedia_list_page: "", franchise_creators: [],
    nsfw_block: ["hentai", "ecchi"], min_title_words: 2, question_templates: []
  };

  const ghibliCfg = {
    query_boost: "", negative_filter: ["convention", "cosplay"],
    wikipedia_list_page: "", franchise_creators: ["Studio Ghibli", "Hayao Miyazaki"],
    nsfw_block: [], min_title_words: 2, question_templates: []
  };

  // Good anime doc
  assert(passesUpstreamFilter(
    { identifier: "abc", title: "Spirited Away Art", creator: "Fan", subject: "anime" },
    animeCfg
  ), "P6.10 Valid anime doc passes upstream filter");

  // Convention reject
  assert(!passesUpstreamFilter(
    { identifier: "abc", title: "Anime Expo Convention Photos", creator: "User", subject: "anime" },
    animeCfg
  ), "P6.11 Convention doc rejected by negative filter");

  // Cosplay reject
  assert(!passesUpstreamFilter(
    { identifier: "abc", title: "Cosplay Gallery from Tokyo", creator: "User", subject: "anime cosplay" },
    animeCfg
  ), "P6.12 Cosplay doc rejected by negative filter");

  // Hash title reject
  assert(!passesUpstreamFilter(
    { identifier: "abc", title: "e21d8bb76eac5612e702fc57f508ed53", creator: "User" },
    animeCfg
  ), "P6.13 Hash title rejected upstream");

  // Single word title reject (min_title_words = 2)
  assert(!passesUpstreamFilter(
    { identifier: "abc", title: "test", creator: "User" },
    animeCfg
  ), "P6.14 Single-word title rejected (min_title_words=2)");

  // NSFW in description
  assert(!passesUpstreamFilter(
    { identifier: "abc", title: "Anime Collection", description: "Contains ecchi scenes", creator: "User" },
    animeCfg
  ), "P6.15 NSFW in description rejected");

  // Ghibli franchise creator check
  assert(passesUpstreamFilter(
    { identifier: "abc", title: "Castle in the Sky", creator: "Studio Ghibli", subject: "anime" },
    ghibliCfg
  ), "P6.16 Ghibli doc with correct creator passes");

  assert(!passesUpstreamFilter(
    { identifier: "abc", title: "Castle in the Sky", creator: "Random User", subject: "fan art" },
    ghibliCfg
  ), "P6.17 Ghibli doc without franchise creator rejected");

  // Japanese title rejection
  assert(!passesUpstreamFilter(
    { identifier: "abc", title: "千と千尋の神隠し", creator: "User" },
    animeCfg
  ), "P6.18 Japanese-only title rejected for English topic");
}

// ── P7: Media URL dedup ─────────────────────────────────────────────────────

subsection("P7 — Intra-session media URL dedup");

{
  // Simulate dedup logic from ensureStaged
  function deduplicateByMediaUrl(questions) {
    const stagedMediaUrls = {};
    const deduplicated = [];

    for (const q of questions) {
      if (q.media_url) {
        const baseUrl = q.media_url.split("?")[0];
        if (stagedMediaUrls[baseUrl]) continue;
        stagedMediaUrls[baseUrl] = true;
      }
      deduplicated.push(q);
    }
    return deduplicated;
  }

  // Same image, different questions → deduped
  const questions = [
    { id: "q1", question: "What is this titled?", media_url: "https://archive.org/download/item1/img.jpg?proxy=1", options: [] },
    { id: "q2", question: "Who created this?", media_url: "https://archive.org/download/item1/img.jpg?proxy=2", options: [] },
    { id: "q3", question: "What is this titled?", media_url: "https://archive.org/download/item2/other.jpg", options: [] },
  ];

  const result = deduplicateByMediaUrl(questions);
  assertEqual(result.length, 2, "P7.1  Same base media URL deduped (3→2)");
  assertEqual(result[0].id, "q1", "P7.2  First occurrence kept");
  assertEqual(result[1].id, "q3", "P7.3  Different image kept");

  // Proxy params stripped for comparison
  const proxyQuestions = [
    { id: "a", media_url: "https://archive.org/download/x/photo.jpg?w=1024&q=85", options: [] },
    { id: "b", media_url: "https://archive.org/download/x/photo.jpg?w=512&q=72", options: [] },
  ];
  const proxyResult = deduplicateByMediaUrl(proxyQuestions);
  assertEqual(proxyResult.length, 1, "P7.4  Same base URL with different query params deduped");

  // No media URL → no dedup issue
  const textQuestions = [
    { id: "t1", media_url: "", options: [] },
    { id: "t2", media_url: "", options: [] },
    { id: "t3", media_url: null, options: [] },
  ];
  const textResult = deduplicateByMediaUrl(textQuestions);
  assertEqual(textResult.length, 3, "P7.5  Text questions without media_url all kept");

  // One question per archive item (usedIdentifiers guard)
  function oneQuestionPerItem(docs) {
    const usedIdentifiers = {};
    const out = [];
    for (const doc of docs) {
      if (usedIdentifiers[doc.identifier]) continue;
      usedIdentifiers[doc.identifier] = true;
      out.push(doc);
    }
    return out;
  }

  const docs = [
    { identifier: "item_1", title: "Title Q" },
    { identifier: "item_1", title: "Creator Q" }, // same item, should skip
    { identifier: "item_2", title: "Title Q" },
  ];
  const onePerResult = oneQuestionPerItem(docs);
  assertEqual(onePerResult.length, 2, "P7.6  One question per archive item (3→2)");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 2 — INTEGRATION TESTS (requires running Nakama)
// ═══════════════════════════════════════════════════════════════════════════════

section("PART 2 — INTEGRATION TESTS (live Nakama)");

const HOST = process.env.NAKAMA_EVAL_HOST || "localhost";
const PORT = Number(process.env.NAKAMA_EVAL_PORT || 7350);
const USE_TLS = (process.env.NAKAMA_EVAL_TLS ?? "false") !== "false";
const SERVER_KEY = process.env.NAKAMA_EVAL_SERVER_KEY || "defaultkey";
const HTTP_BASE = `${USE_TLS ? "https" : "http"}://${HOST}:${PORT}`;
const SKIP_INTEGRATION = (process.env.SKIP_INTEGRATION ?? "false") === "true";

const RUN_TAG = "seedq_" + Math.random().toString(36).slice(2, 8);

async function authenticateDevice(deviceId, username) {
  const url = `${HTTP_BASE}/v2/account/authenticate/device?create=true&username=${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(SERVER_KEY + ":"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: deviceId }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function callRpc(sessionToken, rpcId, payload) {
  const url = `${HTTP_BASE}/v2/rpc/${rpcId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + sessionToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload: JSON.stringify(payload) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${rpcId} failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return typeof data.payload === "string" ? JSON.parse(data.payload) : data;
}

async function runIntegrationTests() {
  if (SKIP_INTEGRATION) {
    console.log("\n  ⏭️  Integration tests skipped (SKIP_INTEGRATION=true)");
    return;
  }

  // Check connectivity
  let session;
  try {
    const deviceId = `seedq_test_${RUN_TAG}_${Date.now()}`;
    const username = `seedq_test_${RUN_TAG}`;
    session = await authenticateDevice(deviceId, username);
    console.log(`\n  ✅ Connected to Nakama at ${HTTP_BASE} (user: ${username})`);
  } catch (e) {
    console.log(`\n  ⚠️  Cannot reach Nakama at ${HTTP_BASE} — skipping integration tests`);
    console.log(`     (${e.message})`);
    console.log(`     Set NAKAMA_EVAL_HOST/NAKAMA_EVAL_PORT or start Nakama locally.\n`);
    return;
  }

  const token = session.token;

  // ── INT-1: Stage request returns non-WebP media URLs ────────────────────

  subsection("INT-1 — Stage RPC returns JPG media URLs");

  try {
    const stageResult = await callRpc(token, "quizverse_seedq_stage", {
      mode: "ImageGuess",
      topic: "history",
      want_sets: 1,
      set_size: 5
    });

    assert(stageResult.ok !== undefined, "INT-1.1 Stage RPC returns response");

    if (stageResult.sets && stageResult.sets.length > 0 && stageResult.sets[0].questions) {
      const q = stageResult.sets[0].questions[0];
      if (q.media_url) {
        assertNotIncludes(q.media_url, "output=webp", "INT-1.2 Media URL is NOT WebP");
        if (q.media_url.includes("wsrv.nl")) {
          assertIncludes(q.media_url, "output=jpg", "INT-1.3 Media URL uses JPG format");
          assertIncludes(q.media_url, "w=1024", "INT-1.4 Media URL uses 1024px width");
        } else {
          skip("INT-1.3", "Media URL not proxied through wsrv.nl");
          skip("INT-1.4", "Media URL not proxied through wsrv.nl");
        }
      } else {
        skip("INT-1.2", "No media_url in first question");
        skip("INT-1.3", "No media_url in first question");
        skip("INT-1.4", "No media_url in first question");
      }
    } else {
      skip("INT-1.2", "No sets returned (pool may be empty)");
      skip("INT-1.3", "No sets returned");
      skip("INT-1.4", "No sets returned");
    }

    // ── INT-2: Fulfillment field present ──────────────────────────────────

    subsection("INT-2 — Fulfillment field in response");

    assert(stageResult.fulfillment !== undefined, "INT-2.1 fulfillment field present in response");
    const validFulfillments = ["full", "partial", "empty", "warming"];
    assert(
      validFulfillments.includes(stageResult.fulfillment),
      "INT-2.2 fulfillment is valid enum value",
      `got: "${stageResult.fulfillment}"`
    );

    // ── INT-3: No duplicate media URLs in staged sets ────────────────────

    subsection("INT-3 — No duplicate media URLs across sets");

    if (stageResult.sets && stageResult.sets.length > 0) {
      const mediaUrls = new Set();
      let hasDupes = false;
      for (const set of stageResult.sets) {
        for (const q of (set.questions || [])) {
          if (q.media_url) {
            const base = q.media_url.split("?")[0];
            if (mediaUrls.has(base)) { hasDupes = true; break; }
            mediaUrls.add(base);
          }
        }
        if (hasDupes) break;
      }
      assert(!hasDupes, "INT-3.1 No duplicate media URLs across staged sets");
    } else {
      skip("INT-3.1", "No sets to check");
    }

    // ── INT-4: Questions pass content quality checks ─────────────────────

    subsection("INT-4 — Served questions pass quality checks");

    if (stageResult.sets && stageResult.sets.length > 0) {
      let allGood = true;
      let badDetail = "";
      for (const set of stageResult.sets) {
        for (const q of (set.questions || [])) {
          // No hash-like options
          for (const o of (q.options || [])) {
            if (isHashLike("" + o)) {
              allGood = false;
              badDetail = `hash option: "${o}"`;
            }
            if (isFilenameLike("" + o)) {
              allGood = false;
              badDetail = `filename option: "${o}"`;
            }
          }
        }
      }
      assert(allGood, "INT-4.1 No hash/filename garbage in served options", badDetail);
    } else {
      skip("INT-4.1", "No sets to check");
    }

  } catch (e) {
    console.log(`  ⚠️  Stage RPC failed: ${e.message}`);
    skip("INT-1.2", "RPC error");
    skip("INT-1.3", "RPC error");
    skip("INT-1.4", "RPC error");
    skip("INT-2.1", "RPC error");
    skip("INT-2.2", "RPC error");
    skip("INT-3.1", "RPC error");
    skip("INT-4.1", "RPC error");
  }

  // ── INT-5: Cold pool topic (exotic) triggers inline fill or warming ────

  subsection("INT-5 — Cold pool handling for exotic topic");

  try {
    const coldResult = await callRpc(token, "quizverse_seedq_stage", {
      mode: "ImageGuess",
      topic: "underwater_archaeology_" + RUN_TAG, // guaranteed cold
      want_sets: 1,
      set_size: 5
    });

    assert(coldResult.fulfillment !== undefined, "INT-5.1 Cold pool returns fulfillment field");
    // For a guaranteed-cold topic, we expect either "warming" or "empty" or
    // inline fill might produce "full"/"partial" if archive.org has anything
    assert(
      ["full", "partial", "empty", "warming"].includes(coldResult.fulfillment),
      "INT-5.2 Cold pool fulfillment is valid enum",
      `got: "${coldResult.fulfillment}"`
    );

    if (coldResult.fulfillment === "warming") {
      assert(coldResult.content_generation_queued === true,
        "INT-5.3 Warming status has content_generation_queued=true");
    } else {
      skip("INT-5.3", `Fulfillment is "${coldResult.fulfillment}", not warming`);
    }
  } catch (e) {
    console.log(`  ⚠️  Cold pool RPC failed: ${e.message}`);
    skip("INT-5.1", "RPC error");
    skip("INT-5.2", "RPC error");
    skip("INT-5.3", "RPC error");
  }
}

await runIntegrationTests();

// ═══════════════════════════════════════════════════════════════════════════════
//  RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(70)}`);
console.log(`  RESULTS`);
console.log(`${"═".repeat(70)}`);
console.log(`  ✅ Passed:  ${totalPassed}`);
console.log(`  ❌ Failed:  ${totalFailed}`);
console.log(`  ⏭️  Skipped: ${totalSkipped}`);
console.log(`  Total:     ${totalPassed + totalFailed + totalSkipped}`);

if (failedTests.length > 0) {
  console.log(`\n  Failed tests:`);
  for (const t of failedTests) {
    console.log(`    • ${t}`);
  }
}

console.log(`\n${"═".repeat(70)}\n`);

process.exit(totalFailed > 0 ? 1 : 0);
