// Низкоуровневый разбор текста: абзацы, предложения, даты, суммы, названия организаций.
// Все позиции — смещения в нормализованном тексте документа, чтобы цитата
// всегда была точной подстрокой исходника.

export const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const DATE_SRC =
  String.raw`(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)` +
  String.raw`|(?<!\d)«?(\d{1,2})»?\s+(${MONTHS.join('|')})\s+(\d{4})(?:\s*(?:года|г\.))?`;

const AMOUNT_SRC =
  String.raw`(?<![\d.,])(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d{1,2}))?` +
  String.raw`\s*(?:\(([^()]*)\)\s*)?(?:руб(?:л[а-яё]*)?\.?|₽|RUB)`;

export function normalizeText(raw) {
  return String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function makeIso(y, m, d) {
  y = +y; m = +m; d = +d;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isoToRu(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function formatRub(value) {
  if (value == null) return '';
  const [int, frac] = value.toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped}${frac === '00' ? '' : ',' + frac} ₽`;
}

/** Все даты в диапазоне [from, to): {iso, start, end, raw}. */
export function findDates(text, from = 0, to = text.length) {
  const re = new RegExp(DATE_SRC, 'giu');
  re.lastIndex = from;
  const out = [];
  let m;
  while ((m = re.exec(text)) && m.index < to) {
    const end = m.index + m[0].length;
    if (end > to) break;
    const iso = m[1]
      ? makeIso(m[3], m[2], m[1])
      : makeIso(m[6], MONTHS.indexOf(m[5].toLowerCase()) + 1, m[4]);
    if (iso) out.push({ iso, start: m.index, end, raw: m[0] });
  }
  return out;
}

/** Все денежные суммы в рублях: {value, words, wordsValue, start, end, raw}. */
export function findAmounts(text, from = 0, to = text.length) {
  const re = new RegExp(AMOUNT_SRC, 'giu');
  re.lastIndex = from;
  const out = [];
  let m;
  while ((m = re.exec(text)) && m.index < to) {
    const end = m.index + m[0].length;
    if (end > to) break;
    const value = Number(m[1].replace(/[\s  ]/g, '') + (m[2] ? '.' + m[2].padEnd(2, '0') : ''));
    const words = m[3] ? m[3].trim() : null;
    out.push({ value, words, wordsValue: words ? parseRussianNumber(words) : null, start: m.index, end, raw: m[0] });
  }
  return out;
}

const NUMBER_WORDS = {
  ноль: 0, один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12,
  тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
  восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40,
  пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600,
  семьсот: 700, восемьсот: 800, девятьсот: 900,
};
const SCALES = [[/^тысяч/u, 1e3], [/^миллион/u, 1e6], [/^миллиард/u, 1e9]];

/** «один миллион двести тысяч» → 1200000; null, если встретилось незнакомое слово. */
export function parseRussianNumber(words) {
  const tokens = words.toLowerCase().replace(/ё/g, 'е').split(/[\s,\-–]+/u).filter(Boolean);
  if (!tokens.length) return null;
  let total = 0;
  let cur = 0;
  for (const t of tokens) {
    if (t in NUMBER_WORDS) { cur += NUMBER_WORDS[t]; continue; }
    const scale = SCALES.find(([re]) => re.test(t));
    if (!scale) return null;
    total += (cur || 1) * scale[1];
    cur = 0;
  }
  return total + cur;
}

const CLAUSE_RE = /^(\d+(?:\.\d+)*)\.?\s+/u;
const NEW_ITEM_RE = /^(\d+(?:\.\d+)*\.?\s|[А-ЯЁA-Z][^:\n]{0,40}:\s)/u;

/**
 * Абзац — непустая строка. Строки одного блока (без пустой строки между ними)
 * склеиваются, если предыдущая не закончена, а следующая не начинает новый пункт.
 */
export function splitParagraphs(text) {
  const lines = [];
  const re = /[^\n]+/g;
  let m;
  while ((m = re.exec(text))) {
    const line = m[0];
    if (!line.trim()) continue;
    const start = m.index + (line.length - line.trimStart().length);
    lines.push({ start, end: m.index + line.trimEnd().length });
  }
  const paras = [];
  for (const l of lines) {
    const prev = paras[paras.length - 1];
    const gap = prev ? text.slice(prev.end, l.start) : '';
    const sameBlock = prev && (gap.match(/\n/g) || []).length === 1;
    const lineText = text.slice(l.start, l.end);
    if (sameBlock && !/[.:;!?»"]$/u.test(text.slice(prev.start, prev.end)) && !NEW_ITEM_RE.test(lineText)) {
      prev.end = l.end;
    } else {
      paras.push({ start: l.start, end: l.end });
    }
  }
  return paras.map((p, index) => {
    const ptext = text.slice(p.start, p.end);
    const cm = CLAUSE_RE.exec(ptext);
    return {
      index,
      start: p.start,
      end: p.end,
      text: ptext,
      clause: cm ? cm[1] : null,
      bodyStart: p.start + (cm ? cm[0].length : 0),
    };
  });
}

/** Предложения в диапазоне [from, to): [{start, end}], без ведущих/хвостовых пробелов. */
export function splitSentences(text, from, to) {
  const out = [];
  let s = from;
  const push = (a, b) => {
    while (a < b && /\s/u.test(text[a])) a++;
    while (b > a && /\s/u.test(text[b - 1])) b--;
    if (b > a) out.push({ start: a, end: b });
  };
  for (let i = from; i < to; i++) {
    if (!'.!?'.includes(text[i])) continue;
    let j = i + 1;
    while (j < to && /[»"”)]/u.test(text[j])) j++;
    if (j >= to || !/\s/u.test(text[j])) continue;
    let k = j;
    while (k < to && /\s/u.test(text[k])) k++;
    if (k >= to || !/[A-ZА-ЯЁ«"„]/u.test(text[k])) continue;
    // «г. Москва», «п. 3» — одно-двухбуквенные сокращения не завершают предложение
    if (text[i] === '.' && /(?:^|[\s(])[а-яёa-z]{1,2}$/u.test(text.slice(Math.max(from, i - 4), i))) continue;
    push(s, j);
    s = j;
  }
  push(s, to);
  return out;
}

/** Название организации после метки («Поставщик:», «От:»), с учётом вложенных кавычек. */
export function readOrg(text, from, to, label) {
  const re = new RegExp(String.raw`(?:^|[\s.;])${label}\s*:\s*`, 'u');
  const slice = text.slice(from, to);
  const m = re.exec(slice);
  if (!m) return null;
  const start = from + m.index + m[0].length;
  let depth = 0;
  let j = start;
  for (; j < to; j++) {
    const ch = text[j];
    if (ch === '\n') break;
    if (ch === '«') depth++;
    else if (ch === '»') {
      depth--;
      if (depth <= 0) { j++; break; }
    } else if (depth === 0 && '.;,'.includes(ch) && /\s/u.test(text[j + 1] ?? ' ')) break;
  }
  const name = text.slice(start, j).trim();
  return name ? { name, start, end: j } : null;
}

export function normOrg(name) {
  return (name || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'„“”\s]/gu, '');
}

export function normNumber(num) {
  return (num || '').toUpperCase().replace(/[‐-―−]/g, '-').replace(/\s+/g, '');
}
