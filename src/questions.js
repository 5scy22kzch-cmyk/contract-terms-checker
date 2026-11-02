// Ответы на вопросы закупщика. Вопрос разбирается правилами:
// номер договора, поле (срок/сумма), дата «на …» (дата проверки),
// граница «раньше/до …» и признак «несогласованные изменения».
// Ответ собирается из результата analyze() — у каждой строки есть источник.

import { analyze, FIELD_LABELS, displayValue, isoToRu } from './engine.js';
import { findDates, normNumber } from './text.js';

export const EXAMPLE_QUESTIONS = [
  'Какой срок поставки действует по договору STN-101 на 10 марта 2026 года?',
  'Какова сумма договора STN-102?',
  'Какова сумма договора STN-103?',
  'По каким договорам поставка запланирована раньше 1 апреля 2026 года и есть ли несогласованные изменения срока?',
];

const UNAGREED = new Set(['letter', 'draft', 'unclear']);

/** Разбор вопроса без выполнения — пригодится для отладки и тестов. */
export function parseQuestion(question, knownNumbers) {
  const q = question.toLowerCase();
  const up = question.toUpperCase().replace(/[‐-―−]/g, '-');
  const contracts = knownNumbers.filter((n) => up.includes(normNumber(n)));
  const dates = findDates(question);
  let before = null;
  let asOf = null;
  for (const d of dates) {
    const prefix = question.slice(Math.max(0, d.start - 12), d.start).toLowerCase();
    if (/(?:раньше|ранее|до)\s*$/u.test(prefix)) before = d.iso;
    else if (/(?:^|[^а-яё])на\s*$/u.test(prefix)) asOf = d.iso;
  }
  const wantsDelivery = /срок|дат[аы]|когда|постав/u.test(q);
  const wantsAmount = /сумм|стоимост|цен[аы]|сколько/u.test(q);
  const wantsProposals = /несогласован|предлож|перенос|изменени|проект/u.test(q);
  let fields = [];
  if (wantsAmount) fields.push('amount');
  if (wantsDelivery && !(wantsAmount && !/срок/u.test(q))) fields.push('delivery');
  if (!fields.length) fields = ['amount', 'delivery'];
  return { contracts, before, asOf, fields, wantsProposals };
}

function valueLine(c, field) {
  const f = c.fields[field];
  const line = {
    kind: f.status,
    label: FIELD_LABELS[field],
    value: f.display,
    source: f.source,
    notes: [],
  };
  if (f.changedBy) {
    const first = f.history[0];
    line.notes.push({ text: `Изменено: ${f.changedBy.label} (${f.changedBy.fileName}), вступило в силу ${isoToRu(f.changedBy.effective)}${first ? `. Было: ${first.display}` : ''}`, source: first?.source });
  }
  for (const r of f.reasons) line.notes.push({ text: `Требует проверки: ${r}` });
  if (f.status === 'missing') {
    line.notes.push({ text: 'Значение в загруженных документах не найдено — не придумываем.' });
    for (const h of f.hints) line.notes.push({ text: 'Что сказано в документе', source: h });
  }
  for (const e of f.excluded) {
    line.notes.push({ text: `Найдена сумма ${displayValue('amount', e.value)}, но она не принята как сумма договора: ${e.reason}`, source: e.source });
  }
  return line;
}

function proposalLines(c, field) {
  return c.proposals.filter((p) => p.field === field).map((p) => ({
    kind: UNAGREED.has(p.kind) ? 'proposal' : 'pending',
    label: p.kindLabel,
    value: p.display,
    source: p.source,
    notes: [{ text: `${p.docLabel} (${p.fileName}). Действующее значение: ${p.currentDisplay}` }],
  }));
}

function flagLines(c) {
  return c.flags.map((fl) => ({ kind: 'review', label: 'Требует проверки', value: fl.text, source: fl.source, notes: [] }));
}

/**
 * files — загруженные файлы, asOf — дата проверки из интерфейса.
 * Возвращает {ok, title, summary, asOf, blocks:[{contract, lines}]} или {ok:false, message}.
 */
