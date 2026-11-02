import { analyze, FIELDS, FIELD_LABELS, TYPE_LABELS, isoToRu } from '/src/engine.js';
import { answerQuestion, EXAMPLE_QUESTIONS } from '/src/questions.js';

const state = { files: [], analysis: null, openRows: new Set(), lastQuestion: null };
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- загрузка ----------

async function readFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

function addFiles(list) {
  for (const f of list) {
    const i = state.files.findIndex((x) => x.name === f.name);
    if (i >= 0) state.files[i] = f; else state.files.push(f);
  }
  refresh();
}

$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files].filter((f) => /\.txt$/i.test(f.name) || f.type === 'text/plain');
  addFiles(await Promise.all(files.map(async (f) => ({ name: f.name, text: await readFile(f) }))));
  e.target.value = '';
});

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const files = [...e.dataTransfer.files].filter((f) => /\.txt$/i.test(f.name));
  addFiles(await Promise.all(files.map(async (f) => ({ name: f.name, text: await readFile(f) }))));
});

$('loadSamples').addEventListener('click', async () => {
  const r = await fetch('/api/samples');
  const data = await r.json();
  if (!r.ok) { alert(data.error); return; }
  addFiles(data);
});

$('clearAll').addEventListener('click', () => {
  state.files = [];
  state.openRows.clear();
  state.lastQuestion = null;
  $('qaAnswer').innerHTML = '';
  closeViewer();
  refresh();
});

$('asOf').addEventListener('change', refresh);

// ---------- общие элементы ----------

function asOf() {
  return $('asOf').value || new Date().toISOString().slice(0, 10);
}

function srcLink(source, text) {
  if (!source) return '';
  const label = text ?? `${source.fileName}${source.clause ? ', п. ' + source.clause : ', абз. ' + (source.paraIndex + 1)}`;
  return `<button class="src" type="button" data-doc="${esc(source.docId)}" data-start="${source.start}" data-end="${source.end}">${esc(label)} ↗</button>`;
}

function quote(source, cls = '') {
  if (!source) return '';
  return `<blockquote class="${cls}">«${esc(source.quote.replace(/\s+/g, ' '))}»<div class="sub">${srcLink(source, `${source.fileName}${source.clause ? ', п. ' + source.clause : ''} — открыть абзац`)}</div></blockquote>`;
}

const STATUS_BADGE = {
  ok: '<span class="badge b-ok">подтверждено</span>',
  review: '<span class="badge b-review">требует проверки</span>',
  missing: '<span class="badge b-missing">нет данных</span>',
};

// ---------- таблица договоров ----------

function fieldCell(f) {
  const val = `<div class="val ${f.status}">${esc(f.display)}</div>`;
  const meta = [];
  if (f.changedBy) meta.push(`<span class="badge b-changed">изменено: ${esc(f.changedBy.label)}</span>`);
  if (f.status === 'review') meta.push('<span class="badge b-review">проверить</span>');
  if (f.source && f.status !== 'missing') meta.push(srcLink(f.source));
  else if (f.hints[0]) meta.push(srcLink(f.hints[0], 'почему нет данных'));
  return val + `<div class="sub">${meta.join(' ')}</div>`;
}

function renderContracts() {
  const a = state.analysis;
  $('contractsTitle').textContent = `Условия договоров на ${isoToRu(a.asOf)}`;
  const rows = a.contracts.map((c) => {
    const checks = [];
    if (c.needsReview) checks.push(STATUS_BADGE.review);
    for (const f of c.missing) checks.push(`<span class="badge b-missing">нет данных: ${esc(FIELD_LABELS[f].toLowerCase())}</span>`);
    if (!checks.length) checks.push(STATUS_BADGE.ok);
    const unagreed = c.proposals.filter((p) => p.kind !== 'pending');
    const pending = c.proposals.filter((p) => p.kind === 'pending');
    const props = [
      ...unagreed.map((p) => `<div><span class="badge b-proposal">${esc(FIELD_LABELS[p.field].toLowerCase())} → ${esc(p.display)}</span><span class="sub">${esc(p.docLabel)}</span></div>`),
      ...pending.map((p) => `<div><span class="badge b-pending">${esc(FIELD_LABELS[p.field].toLowerCase())} → ${esc(p.display)}</span><span class="sub">ещё не действует</span></div>`),
    ].join('') || '<span class="sub">нет</span>';
    const open = state.openRows.has(c.id);
    return `
      <tr class="row ${open ? 'open' : ''}" data-row="${c.id}">
        <td class="num">${esc(c.number)}</td>
        <td>${esc(c.supplier?.name ?? 'нет данных')}</td>
        <td>${fieldCell(c.fields.amount)}</td>
        <td>${fieldCell(c.fields.delivery)}</td>
        <td>${checks.join('')}</td>
        <td>${props}</td>
      </tr>
      ${open ? `<tr class="details"><td colspan="6">${renderDetails(c)}</td></tr>` : ''}`;
  });
  $('contractsTable').querySelector('tbody').innerHTML = rows.join('') ||
    '<tr><td colspan="6" class="sub">Договоры не найдены среди загруженных файлов.</td></tr>';
}

