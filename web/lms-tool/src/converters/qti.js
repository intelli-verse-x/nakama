'use strict';

const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const { stripHtml, escapeXml, createFidelityReport, asArray } = require('./canonical');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true, // imsmanifest often carries namespaces
});

function nodeText(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node['#text'] !== undefined) return String(node['#text']);
  return '';
}

function metadataField(item, label) {
  const md = item.itemmetadata && item.itemmetadata.qtimetadata;
  if (!md) return undefined;
  for (const f of asArray(md.qtimetadatafield)) {
    if (nodeText(f.fieldlabel) === label) return nodeText(f.fieldentry);
  }
  return undefined;
}

/** Collect <item> elements from an assessment, recursing through nested <section>s. */
function collectItems(sectionLike, out) {
  for (const section of asArray(sectionLike.section)) collectItems(section, out);
  for (const item of asArray(sectionLike.item)) out.push(item);
  return out;
}

function parseAssessmentXml(xmlString, fid, questions, startIndex) {
  const doc = parser.parse(xmlString);
  const root = doc.questestinterop;
  if (!root) return { title: '', nextIndex: startIndex };

  let title = '';
  let idx = startIndex;

  for (const assessment of asArray(root.assessment)) {
    if (!title) title = assessment['@_title'] || '';
    const items = collectItems(assessment, []);
    for (const item of items) {
      idx += 1;
      parseItem(item, fid, questions, idx);
    }
  }
  // Standalone objectbank / top-level items (some producers skip <assessment>)
  for (const item of asArray(root.item)) {
    idx += 1;
    parseItem(item, fid, questions, idx);
  }
  return { title, nextIndex: idx };
}

function parseItem(item, fid, questions, idx) {
  const name = item['@_title'] || item['@_ident'] || `item_${idx}`;
  const qtype = metadataField(item, 'question_type');
  if (qtype && !/^(multiple_choice_question|true_false_question)$/.test(qtype)) {
    fid.record(name, 'skipped', [`unsupported question_type "${qtype}" (v1 supports single-answer multiple choice only)`]);
    return;
  }

  const notes = [];
  const presentation = item.presentation;
  if (!presentation) {
    fid.record(name, 'skipped', ['no <presentation> element']);
    return;
  }

  // Stem: presentation/material/mattext
  const stemRaw = nodeText(asArray(asArray(presentation.material)[0] && asArray(presentation.material)[0].mattext)[0]);
  const stem = stripHtml(stemRaw);
  if (stem.hadImages) notes.push('embedded image in question text was stripped');
  if (stem.hadMarkup) notes.push('HTML formatting stripped from question text');

  // Choices: response_lid/render_choice/response_label
  const responseLid = asArray(presentation.response_lid)[0];
  if (!responseLid) {
    fid.record(name, 'skipped', ['no <response_lid> (not a choice interaction)']);
    return;
  }
  const cardinality = (responseLid['@_rcardinality'] || 'Single').toLowerCase();
  if (cardinality !== 'single') {
    fid.record(name, 'skipped', [`rcardinality="${responseLid['@_rcardinality']}" not supported in v1`]);
    return;
  }
  const respIdent = responseLid['@_ident'];

  const options = [];
  const identToIndex = {};
  const renderChoice = asArray(responseLid.render_choice)[0] || {};
  for (const label of asArray(renderChoice.response_label)) {
    const raw = nodeText(asArray(asArray(label.material)[0] && asArray(label.material)[0].mattext)[0]);
    const opt = stripHtml(raw);
    if (opt.hadImages) notes.push(`option ${options.length + 1}: embedded image stripped`);
    identToIndex[String(label['@_ident'])] = options.length;
    options.push(opt.text);
  }
  if (options.length < 2) {
    fid.record(name, 'skipped', ['fewer than 2 answer options']);
    return;
  }

  // Correct answer: respcondition whose setvar (SCORE) == 100 → varequal ident
  let correctIndex = -1;
  let explanation;
  const resprocessing = asArray(item.resprocessing)[0];
  for (const cond of asArray(resprocessing && resprocessing.respcondition)) {
    const setvars = asArray(cond.setvar);
    const isFullCredit = setvars.some((sv) => parseFloat(nodeText(sv)) === 100);
    if (!isFullCredit) continue;
    const conditionvar = asArray(cond.conditionvar)[0] || {};
    for (const ve of asArray(conditionvar.varequal)) {
      if (respIdent && ve['@_respident'] && ve['@_respident'] !== respIdent) continue;
      const ident = String(nodeText(ve));
      if (ident in identToIndex) {
        correctIndex = identToIndex[ident];
        break;
      }
    }
    if (correctIndex >= 0) break;
  }
  if (correctIndex < 0) {
    fid.record(name, 'skipped', ['could not resolve a single correct answer (no respcondition with answer weight 100)']);
    return;
  }

  // General feedback → explanation
  for (const fb of asArray(item.itemfeedback)) {
    const ident = String(fb['@_ident'] || '').toLowerCase();
    if (ident === 'general_fb' || ident === 'general' || ident === 'correct_fb') {
      const flow = asArray(fb.flow_mat)[0] || fb;
      const raw = nodeText(asArray(asArray(flow.material)[0] && asArray(flow.material)[0].mattext)[0]);
      const fbText = stripHtml(raw).text;
      if (fbText) { explanation = fbText; break; }
    }
  }

  const question = {
    question_id: `qti_${String(idx).padStart(3, '0')}`,
    text: stem.text,
    options,
    correct_index: correctIndex,
  };
  if (explanation) question.explanation = explanation;
  questions.push(question);
  fid.record(name, notes.length > 0 ? 'imported_with_loss' : 'imported', notes);
}

