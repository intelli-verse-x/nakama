'use strict';

const { page, escapeHtml, inlineJson } = require('./layout');

const PICKER_CSS = `
  .pack {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    border: 2px solid var(--border); border-radius: 10px; padding: 14px 16px; margin: 10px 0; cursor: pointer;
  }
  .pack:hover { border-color: #c7d2fe; }
  .pack.selected { border-color: var(--accent); background: #eef2ff; }
  .points-row { display: flex; align-items: center; gap: 10px; margin: 18px 0; }
  .points-row input { width: 110px; }
  .drop {
    border: 2px dashed var(--border); border-radius: 10px; padding: 18px; text-align: center;
    color: var(--muted); margin: 14px 0; font-size: .9rem;
  }
  .fid { background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin: 12px 0; font-size: .85rem; }
  .fid ul { margin: 6px 0 0; padding-left: 18px; }
  .fid .loss { color: var(--warn); }
  .fid .skip { color: var(--err); }
`;

const PICKER_JS = `
(function () {
  'use strict';
  var cfg = window.__QV_CONFIG__;
  var selected = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function renderPacks() {
    var list = $('pack-list');
    list.innerHTML = '';
    cfg.packs.forEach(function (p) {
      var div = document.createElement('div');
      div.className = 'pack' + (selected === p.pack_id ? ' selected' : '');
      div.innerHTML = '<div><strong>' + esc(p.title) + '</strong><br><span class="muted" style="font-size:.85rem">' +
        p.question_count + ' questions \\u00b7 ' + esc((p.source && p.source.kind) || 'quizverse') + '</span></div>' +
        (selected === p.pack_id ? '<span class="chip pending">Selected</span>' : '');
      div.onclick = function () { selected = p.pack_id; renderPacks(); $('btn-link').disabled = false; };
      list.appendChild(div);
    });
  }

  function renderFidelity(fid) {
    var box = $('fidelity');
    var html = '<strong>Import fidelity report</strong> (' + esc(fid.source_format) + '): ' +
      fid.imported + ' imported, ' + fid.imported_with_loss + ' with loss, ' + fid.skipped + ' skipped.';
    var notes = [];
    (fid.global_notes || []).forEach(function (n) { notes.push('<li class="loss">' + esc(n) + '</li>'); });
    (fid.items || []).forEach(function (it) {
      if (it.status === 'imported' && it.notes.length === 0) return;
      var cls = it.status === 'skipped' ? 'skip' : 'loss';
      notes.push('<li class="' + cls + '"><strong>' + esc(it.name) + '</strong> \\u2014 ' + esc(it.status) +
        (it.notes.length ? ': ' + esc(it.notes.join('; ')) : '') + '</li>');
    });
    if (notes.length) html += '<ul>' + notes.join('') + '</ul>';
    box.innerHTML = html;
    box.style.display = 'block';
  }

  $('file-input').onchange = function () {
    var f = this.files[0];
    if (!f) return;
    $('upload-status').textContent = 'Converting ' + f.name + '\\u2026';
    var fd = new FormData();
    fd.append('file', f);
    fetch('/api/import?ltik=' + encodeURIComponent(cfg.ltik), { method: 'POST', body: fd })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('upload-status').textContent = 'Import failed: ' + (res.body.message || res.body.error);
          if (res.body.fidelity) renderFidelity(res.body.fidelity);
          return;
        }
        $('upload-status').textContent = 'Imported "' + res.body.title + '" (' + res.body.question_count + ' questions)';
        renderFidelity(res.body.fidelity);
        cfg.packs.unshift({ pack_id: res.body.pack_id, title: res.body.title, question_count: res.body.question_count, source: { kind: res.body.fidelity.source_format } });
        selected = res.body.pack_id;
        renderPacks();
        $('btn-link').disabled = false;
      })
      .catch(function (err) { $('upload-status').textContent = 'Import failed: ' + err.message; });
  };

  $('btn-link').onclick = function () {
    if (!selected) return;
    $('pack-id-field').value = selected;
    $('deeplink-form').submit();
  };

  renderPacks();
})();
`;

/**
 * @param {object} p { ltik, packs[], nakamaStatus }
 */
function renderPicker(p) {
  const cfg = { ltik: p.ltik, packs: p.packs };
  const anyMocked = Object.values(p.nakamaStatus.rpcs).includes('mocked');

  const body = `
<div class="card">
  <h1>Choose a QuizVerse quiz</h1>
  <p class="muted">Pick a quiz pack to add as a graded activity, or import one from Moodle XML / Canvas QTI first.</p>

  <div class="drop">
    Import from your LMS: upload a <strong>Moodle XML</strong> export (.xml) or a <strong>Canvas QTI 1.2</strong> package (.zip)
    <p style="margin:10px 0 0"><input type="file" id="file-input" accept=".xml,.zip"></p>
    <p id="upload-status" style="margin:8px 0 0"></p>
  </div>
  <div class="fid" id="fidelity" style="display:none"></div>

  <div id="pack-list"></div>

  <form id="deeplink-form" method="POST" action="/api/deeplink/respond">
    <input type="hidden" name="ltik" value="${escapeHtml(p.ltik)}">
    <input type="hidden" name="pack_id" id="pack-id-field" value="">
    <div class="points-row">
      <label style="margin:0" for="score-max">Max points</label>
      <input type="number" name="score_maximum" id="score-max" value="10" min="1" step="1">
      <button type="button" class="primary" id="btn-link" disabled>Add to course</button>
    </div>
  </form>
  ${anyMocked ? '<p class="muted" style="font-size:.8rem">Note: Nakama lms-bridge RPCs are mocked locally (integration pending) — the selection still produces a valid deep-linking response.</p>' : ''}
</div>`;

  const script = `window.__QV_CONFIG__ = ${inlineJson(cfg)};\n${PICKER_JS}`;
  return page('Choose a quiz — QuizVerse', body, PICKER_CSS, script);
}

module.exports = { renderPicker };