export function answerQuestion(question, files, { asOf }) {
  if (!question.trim()) return { ok: false, message: 'Введите вопрос.' };
  const base = analyze(files, { asOf });
  if (!base.contracts.length) return { ok: false, message: 'Сначала загрузите договоры.' };
  const pq = parseQuestion(question, base.contracts.map((c) => c.number));
  const effectiveAsOf = pq.asOf ?? asOf;
  const a = pq.asOf && pq.asOf !== asOf ? analyze(files, { asOf: pq.asOf }) : base;
  const asOfNote = `по состоянию на ${isoToRu(effectiveAsOf)}`;

  // 1. Фильтр по сроку поставки
  if (pq.before) {
    const hits = a.contracts.filter((c) => c.fields.delivery.value && c.fields.delivery.value < pq.before);
    const unknown = a.contracts.filter((c) => !c.fields.delivery.value);
    const crossing = a.contracts.filter((c) => !hits.includes(c) &&
      c.proposals.some((p) => p.field === 'delivery' && p.value < pq.before));
    const blocks = hits.map((c) => {
      const props = proposalLines(c, 'delivery');
      return {
        contract: c.number,
        supplier: c.supplier?.name,
        lines: [
          valueLine(c, 'delivery'),
          ...(props.length ? props : [{ kind: 'ok', label: 'Несогласованные изменения срока', value: 'нет', notes: [] }]),
          ...flagLines(c),
        ],
      };
    });
    for (const c of unknown) {
      blocks.push({ contract: c.number, supplier: c.supplier?.name, lines: [{ ...valueLine(c, 'delivery'), label: 'Срок поставки неизвестен — не удалось проверить условие' }] });
    }
    for (const c of crossing) {
      blocks.push({ contract: c.number, supplier: c.supplier?.name, lines: [valueLine(c, 'delivery'), ...proposalLines(c, 'delivery').map((l) => ({ ...l, label: `${l.label} — перенос раньше ${isoToRu(pq.before)}` }))] });
    }
    const withProps = hits.filter((c) => c.proposals.some((p) => p.field === 'delivery' && UNAGREED.has(p.kind)));
    const summary = hits.length
      ? `Поставка раньше ${isoToRu(pq.before)}: ${hits.map((c) => `${c.number} (${c.fields.delivery.display})`).join(', ')}. ` +
        (withProps.length ? `Несогласованные изменения срока есть по: ${withProps.map((c) => c.number).join(', ')}.` : 'Несогласованных изменений срока нет.')
      : `Договоров с поставкой раньше ${isoToRu(pq.before)} нет.`;
    return {
      ok: true,
      title: `Договоры с поставкой раньше ${isoToRu(pq.before)}, ${asOfNote}`,
      summary: summary + (unknown.length ? ` Срок неизвестен: ${unknown.map((c) => c.number).join(', ')}.` : ''),
      asOf: effectiveAsOf,
      blocks,
    };
  }

  // 2. Вопрос по конкретным договорам
  if (pq.contracts.length) {
    const blocks = [];
    const parts = [];
    for (const num of pq.contracts) {
      for (const c of a.contracts.filter((x) => x.number === num)) {
        const lines = [];
        for (const f of pq.fields) {
          lines.push(valueLine(c, f));
          lines.push(...proposalLines(c, f));
          parts.push(`${FIELD_LABELS[f].toLowerCase()} по ${c.number}: ${c.fields[f].display}`);
        }
        lines.push(...flagLines(c));
        blocks.push({ contract: c.number, supplier: c.supplier?.name, lines });
      }
    }
    const s = parts.join('; ');
    return { ok: true, title: `Ответ ${asOfNote}`, summary: s.charAt(0).toUpperCase() + s.slice(1) + '.', asOf: effectiveAsOf, blocks };
  }

  // 3. Только про несогласованные изменения
  if (pq.wantsProposals) {
    const blocks = a.contracts.filter((c) => c.proposals.length).map((c) => ({
      contract: c.number,
      supplier: c.supplier?.name,
      lines: pq.fields.flatMap((f) => proposalLines(c, f)),
    })).filter((b) => b.lines.length);
    return {
      ok: true,
      title: `Несогласованные изменения ${asOfNote}`,
      summary: blocks.length ? `Есть по договорам: ${blocks.map((b) => b.contract).join(', ')}.` : 'Несогласованных изменений нет.',
      asOf: effectiveAsOf,
      blocks,
    };
  }

  const mentioned = /[A-Za-zА-Яа-я]{1,10}-\d+/u.exec(question);
  return {
    ok: false,
    message: mentioned
      ? `Договор ${mentioned[0]} не найден среди загруженных. Загружены: ${base.contracts.map((c) => c.number).join(', ')}.`
      : 'Не удалось разобрать вопрос. Укажите номер договора и что нужно (сумма или срок), либо условие «раньше <дата>». Примеры — ниже.',
  };
}