function renderFieldCard(c, field) {
  const f = c.fields[field];
  let html = `<div class="card"><h3>${esc(FIELD_LABELS[field])}</h3><div class="val ${f.status}">${esc(f.display)}</div> ${STATUS_BADGE[f.status]}`;
  if (f.status !== 'missing' && f.source) {
    html += f.changedBy
      ? `<div class="note">Основание — <b>${esc(f.changedBy.label)}</b> (${esc(f.changedBy.fileName)}), вступило в силу ${isoToRu(f.changedBy.effective)}:</div>`
      : '<div class="note">Основание — текст договора:</div>';
    html += quote(f.source);
  }
  for (const r of f.reasons) html += `<div class="note warn">⚠ ${esc(r)}</div>`;
  if (f.status === 'missing') {
    html += '<div class="note">Значение в загруженных документах не найдено. Значение не подставлено.</div>';
    for (const h of f.hints) html += `<div class="note">Что сказано в документе:</div>${quote(h, 'muted')}`;
  }
  if (f.history.length > 1) {
    html += '<div class="note">История изменений:</div><ol class="history">' + f.history.map((h, i) =>
      `<li class="${i === f.history.length - 1 ? 'cur' : ''}">${esc(h.display)} — ${esc(h.docLabel)}${h.effective ? ', с ' + isoToRu(h.effective) : ''} ${srcLink(h.source, 'цитата')}</li>`).join('') + '</ol>';
  }
  for (const e of f.excluded) {
    html += `<div class="note">Не принято как сумма договора: ${esc(e.reason)}</div>${quote(e.source, 'muted')}`;
  }
  const props = c.proposals.filter((p) => p.field === field);
  for (const p of props) {
    html += `<div class="note"><span class="badge ${p.kind === 'pending' ? 'b-pending' : 'b-proposal'}">${esc(p.kindLabel)}</span> ${esc(p.docLabel)}: <b>${esc(p.display)}</b> вместо ${esc(p.currentDisplay)}</div>${quote(p.source, 'prop')}`;
  }
  return html + '</div>';
}

function renderDetails(c) {
  let html = '<div class="cards">' + FIELDS.map((f) => renderFieldCard(c, f)).join('');
  html += '<div class="card"><h3>Связанные документы</h3><ul class="plain">';
  html += `<li><b>${esc(c.doc.label)}</b> — ${esc(c.doc.name)} ${srcLink(c.doc.status.source, 'статус')}</li>`;
  for (const { doc, role } of c.docs) {
    const cls = role.code === 'applied' ? 'b-ok' : role.code === 'unclear' ? 'b-review' : role.code === 'pending' ? 'b-pending' : 'b-proposal';
    html += `<li><b>${esc(doc.label)}</b> — ${esc(doc.name)}<br><span class="badge ${cls}">${esc(role.label)}</span> ${srcLink(doc.status.source ?? doc.effective?.source, 'статус')}</li>`;
  }
  if (!c.docs.length) html += '<li class="sub">Других документов по договору нет</li>';
  html += '</ul>';
  if (c.flags.length) {
    html += '<h3>Требует проверки</h3><ul class="plain">' + c.flags.map((fl) => `<li class="note warn">${esc(fl.text)} ${srcLink(fl.source, 'источник')}</li>`).join('') + '</ul>';
  }
  return html + '</div></div>';
}

$('contractsTable').addEventListener('click', (e) => {
  if (e.target.closest('.src')) return;
  const row = e.target.closest('tr.row');
  if (!row) return;
  const id = row.dataset.row;
  if (state.openRows.has(id)) state.openRows.delete(id); else state.openRows.add(id);
  renderContracts();
});

// ---------- документы ----------

