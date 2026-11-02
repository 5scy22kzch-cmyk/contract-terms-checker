// Движок сверки: классифицирует документы, связывает их с договорами,
// применяет только подписанные и вступившие в силу допсоглашения и
// возвращает сумму и срок поставки с цитатой-основанием.
//
// Работает на правилах (регулярные выражения + структура пунктов), без LLM.
// Ни одно значение не берётся из имени файла или порядка загрузки.

import {
  normalizeText, splitParagraphs, splitSentences, findDates, findAmounts,
  readOrg, normOrg, normNumber, isoToRu, formatRub,
} from './text.js';

export { isoToRu, formatRub };

export const FIELDS = ['amount', 'delivery'];
export const FIELD_LABELS = { amount: 'Сумма договора', delivery: 'Срок поставки' };

export const TYPE_LABELS = {
  contract: 'Договор',
  amendment: 'Допсоглашение',
  draft: 'Проект допсоглашения',
  letter: 'Письмо',
  unknown: 'Не распознан',
};

// ---------- признаки полей ----------

const AMOUNT_KEY = /(?:общ|итогов|полн)[а-яё]*\s+(?:стоимост|цен|сумм)[а-яё]*|(?:цен|стоимост|сумм)[а-яё]*\s+(?:настоящего\s+)?договора/iu;
const AMOUNT_EXCL = /аванс|предоплат|лимит|бюджет|неустойк|штраф|пен[иья]/iu;
const DELIVERY_KEY = /(?<![а-яё])(?:постав(?!щик)|отгруз)[а-яё]*/iu;
const DELIVERY_EXCL = /оплат|при[её]мк|аванс|плат[её]ж|неустойк|штраф/iu;
const TERM_HINT = /срок|не\s+позднее|в\s+течение/iu;
// Только глагольные формы «вступает/вступит в силу»: фраза «даты вступления в силу»
// из общих условий договора датой вступления не является.
const EFFECTIVE_RE = /вступ(?:ает|ают|ит|ят)\s+в\s+(?:законную\s+)?силу/iu;

// ---------- разбор одного документа ----------

export function parseDocument(file, idx) {
  const text = normalizeText(file.text);
  const paragraphs = splitParagraphs(text);
  const header = paragraphs[0]?.text ?? '';
  const doc = {
    id: `d${idx}`,
    name: file.name,
    text,
    paragraphs,
    header,
    type: detectType(header, text),
    warnings: [],
  };
  doc.number = doc.type === 'contract' ? readContractNumber(header) : null;
  doc.amendmentNo = /соглашени[а-яё]*\s*№\s*(\d+)/iu.exec(header)?.[1] ?? null;
  doc.docDate = readLabeledDate(doc, /^дата[^:\n]{0,20}:/iu);
  doc.status = parseStatus(doc);
  doc.effective = doc.type === 'contract' ? null : parseEffective(doc);
  doc.supplier = readParty(doc, 'Поставщик');
  doc.buyer = readParty(doc, 'Покупатель');
  if (doc.type === 'letter') {
    doc.sender = readParty(doc, 'От');
    doc.recipient = readParty(doc, 'Кому');
  }
  if (doc.type === 'contract' && !doc.number) doc.warnings.push('Не найден номер договора в заголовке');
  if (doc.type === 'unknown') doc.warnings.push('Тип документа не распознан по заголовку');
  doc.label = docLabel(doc);
  return doc;
}

function detectType(header, text) {
  const h = header.toUpperCase();
  if (/ПИСЬМО/u.test(h) || (/^от\s*:/imu.test(text) && /^кому\s*:/imu.test(text))) return 'letter';
  if (/СОГЛАШЕНИ/u.test(h)) return /ПРОЕКТ/u.test(h) ? 'draft' : 'amendment';
  if (/ДОГОВОР/u.test(h)) return 'contract';
  return 'unknown';
}

