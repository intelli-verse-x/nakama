'use strict';

const { XMLParser } = require('fast-xml-parser');
const { stripHtml, escapeXml, createFidelityReport, asArray } = require('./canonical');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // keep values as strings; "true"/numbers must not be coerced ("100" fractions kept comparable)
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** Moodle wraps most values in <text>; nodes may be plain strings or objects. */
function nodeText(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node['#text'] !== undefined) return String(node['#text']);
  if (node.text !== undefined) return nodeText(node.text);
  return '';
}

/**
 * Moodle XML → canonical questions.
 * Scope (per plan): <question type="multichoice"> with a single answer at fraction=100.
 * Everything else is recorded as skipped in the fidelity report.
 *
 * @param {string} xmlString
 * @param {object} [opts] { title }
 * @returns {{ title: string, questions: object[], fidelity: object }}
 */
function parseMoodleXml(xmlString, opts = {}) {
  const fid = createFidelityReport('moodle_xml');
  let doc;
  try {
    doc = parser.parse(xmlString);
  } catch (err) {
    throw new Error('Moodle XML parse error: ' + err.message);
  }
  if (!doc || !doc.quiz) throw new Error('Not a Moodle XML quiz export: missing <quiz> root');

  const questions = [];
  let title = opts.title || '';
  let idx = 0;

  for (const q of asArray(doc.quiz.question)) {
    const type = q['@_type'] || 'unknown';
    const name = nodeText(q.name) || `question_${idx + 1}`;

    if (type === 'category') {
      // Category path often doubles as the quiz title context
      const cat = nodeText(q.category);
      if (cat && !title) title = cat.split('/').pop().trim();
      continue;
    }

    idx += 1;

    if (type !== 'multichoice') {
      fid.record(name, 'skipped', [`unsupported question type "${type}" (v1 supports multichoice single-answer only)`]);
      continue;
    }

    const notes = [];
    const single = nodeText(q.single).toLowerCase();
    if (single === 'false' || single === '0') {
      fid.record(name, 'skipped', ['multi-answer multichoice (single=false) not supported in v1']);
      continue;
    }

    const qtext = stripHtml(nodeText(q.questiontext));
    if (qtext.hadImages) notes.push('embedded image in question text was stripped (base64 images not imported)');
    if (qtext.hadMarkup) notes.push('HTML formatting stripped from question text');

    if (asArray(q.file).length > 0 || asArray((q.questiontext || {}).file).length > 0) {
      notes.push('base64 file attachment(s) skipped');
    }

    const options = [];
    let correctIndex = -1;
    let correctCount = 0;
    for (const a of asArray(q.answer)) {
      const optResult = stripHtml(nodeText(a));
      if (optResult.hadImages) notes.push(`option ${options.length + 1}: embedded image stripped`);
      const fraction = parseFloat(a['@_fraction'] !== undefined ? a['@_fraction'] : '0');
      if (fraction === 100) {
        correctIndex = options.length;
        correctCount += 1;
      } else if (fraction > 0) {
        notes.push(`option "${optResult.text.slice(0, 40)}" had partial credit (${fraction}%) — treated as incorrect`);
      }
      if (asArray(a.feedback).length > 0 && nodeText(a.feedback)) {
        notes.push(`per-answer feedback on option ${options.length + 1} dropped`);
      }
      options.push(optResult.text);
    }

    if (options.length < 2) {
      fid.record(name, 'skipped', ['fewer than 2 answer options']);
      continue;
    }
    if (correctCount !== 1) {
      fid.record(name, 'skipped', [`expected exactly one answer with fraction=100, found ${correctCount}`]);
      continue;
    }

    const question = {
      question_id: `mxml_${String(idx).padStart(3, '0')}`,
      text: qtext.text,
      options,
      correct_index: correctIndex,
    };
    const explanation = stripHtml(nodeText(q.generalfeedback)).text;
    if (explanation) question.explanation = explanation;

    questions.push(question);
    fid.record(name, notes.length > 0 ? 'imported_with_loss' : 'imported', notes);
  }

  return { title: title || 'Imported Moodle quiz', questions, fidelity: fid.report };
}

/**
 * Canonical pack → Moodle XML (multichoice, single answer).
 * @param {{ title?: string, questions: object[] }} pack
 * @returns {string} XML document
 */
function generateMoodleXml(pack) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<quiz>');
  lines.push('  <question type="category">');
  lines.push('    <category>');
  lines.push(`      <text>$course$/top/${escapeXml(pack.title || 'QuizVerse export')}</text>`);
  lines.push('    </category>');
  lines.push('  </question>');

  (pack.questions || []).forEach((q, i) => {
    lines.push('  <question type="multichoice">');
    lines.push(`    <name><text>${escapeXml(q.question_id || `Q${i + 1}`)}</text></name>`);
    lines.push('    <questiontext format="html">');
    lines.push(`      <text><![CDATA[<p>${escapeXml(q.text)}</p>]]></text>`);
    lines.push('    </questiontext>');
    if (q.explanation) {
      lines.push('    <generalfeedback format="html">');
      lines.push(`      <text><![CDATA[<p>${escapeXml(q.explanation)}</p>]]></text>`);
      lines.push('    </generalfeedback>');
    }
    lines.push('    <defaultgrade>1</defaultgrade>');
    lines.push('    <penalty>0</penalty>');
    lines.push('    <hidden>0</hidden>');
    lines.push('    <single>true</single>');
    lines.push('    <shuffleanswers>true</shuffleanswers>');
    lines.push('    <answernumbering>abc</answernumbering>');
    (q.options || []).forEach((opt, oi) => {
      const fraction = oi === q.correct_index ? '100' : '0';
      lines.push(`    <answer fraction="${fraction}" format="html">`);
      lines.push(`      <text><![CDATA[<p>${escapeXml(opt)}</p>]]></text>`);
      lines.push('    </answer>');
    });
    lines.push('  </question>');
  });

  lines.push('</quiz>');
  return lines.join('\n');
}

module.exports = { parseMoodleXml, generateMoodleXml };