function renderDocs() {
  const a = state.analysis;
  const STATE = { signed: 'подписан обеими сторонами', unsigned: 'не подписан', partial: 'подписан частично', unknown: 'не указан' };
  $('docsTable').querySelector('tbody').innerHTML = a.documents.map((d) => {
    const role = d.role;
    const cls = { contract: 'b-ok', applied: 'b-ok', unclear: 'b-review', unlinked: 'b-review', pending: 'b-pending' }[role.code] ?? 'b-proposal';
    const st = d.type === 'letter' ? '—' : `${STATE[d.status.state]}${d.status.date ? ' ' + isoToRu(d.status.date) : ''}`;
    const warn = d.warnings.map((w) => `<div class="note warn">⚠ ${esc(w)}</div>`).join('');
    return `<tr>
      <td>${srcLink({ docId: d.id, fileName: d.name, start: 0, end: 0, paraIndex: 0 }, d.name)}</td>
      <td>${esc(TYPE_LABELS[d.type])}${d.type !== 'contract' && d.type !== 'unknown' ? `<div class="sub">${esc(d.label)}</div>` : ''}</td>
      <td>${esc(d.type === 'contract' ? d.number ?? '—' : d.linkedTo ?? '—')}</td>
      <td>${esc(st)}${d.effective?.date ? `<div class="sub">вступает в силу ${isoToRu(d.effective.date)}</div>` : ''}</td>
      <td><span class="badge ${cls}">${esc(role.label)}</span>${warn}</td>
      <td><button class="btn small ghost" data-remove="${esc(d.name)}" type="button" title="Убрать файл">✕</button></td>
    </tr>`;
  }).join('');
}

$('docsTable').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  state.files = state.files.filter((f) => f.name !== b.dataset.remove);
  refresh();
});

// ---------- вопросы ----------

$('qaExamples').innerHTML = EXAMPLE_QUESTIONS.map((q) => `<button class="chip" type="button">${esc(q)}</button>`).join('');
$('qaExamples').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('qaInput').value = chip.textContent;
  ask(chip.textContent);
});
$('qaForm').addEventListener('submit', (e) => {
  e.preventDefault();
  ask($('qaInput').value);
});

const LINE_BADGE = {
  ok: 'b-ok', review: 'b-review', missing: 'b-missing', proposal: 'b-proposal', pending: 'b-pending',
};

function ask(question) {
  state.lastQuestion = question;
  const r = answerQuestion(question, state.files, { asOf: asOf() });
  if (!r.ok) { $('qaAnswer').innerHTML = `<div class="answer error">${esc(r.message)}</div>`; return; }
  const blocks = r.blocks.map((b) => `<div class="block"><div class="num">${esc(b.contract)} <span class="sub">${esc(b.supplier ?? '')}</span></div>` +
    b.lines.map((l) => `<div class="line"><span class="badge ${LINE_BADGE[l.kind] ?? 'b-missing'}">${esc(l.label)}</span> <b>${esc(l.value)}</b>
      ${l.source ? quote(l.source, l.kind === 'proposal' || l.kind === 'pending' ? 'prop' : '') : ''}
      ${l.notes.map((n) => `<div class="note">${esc(n.text)}${n.source ? ': ' : ''}</div>${n.source ? quote(n.source, 'muted') : ''}`).join('')}</div>`).join('') +
    '</div>').join('');
  $('qaAnswer').innerHTML = `<div class="answer"><div class="sub">${esc(r.title)}</div><div class="summary">${esc(r.summary)}</div>${blocks}</div>`;
}

// ---------- просмотр документа ----------

document.addEventListener('click', (e) => {
  const b = e.target.closest('.src');
  if (!b) return;
  e.stopPropagation();
  openViewer(b.dataset.doc, Number(b.dataset.start), Number(b.dataset.end));
});

function openViewer(docId, start, end) {
  const doc = state.analysis.documents.find((d) => d.id === docId);
  if (!doc) return;
  $('viewerTitle').textContent = doc.name;
  $('viewerMeta').textContent = `${TYPE_LABELS[doc.type]} · ${doc.label} · ${doc.role?.label ?? ''}`;
  const hasRange = end > start;
  $('viewerBody').innerHTML = doc.paragraphs.map((p) => {
    const inPara = hasRange && start >= p.start && start < p.end;
    let body = esc(p.text);
    if (inPara) {
      const s = start - p.start;
      const e2 = Math.min(end, p.end) - p.start;
      body = esc(p.text.slice(0, s)) + '<mark>' + esc(p.text.slice(s, e2)) + '</mark>' + esc(p.text.slice(e2));
    }
    return `<p class="para ${inPara ? 'target' : ''}" id="para-${p.index}"><span class="pn">${p.index + 1}</span><span>${body}</span></p>`;
  }).join('');
  $('viewer').hidden = false;
  const target = $('viewerBody').querySelector('.target');
  if (target) target.scrollIntoView({ block: 'center' }); else $('viewerBody').scrollTop = 0;
}

function closeViewer() { $('viewer').hidden = true; }
$('viewerClose').addEventListener('click', closeViewer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });

// ---------- перерисовка ----------

function refresh() {
  const has = state.files.length > 0;
  for (const id of ['contractsSection', 'qaSection', 'docsSection']) $(id).hidden = !has;
  if (!has) { state.analysis = null; return; }
  state.analysis = analyze(state.files, { asOf: asOf() });
  renderContracts();
  renderDocs();
  if (state.lastQuestion) ask(state.lastQuestion);
}