/**
 * Canvas QTI 1.2 zip → canonical questions.
 * Resolves assessment files via imsmanifest.xml (manifest-first per plan §13.2);
 * falls back to scanning *.xml files containing <questestinterop> when no manifest exists.
 *
 * @param {Buffer} zipBuffer
 * @returns {{ title: string, questions: object[], fidelity: object }}
 */
function parseQtiZip(zipBuffer) {
  const fid = createFidelityReport('qti_1.2');
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const byName = new Map(entries.map((e) => [e.entryName.replace(/\\/g, '/'), e]));

  const assessmentFiles = [];
  const manifestEntry = entries.find((e) => /(^|\/)imsmanifest\.xml$/i.test(e.entryName));
  if (manifestEntry) {
    const manifest = parser.parse(manifestEntry.getData().toString('utf8'));
    const resources = manifest.manifest && manifest.manifest.resources;
    for (const res of asArray(resources && resources.resource)) {
      const type = String(res['@_type'] || '');
      if (!/imsqti/i.test(type)) continue;
      const hrefs = [];
      if (res['@_href']) hrefs.push(res['@_href']);
      for (const f of asArray(res.file)) if (f['@_href']) hrefs.push(f['@_href']);
      for (const href of hrefs) {
        const norm = href.replace(/\\/g, '/');
        if (byName.has(norm) && /\.xml$/i.test(norm) && !assessmentFiles.includes(norm)) {
          assessmentFiles.push(norm);
        }
      }
    }
    if (assessmentFiles.length === 0) {
      fid.addGlobalNote('imsmanifest.xml present but no imsqti resources resolved; falling back to XML scan');
    }
  } else {
    fid.addGlobalNote('no imsmanifest.xml in package; falling back to XML scan');
  }

  if (assessmentFiles.length === 0) {
    for (const e of entries) {
      if (!/\.xml$/i.test(e.entryName)) continue;
      if (/(^|\/)imsmanifest\.xml$/i.test(e.entryName)) continue;
      const head = e.getData().toString('utf8', 0, 2000);
      if (head.includes('<questestinterop')) assessmentFiles.push(e.entryName.replace(/\\/g, '/'));
    }
  }
  if (assessmentFiles.length === 0) throw new Error('No QTI assessment XML found in package');

  const mediaFiles = entries.filter((e) => /\.(png|jpe?g|gif|svg|webp)$/i.test(e.entryName));
  if (mediaFiles.length > 0) {
    fid.addGlobalNote(`${mediaFiles.length} media file(s) in package were not imported (images unsupported in v1)`);
  }

  const questions = [];
  let title = '';
  let idx = 0;
  for (const file of assessmentFiles) {
    const xml = byName.get(file).getData().toString('utf8');
    const result = parseAssessmentXml(xml, fid, questions, idx);
    idx = result.nextIndex;
    if (!title && result.title) title = result.title;
  }

  return { title: title || 'Imported QTI quiz', questions, fidelity: fid.report };
}

