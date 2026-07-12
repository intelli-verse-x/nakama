'use strict';

/**
 * Canonical question shape shared by all converters:
 *   { question_id, text, options[], correct_index, explanation? }
 * A "pack" is { pack_id?, title, questions[] }.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  times: '\u00D7', divide: '\u00F7', deg: '\u00B0', plusmn: '\u00B1',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

/**
 * Strip HTML to plain text safely (no eval of markup, entities decoded,
 * block elements become line breaks, whitespace collapsed).
 * Returns { text, hadMarkup, hadImages } so callers can build fidelity notes.
 */
function stripHtml(html) {
  const src = String(html == null ? '' : html);
  const hadImages = /<img\b/i.test(src);
  const hadMarkup = /<[a-zA-Z/!][^>]*>/.test(src);
  let out = src
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  out = decodeEntities(out)
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { text: out, hadMarkup, hadImages };
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Fidelity report per plan §13.2: no silent lossy imports.
 * status: imported | imported_with_loss | skipped
 */
function createFidelityReport(sourceFormat) {
  const report = {
    source_format: sourceFormat,
    total: 0,
    imported: 0,
    imported_with_loss: 0,
    skipped: 0,
    items: [],
    global_notes: [],
  };
  return {
    report,
    addGlobalNote(note) { report.global_notes.push(note); },
    record(name, status, notes) {
      report.total += 1;
      report[status] += 1;
      report.items.push({ name: name || '(unnamed question)', status, notes: notes || [] });
    },
  };
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

module.exports = { stripHtml, decodeEntities, escapeXml, createFidelityReport, asArray };