function readContractNumber(header) {
  const m = /№\s*([^\s,;]+)/u.exec(header);
  return m ? m[1].replace(/[.»"]+$/u, '') : null;
}

function docLabel(doc) {
  const date = doc.docDate ? ` от ${isoToRu(doc.docDate.iso)}` : '';
  switch (doc.type) {
    case 'contract': return `Договор ${doc.number ?? '(без номера)'}`;
    case 'amendment': return `ДС${doc.amendmentNo ? ' № ' + doc.amendmentNo : ''}${date}`;
    case 'draft': return `Проект ДС${doc.amendmentNo ? ' № ' + doc.amendmentNo : ''}${date}`;
    case 'letter': return `Письмо${date}`;
    default: return doc.name;
  }
}

export function sourceOf(doc, start, end) {
  const para = doc.paragraphs.find((p) => start >= p.start && start < p.end) ?? doc.paragraphs[0];
  return {
    docId: doc.id,
    fileName: doc.name,
    paraIndex: para?.index ?? 0,
    clause: para?.clause ?? null,
    start,
    end,
    quote: doc.text.slice(start, end),
  };
}

function sentenceSource(doc, s) {
  return sourceOf(doc, s.start, s.end);
}

function readLabeledDate(doc, labelRe) {
  for (const p of doc.paragraphs) {
    if (!labelRe.test(p.text)) continue;
    const d = findDates(doc.text, p.start, p.end)[0];
    if (d) return { iso: d.iso, source: sourceOf(doc, p.start, p.end) };
  }
  return null;
}

function parseStatus(doc) {
  const headerDraft = /ПРОЕКТ/u.test(doc.header.toUpperCase());
  const p = doc.paragraphs.find((x) => /^статус\s*:/iu.test(x.text));
  const source = p ? sourceOf(doc, p.start, p.end) : null;
  const raw = p?.text ?? null;
  if (headerDraft) return { state: 'unsigned', date: null, source: source ?? sourceOf(doc, doc.paragraphs[0].start, doc.paragraphs[0].end), raw };
  if (!p) return { state: 'unknown', date: null, source: null, raw };
  if (/не\s+подписан|проект|на\s+согласовании/iu.test(raw)) return { state: 'unsigned', date: null, source, raw };
  if (/подписан[а-яё]*\s+(?:обеими\s+сторонами|сторонами)/iu.test(raw)) {
    const d = findDates(doc.text, p.start, p.end)[0];
    return { state: 'signed', date: d?.iso ?? doc.docDate?.iso ?? null, dateFromDocDate: !d, source, raw };
  }
  if (/подписан/iu.test(raw)) return { state: 'partial', date: null, source, raw };
  return { state: 'unknown', date: null, source, raw };
}

function parseEffective(doc) {
  for (const p of doc.paragraphs) {
    for (const s of splitSentences(doc.text, p.bodyStart, p.end)) {
      const t = doc.text.slice(s.start, s.end);
      if (!EFFECTIVE_RE.test(t)) continue;
      const d = findDates(doc.text, s.start, s.end)[0];
      if (d) return { date: d.iso, source: sentenceSource(doc, s) };
      if (/(?:с|после)\s+(?:даты\s+|момента\s+)?(?:его\s+|е[её]\s+)?подписани/iu.test(t)) {
        return { date: doc.status.date, onSigning: true, source: sentenceSource(doc, s) };
      }
    }
  }
  return null;
}

function readParty(doc, label) {
  for (const p of doc.paragraphs) {
    const org = readOrg(doc.text, p.start, p.end, label);
    if (org) return { name: org.name, source: sourceOf(doc, org.start, org.end) };
  }
  return null;
}

// ---------- извлечение полей из предложения ----------

/** Выбор значения в предложении: «с X на Y» → Y; «не позднее X»/«на X» → X. */
function pickValue(text, items) {
  for (let i = 0; i + 1 < items.length; i++) {
    const between = text.slice(items[i].end, items[i + 1].start);
    const before = text.slice(Math.max(0, items[i].start - 4), items[i].start);
    if (/^\s*(?:на|до)\s*$/u.test(between) && /(?:^|\s)с\s*$/u.test(before)) {
      return { pick: items[i + 1], from: items[i] };
    }
  }
  const marked = items.filter((it) =>
    /(?:не\s+позднее|не\s+позже|до|на)\s*$/iu.test(text.slice(Math.max(0, it.start - 14), it.start)));
  if (marked.length === 1) return { pick: marked[0] };
  if (items.length === 1) return { pick: items[0] };
  return { ambiguous: items };
}

/**
 * Кандидаты значения поля в сегменте [from, to) документа.
 * hints — фразы о поле без конкретного значения (для «нет данных» с объяснением),
 * excluded — найденные суммы, которые не являются стоимостью договора.
 */
export function extractField(field, doc, from, to) {
  const res = { cands: [], hints: [], excluded: [] };
  // Подсказка «почему нет данных» — весь абзац: пояснение часто идёт следующим предложением.
  const hint = (s) => {
    const p = doc.paragraphs.find((x) => s.start >= x.start && s.start < x.end);
    const src = sourceOf(doc, Math.max(from, p.bodyStart), Math.min(to, p.end));
    if (!res.hints.some((h) => h.start === src.start)) res.hints.push(src);
  };
  for (const s of splitSentences(doc.text, from, to)) {
    const t = doc.text.slice(s.start, s.end);
    if (EFFECTIVE_RE.test(t)) continue;
    if (field === 'amount') {
      const amounts = findAmounts(doc.text, s.start, s.end);
      const key = AMOUNT_KEY.exec(t);
      const excl = AMOUNT_EXCL.exec(t);
      if (key && !excl) {
        if (!amounts.length) { hint(s); continue; }
        const afterKey = amounts.filter((a) => a.start - s.start >= key.index);
        const { pick, from: prev, ambiguous } = pickValue(doc.text, afterKey.length ? afterKey : amounts);
        const c = pick ?? ambiguous[0];
        res.cands.push({
          field, value: c.value, from: prev?.value ?? null,
          ambiguous: ambiguous ? ambiguous.map((a) => a.value) : null,
          words: c.words, wordsValue: c.wordsValue,
          source: sentenceSource(doc, s),
        });
      } else if (amounts.length) {
        for (const a of amounts) {
          res.excluded.push({
            value: a.value,
            reason: excl ? `это «${excl[0].toLowerCase()}», а не стоимость договора` : 'не указано, что это стоимость договора',
            source: sentenceSource(doc, s),
          });
        }
      }
    } else {
      if (!DELIVERY_KEY.test(t) || DELIVERY_EXCL.test(t)) continue;
      const dates = findDates(doc.text, s.start, s.end);
      if (!dates.length) {
        if (TERM_HINT.test(t)) hint(s);
        continue;
      }
      const { pick, from: prev, ambiguous } = pickValue(doc.text, dates);
      res.cands.push({
        field, value: (pick ?? ambiguous[0]).iso, from: prev?.iso ?? null,
        ambiguous: ambiguous ? ambiguous.map((d) => d.iso) : null,
        source: sentenceSource(doc, s),
      });
    }
  }
  return res;
}

export function displayValue(field, value) {
  if (value == null) return 'нет данных';
  return field === 'amount' ? formatRub(value) : isoToRu(value);
}

/** Итог по полю из набора кандидатов. */
function resolveField(field, cands, hints = [], excluded = []) {
  const base = { field, hints, excluded, candidates: cands, reasons: [] };
  if (!cands.length) return { ...base, status: 'missing', value: null, display: 'нет данных', source: null };
  const distinct = [...new Set(cands.map((c) => c.value))];
  if (distinct.length > 1) {
    return {
      ...base, status: 'review', value: null, display: 'неоднозначно', source: cands[0].source,
      reasons: [`Найдено несколько разных значений: ${distinct.map((v) => displayValue(field, v)).join(', ')}`],
    };
  }
  const c = cands[0];
  const reasons = [];
  if (c.ambiguous) reasons.push(`В одном предложении несколько значений (${c.ambiguous.map((v) => displayValue(field, v)).join(', ')}) — выбрано первое, проверьте`);
  if (field === 'amount' && c.wordsValue != null && c.wordsValue !== Math.trunc(c.value)) {
    reasons.push(`Сумма цифрами (${formatRub(c.value)}) не совпадает с суммой прописью «${c.words}» (${formatRub(c.wordsValue)})`);
  }
  return { ...base, status: reasons.length ? 'review' : 'ok', value: c.value, display: displayValue(field, c.value), source: c.source, from: c.from, reasons };
}

// ---------- изменения из допсоглашений ----------

/** «Пункт 3.1 договора изложить в следующей редакции: «…»» → замены пунктов; остальное — прямые формулировки. */
export function parseChanges(doc) {
  const replacements = [];
  const removals = [];
  const used = new Set();
  for (const p of doc.paragraphs) {
    const m = /пункт[а-яё]*\s+(\d+(?:\.\d+)*)[^«\n]*?(?:изложить|читать)[^«\n]*?«/iu.exec(p.text);
    if (m) {
      const qStart = p.start + m.index + m[0].length;
      let depth = 1;
      let k = qStart;
      while (k < p.end && depth > 0) {
        if (doc.text[k] === '«') depth++;
        else if (doc.text[k] === '»') depth--;
        k++;
      }
      if (depth === 0) {
        replacements.push({ clause: m[1], start: qStart, end: k - 1, paraIndex: p.index });
        used.add(p.index);
      }
      continue;
    }
    const r = /пункт[а-яё]*\s+(\d+(?:\.\d+)*)[^.\n]*?(?:исключить|утратил[а-яё]*\s+силу)/iu.exec(p.text);
    if (r) {
      removals.push({ clause: r[1], paraIndex: p.index, source: sourceOf(doc, p.start, p.end) });
      used.add(p.index);
    }
  }
  const direct = doc.paragraphs.filter((p) => p.index > 0 && !used.has(p.index));
  return { replacements, removals, direct };
}

/** Значения полей, которые документ предлагает или устанавливает. */
function changeCandidates(doc) {
  const { replacements, direct } = parseChanges(doc);
  const out = {};
  for (const field of FIELDS) {
    const cands = [];
    for (const r of replacements) cands.push(...extractField(field, doc, r.start, r.end).cands.map((c) => ({ ...c, clause: r.clause })));
    if (!cands.length) for (const p of direct) cands.push(...extractField(field, doc, p.bodyStart, p.end).cands);
    out[field] = cands;
  }
  return out;
}

// ---------- роль документа относительно договора на дату проверки ----------

function classifyRole(d, contract, asOf) {
  const s = d.status;
  if (d.type === 'letter') return { code: 'letter', applies: false, label: 'Письмо: предложение, условия не меняет' };
  if (d.type === 'unknown') return { code: 'unclear', applies: false, label: 'Тип документа не распознан — требует проверки' };
  if (d.type === 'contract') return { code: 'unclear', applies: false, label: 'Ещё один договор с тем же номером — требует проверки' };
  if (d.type === 'draft' || s.state === 'unsigned') return { code: 'draft', applies: false, label: 'Проект: не подписан, условия не меняет' };
  if (s.state === 'partial') return { code: 'unclear', applies: false, label: 'Подписано не всеми сторонами — требует проверки' };
  if (s.state !== 'signed') return { code: 'unclear', applies: false, label: 'Статус подписания не найден — требует проверки' };
  if (d.supplier && contract.supplier && normOrg(d.supplier.name) !== normOrg(contract.supplier.name)) {
    return { code: 'unclear', applies: false, label: `Поставщик в ДС (${d.supplier.name}) не совпадает с договором — требует проверки` };
  }
  if (!s.date) return { code: 'unclear', applies: false, label: 'Подписано, но дата подписания не найдена — требует проверки' };
  if (s.date > asOf) return { code: 'pending', applies: false, label: `Подписано ${isoToRu(s.date)} — после даты проверки` };
  if (!d.effective?.date) return { code: 'unclear', applies: false, label: 'Не указана дата вступления в силу — требует проверки' };
  if (d.effective.date > asOf) return { code: 'pending', applies: false, label: `Вступает в силу ${isoToRu(d.effective.date)} — после даты проверки` };
  return { code: 'applied', applies: true, label: `Применено: подписано ${isoToRu(s.date)}, вступило в силу ${isoToRu(d.effective.date)}` };
}

const PROPOSAL_KIND = {
  letter: 'Предложение в письме (не согласовано)',
  draft: 'Проект изменения (не подписан)',
  unclear: 'Изменение с неясным статусом',
  pending: 'Подписано, но ещё не действует',
};

// ---------- анализ договора ----------

function computeFields(state) {
  const out = {};
  for (const field of FIELDS) {
    const cands = [];
    const hints = [];
    const excluded = [];
    for (const seg of state.clauses.values()) {
      const r = extractField(field, seg.doc, seg.start, seg.end);
      cands.push(...r.cands);
      hints.push(...r.hints);
      excluded.push(...r.excluded);
    }
    out[field] = state.overrides[field]
      ? resolveField(field, [state.overrides[field]], hints, excluded)
      : resolveField(field, cands, hints, excluded);
  }
  return out;
}

function analyzeContract(c, related, asOf) {
  const flags = [];
  if (c.status.state !== 'signed') {
    flags.push({ text: `Статус договора не подтверждён как подписанный обеими сторонами`, source: c.status.source });
  } else if (c.status.date && c.status.date > asOf) {
    flags.push({ text: `Договор подписан ${isoToRu(c.status.date)} — после даты проверки`, source: c.status.source });
  }

  const state = { clauses: new Map(), overrides: {} };
  for (const p of c.paragraphs) {
    const key = p.clause && !state.clauses.has(p.clause) ? p.clause : `#${p.index}`;
    state.clauses.set(key, { doc: c, start: p.bodyStart, end: p.end });
  }
  const base = computeFields(state);
  const history = Object.fromEntries(FIELDS.map((f) => [f, base[f].value != null
    ? [{ value: base[f].value, display: base[f].display, source: base[f].source, docId: c.id, docLabel: c.label }]
    : []]));

  const docs = related.map((d) => ({ doc: d, role: classifyRole(d, c, asOf) }));
  const applied = docs.filter((x) => x.role.applies).map((x) => x.doc).sort((a, b) =>
    a.effective.date.localeCompare(b.effective.date) ||
    (a.status.date ?? '').localeCompare(b.status.date ?? '') ||
    (Number(a.amendmentNo) || 0) - (Number(b.amendmentNo) || 0));

  let prev = base;
  const lastTouch = {};
  const fieldReasons = { amount: [], delivery: [] };
  for (const a of applied) {
    const { replacements, removals, direct } = parseChanges(a);
    const touched = new Set();
    for (const r of replacements) {
      if (!state.clauses.has(r.clause)) flags.push({ text: `${a.label} меняет пункт ${r.clause}, которого нет в договоре`, source: sourceOf(a, r.start, r.end) });
      state.clauses.set(r.clause, { doc: a, start: r.start, end: r.end });
      for (const f of FIELDS) {
        if (extractField(f, a, r.start, r.end).cands.length) { touched.add(f); delete state.overrides[f]; }
      }
    }
    for (const r of removals) state.clauses.delete(r.clause);
    for (const p of direct) {
      for (const f of FIELDS) {
        if (touched.has(f)) continue;
        const cand = extractField(f, a, p.bodyStart, p.end).cands[0];
        if (cand) { state.overrides[f] = cand; touched.add(f); }
      }
    }
    const now = computeFields(state);
    for (const f of FIELDS) {
      const changed = now[f].value !== prev[f].value || now[f].source?.docId !== prev[f].source?.docId;
      if (!changed) continue;
      if (lastTouch[f] && lastTouch[f].eff === a.effective.date && lastTouch[f].value !== now[f].value) {
        fieldReasons[f].push(`${lastTouch[f].label} и ${a.label} вступают в силу в один день и задают разные значения — проверьте порядок`);
      }
      lastTouch[f] = { eff: a.effective.date, value: now[f].value, label: a.label };
      history[f].push({ value: now[f].value, display: now[f].display, source: now[f].source, docId: a.id, docLabel: a.label, effective: a.effective.date });
    }
    prev = now;
  }

  const fields = {};
  for (const f of FIELDS) {
    const r = prev[f];
    const reasons = [...r.reasons, ...fieldReasons[f]];
    const changedBy = r.source && r.source.docId !== c.id ? docs.find((x) => x.doc.id === r.source.docId)?.doc : null;
    fields[f] = {
      ...r,
      reasons,
      status: r.status === 'missing' ? 'missing' : reasons.length ? 'review' : 'ok',
      history: history[f],
      changedBy: changedBy ? { docId: changedBy.id, label: changedBy.label, fileName: changedBy.name, effective: changedBy.effective?.date } : null,
    };
  }

  // Несогласованные или ещё не действующие изменения — отдельно, условия они не меняют.
  const proposals = [];
  for (const { doc: d, role } of docs) {
    if (role.applies) continue;
    if (role.code === 'unclear') flags.push({ text: `${d.label} (${d.name}): ${role.label}`, source: d.status.source });
    const cc = changeCandidates(d);
    for (const f of FIELDS) {
      for (const cand of cc[f]) {
        proposals.push({
          field: f,
          kind: role.code,
          kindLabel: PROPOSAL_KIND[role.code] ?? role.label,
          value: cand.value,
          display: displayValue(f, cand.value),
          current: fields[f].value,
          currentDisplay: fields[f].display,
          docId: d.id,
          docLabel: d.label,
          fileName: d.name,
          source: cand.source,
        });
      }
    }
  }

  const missing = FIELDS.filter((f) => fields[f].status === 'missing');
  const needsReview = flags.length > 0 || FIELDS.some((f) => fields[f].status === 'review');
  return {
    id: c.id,
    number: c.number,
    doc: c,
    supplier: c.supplier,
    fields,
    flags,
    docs,
    proposals,
    missing,
    needsReview,
  };
}

// ---------- точка входа ----------

/**
 * files: [{name, text}], asOf: 'YYYY-MM-DD'.
 * Результат не зависит от имён файлов и порядка загрузки.
 */
export function analyze(files, { asOf }) {
  const documents = files.map((f, i) => parseDocument(f, i));
  const contracts = documents.filter((d) => d.type === 'contract' && d.number);

  const byNumber = new Map();
  for (const c of contracts) {
    const key = normNumber(c.number);
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key).push(c);
  }

  // Связывание: документ относится к договору, если его номер встречается в тексте ровно один раз среди известных.
  const related = new Map(contracts.map((c) => [c.id, []]));
  const unlinked = [];
  for (const d of documents) {
    if (d.type === 'contract' && d.number) continue;
    const up = d.text.toUpperCase().replace(/[‐-―−]/g, '-');
    const refs = [...byNumber.keys()].filter((k) =>
      new RegExp(`(?<![A-ZА-ЯЁ0-9-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-ZА-ЯЁ0-9])`, 'u').test(up));
    d.refs = refs;
    if (refs.length === 1) {
      for (const c of byNumber.get(refs[0])) related.get(c.id).push(d);
      d.linkedTo = byNumber.get(refs[0])[0].number;
    } else {
      const mentioned = [...d.text.matchAll(/договор[а-яё]*\s+(?:поставки\s+)?(?:№\s*)?([A-Za-zА-Яа-яЁё]{1,10}-?\d[\w\-/]*)/giu)].map((m) => m[1]);
      d.linkProblem = refs.length > 1
        ? `Упоминает несколько договоров (${refs.join(', ')}) — не удалось однозначно связать`
        : mentioned.length
          ? `Ссылается на договор ${[...new Set(mentioned)].join(', ')}, который не загружен`
          : 'Не удалось определить, к какому договору относится';
      unlinked.push(d);
    }
  }

  const results = contracts.map((c) => {
    const r = analyzeContract(c, related.get(c.id), asOf);
    if (byNumber.get(normNumber(c.number)).length > 1) {
      r.flags.unshift({ text: `Загружено несколько договоров с номером ${c.number} — проверьте, какой действует`, source: null });
      r.needsReview = true;
    }
    return r;
  });
  results.sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }));

  // Роль каждого документа — для списка документов в интерфейсе.
  for (const d of documents) {
    if (d.type === 'contract' && d.number) { d.role = { code: 'contract', label: 'Договор' }; continue; }
    const owner = results.find((r) => r.docs.some((x) => x.doc.id === d.id));
    d.role = owner ? owner.docs.find((x) => x.doc.id === d.id).role : { code: 'unlinked', label: d.linkProblem };
  }

  return { asOf, documents, contracts: results, unlinked };
}