/**
 * Canonical pack → Canvas-flavored QTI 1.2 zip (imsmanifest.xml + assessment XML).
 * @param {{ pack_id?: string, title?: string, questions: object[] }} pack
 * @returns {Buffer} zip buffer
 */
function generateQtiZip(pack) {
  const assessmentIdent = (pack.pack_id || 'quizverse_pack').replace(/[^a-zA-Z0-9_-]/g, '_');
  const title = pack.title || 'QuizVerse export';
  const items = [];

  (pack.questions || []).forEach((q, i) => {
    const itemIdent = `${assessmentIdent}_item_${i + 1}`;
    const respIdent = 'response1';
    const labels = (q.options || [])
      .map((opt, oi) => [
        `            <response_label ident="${itemIdent}_a${oi}">`,
        '              <material>',
        `                <mattext texttype="text/plain">${escapeXml(opt)}</mattext>`,
        '              </material>',
        '            </response_label>',
      ].join('\n'))
      .join('\n');

    const feedback = q.explanation
      ? [
        '      <itemfeedback ident="general_fb">',
        '        <flow_mat>',
        '          <material>',
        `            <mattext texttype="text/plain">${escapeXml(q.explanation)}</mattext>`,
        '          </material>',
        '        </flow_mat>',
        '      </itemfeedback>',
      ].join('\n')
      : '';

    items.push([
      `    <item ident="${itemIdent}" title="${escapeXml(q.question_id || `Question ${i + 1}`)}">`,
      '      <itemmetadata>',
      '        <qtimetadata>',
      '          <qtimetadatafield>',
      '            <fieldlabel>question_type</fieldlabel>',
      '            <fieldentry>multiple_choice_question</fieldentry>',
      '          </qtimetadatafield>',
      '          <qtimetadatafield>',
      '            <fieldlabel>points_possible</fieldlabel>',
      '            <fieldentry>1.0</fieldentry>',
      '          </qtimetadatafield>',
      '        </qtimetadata>',
      '      </itemmetadata>',
      '      <presentation>',
      '        <material>',
      `          <mattext texttype="text/html">&lt;p&gt;${escapeXml(escapeXml(q.text))}&lt;/p&gt;</mattext>`,
      '        </material>',
      `        <response_lid ident="${respIdent}" rcardinality="Single">`,
      '          <render_choice>',
      labels,
      '          </render_choice>',
      '        </response_lid>',
      '      </presentation>',
      '      <resprocessing>',
      '        <outcomes>',
      '          <decvar maxvalue="100" minvalue="0" varname="SCORE" vartype="Decimal"/>',
      '        </outcomes>',
      '        <respcondition continue="No">',
      '          <conditionvar>',
      `            <varequal respident="${respIdent}">${itemIdent}_a${q.correct_index}</varequal>`,
      '          </conditionvar>',
      '          <setvar action="Set" varname="SCORE">100</setvar>',
      '        </respcondition>',
      '      </resprocessing>',
      feedback,
      '    </item>',
    ].filter(Boolean).join('\n'));
  });

  const assessmentXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2">',
    `  <assessment ident="${assessmentIdent}" title="${escapeXml(title)}">`,
    '    <section ident="root_section">',
    items.join('\n'),
    '    </section>',
    '  </assessment>',
    '</questestinterop>',
  ].join('\n');

  const assessmentPath = `${assessmentIdent}/${assessmentIdent}.xml`;
  const manifestXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<manifest identifier="${assessmentIdent}_manifest" xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1">`,
    '  <metadata>',
    '    <schema>IMS Content</schema>',
    '    <schemaversion>1.1.3</schemaversion>',
    '  </metadata>',
    '  <organizations/>',
    '  <resources>',
    `    <resource identifier="${assessmentIdent}" type="imsqti_xmlv1p2" href="${assessmentPath}">`,
    `      <file href="${assessmentPath}"/>`,
    '    </resource>',
    '  </resources>',
    '</manifest>',
  ].join('\n');

  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(manifestXml, 'utf8'));
  zip.addFile(assessmentPath, Buffer.from(assessmentXml, 'utf8'));
  return zip.toBuffer();
}

module.exports = { parseQtiZip, generateQtiZip, parseAssessmentXml };
