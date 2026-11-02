import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/engine.js';
import { answerQuestion, EXAMPLE_QUESTIONS } from '../src/questions.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Documents');
const sample = () => fs.readdirSync(DIR).sort().map((name) => ({ name, text: fs.readFileSync(path.join(DIR, name), 'utf8') }));
const ASOF = '2026-03-10';
const byNum = (a, n) => a.contracts.find((c) => c.number === n);

// Источник обязан быть точной подстрокой файла — это главное требование к проверяемости.
function assertQuoteIsExact(files, source) {
  const f = files.find((x) => x.name === source.fileName);
  assert.ok(f, `файл ${source.fileName} не найден`);
  assert.ok(f.text.replace(/\r\n?/g, '\n').includes(source.quote), `цитата не найдена в ${source.fileName}: ${source.quote}`);
}

const contract = ({ num = 'STN-200', supplier = 'ООО «Тест»', amount = '500 000 (пятьсот тысяч) рублей', date = '01.05.2026', status = 'подписан обеими сторонами 01.02.2026.' } = {}) => `ДОГОВОР ПОСТАВКИ № ${num}
Дата: 01.02.2026
Статус: ${status}

1.1. Покупатель: ООО «СеверМет». Поставщик: ${supplier}.

2.1. Общая стоимость поставки составляет ${amount}, включая НДС.

3.1. Поставщик обязуется поставить товар не позднее ${date}.
`;

const amendment = ({ num = 'STN-200', no = 1, status = 'подписано обеими сторонами 01.03.2026.', effective = '01.03.2026', body = '1. Пункт 3.1 договора изложить в следующей редакции: «Поставщик обязуется поставить товар не позднее 15.06.2026».' } = {}) => `ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № ${no} К ДОГОВОРУ ${num}
Дата: 01.03.2026
Статус: ${status}

${body}

2. Настоящее соглашение вступает в силу ${effective}.
`;

// ---------- исходный набор ----------

test('исходный набор: таблица по трём договорам', () => {
  const files = sample();
  const a = analyze(files, { asOf: ASOF });
  assert.deepEqual(a.contracts.map((c) => c.number), ['STN-101', 'STN-102', 'STN-103']);

  const c1 = byNum(a, 'STN-101');
  assert.equal(c1.supplier.name, 'ООО «Вектор Прибор»');
  assert.equal(c1.fields.amount.value, 1380000);
  assert.equal(c1.fields.delivery.value, '2026-04-30');
  assert.equal(c1.fields.delivery.changedBy.fileName, '02_amendment_signed.txt');
  assert.equal(c1.fields.amount.changedBy.fileName, '02_amendment_signed.txt');
  assert.deepEqual(c1.fields.delivery.history.map((h) => h.value), ['2026-04-15', '2026-04-30']);

  const c2 = byNum(a, 'STN-102');
  assert.equal(c2.supplier.name, 'ООО «Контур Электро»');
  assert.equal(c2.fields.amount.value, 840000, 'аванс 252 000 не должен стать суммой договора');
  assert.equal(c2.fields.delivery.value, '2026-03-20', '10.04.2026 — срок оплаты, а не поставки');

  const c3 = byNum(a, 'STN-103');
  assert.equal(c3.fields.amount.status, 'missing');
  assert.equal(c3.fields.amount.value, null, 'лимит 600 000 не должен стать суммой договора');
  assert.equal(c3.fields.amount.display, 'нет данных');
  assert.ok(c3.fields.amount.excluded.some((e) => e.value === 600000));
  assert.equal(c3.fields.delivery.value, '2026-04-30');

  for (const c of a.contracts) for (const f of Object.values(c.fields)) if (f.source) assertQuoteIsExact(files, f.source);
});

test('исходный набор: письмо и проект не меняют условия, но видны как предложения', () => {
  const files = sample();
  const a = analyze(files, { asOf: ASOF });
  const c1 = byNum(a, 'STN-101');
  const draft = c1.proposals.filter((p) => p.fileName === '06_amendment_draft.txt');
  assert.deepEqual(draft.map((p) => [p.field, p.value, p.kind]).sort(), [['amount', 1450000, 'draft'], ['delivery', '2026-05-10', 'draft']]);

  const c2 = byNum(a, 'STN-102');
  assert.equal(c2.proposals.length, 1);
  assert.equal(c2.proposals[0].kind, 'letter');
  assert.equal(c2.proposals[0].value, '2026-03-27');
  for (const p of [...c1.proposals, ...c2.proposals]) assertQuoteIsExact(files, p.source);

  const roles = Object.fromEntries(a.documents.map((d) => [d.name, d.role.code]));
  assert.equal(roles['02_amendment_signed.txt'], 'applied');
  assert.equal(roles['05_supplier_email.txt'], 'letter');
  assert.equal(roles['06_amendment_draft.txt'], 'draft');
});

test('результат не зависит от имён файлов и порядка загрузки', () => {
  const files = sample();
  const renamed = files.reverse().map((f, i) => ({ name: `zz_${9 - i}.txt`, text: f.text }));
  const a = analyze(renamed, { asOf: ASOF });
  assert.equal(byNum(a, 'STN-101').fields.delivery.value, '2026-04-30');
  assert.equal(byNum(a, 'STN-102').fields.amount.value, 840000);
  assert.equal(byNum(a, 'STN-103').fields.amount.value, null);
});

test('дата проверки до вступления ДС в силу — действует исходный срок, ДС показано как ещё не действующее', () => {
  const a = analyze(sample(), { asOf: '2026-02-25' });
  const c1 = byNum(a, 'STN-101');
  assert.equal(c1.fields.delivery.value, '2026-04-15');
  assert.equal(c1.fields.amount.value, 1200000);
  assert.ok(c1.proposals.some((p) => p.kind === 'pending' && p.value === '2026-04-30'));
});

test('CRLF и windows-переводы строк не ломают разбор', () => {
  const files = sample().map((f) => ({ ...f, text: f.text.replace(/\n/g, '\r\n') }));
  const a = analyze(files, { asOf: ASOF });
  assert.equal(byNum(a, 'STN-101').fields.delivery.value, '2026-04-30');
});

// ---------- вопросы пользователя ----------

test('четыре вопроса пользователя', () => {
  const files = sample();
  const [q1, q2, q3, q4] = EXAMPLE_QUESTIONS.map((q) => answerQuestion(q, files, { asOf: ASOF }));
  assert.ok(q1.ok && q1.summary.includes('30.04.2026'), q1.summary);
  assert.equal(q1.asOf, '2026-03-10');
  assert.ok(q2.summary.includes('840 000'), q2.summary);
  assert.ok(q3.summary.includes('нет данных'), q3.summary);
  assert.ok(!q3.summary.includes('600 000'), 'лимит не выдаётся за сумму');
  assert.ok(q4.summary.includes('STN-102') && !q4.summary.includes('STN-101 ('), q4.summary);
  assert.ok(q4.summary.includes('Несогласованные изменения срока есть по: STN-102'), q4.summary);
  const props = q4.blocks[0].lines.filter((l) => l.kind === 'proposal');
  assert.equal(props.length, 1);
  assert.equal(props[0].value, '27.03.2026');
});

test('вопрос с датой «на …» пересчитывает условия на эту дату', () => {
  const r = answerQuestion('Какой срок поставки по STN-101 на 20 февраля 2026?', sample(), { asOf: ASOF });
  assert.ok(r.summary.includes('15.04.2026'), r.summary);
});

test('вопрос о неизвестном договоре — честный отказ', () => {
  const r = answerQuestion('Какова сумма договора STN-999?', sample(), { asOf: ASOF });
  assert.equal(r.ok, false);
  assert.match(r.message, /не найден/);
});

// ---------- новые документы того же формата ----------

test('новый договор того же формата обрабатывается без настроек', () => {
  const files = [...sample(), { name: 'new.txt', text: contract({ num: 'STN-104', supplier: 'ООО «Новый Поставщик»', amount: '2 345 678,50 (два миллиона триста сорок пять тысяч шестьсот семьдесят восемь) рублей', date: '«25» марта 2026 г' }) }];
  const a = analyze(files, { asOf: ASOF });
  const c = byNum(a, 'STN-104');
  assert.equal(c.supplier.name, 'ООО «Новый Поставщик»');
  assert.equal(c.fields.amount.value, 2345678.5);
  assert.equal(c.fields.amount.status, 'ok');
  assert.equal(c.fields.delivery.value, '2026-03-25');
  const q4 = answerQuestion(EXAMPLE_QUESTIONS[3], files, { asOf: ASOF });
  assert.ok(q4.summary.includes('STN-104'), q4.summary);
});

test('изменённое поле в загруженном договоре сразу отражается в результате', () => {
  const files = sample().map((f) => f.name === '03_contract.txt' ? { ...f, text: f.text.replace('20.03.2026', '05.04.2026') } : f);
  const a = analyze(files, { asOf: ASOF });
  assert.equal(byNum(a, 'STN-102').fields.delivery.value, '2026-04-05');
  const q4 = answerQuestion(EXAMPLE_QUESTIONS[3], files, { asOf: ASOF });
  assert.ok(q4.summary.startsWith('Договоров с поставкой раньше'), q4.summary);
});

test('расхождение суммы цифрами и прописью — требует проверки', () => {
  const a = analyze([{ name: 'c.txt', text: contract({ amount: '510 000 (пятьсот тысяч) рублей' }) }], { asOf: ASOF });
  const f = a.contracts[0].fields.amount;
  assert.equal(f.status, 'review');
  assert.equal(f.value, 510000);
});

// ---------- статус документа ----------

test('неподписанное допсоглашение не применяется', () => {
  const a = analyze([
    { name: 'c.txt', text: contract() },
    { name: 'a.txt', text: amendment({ status: 'не подписано.' }) },
  ], { asOf: ASOF });
  const c = a.contracts[0];
  assert.equal(c.fields.delivery.value, '2026-05-01');
  assert.equal(c.proposals[0].kind, 'draft');
});

test('подписанное, но вступающее в силу позже даты проверки — не применяется', () => {
  const a = analyze([
    { name: 'c.txt', text: contract() },
    { name: 'a.txt', text: amendment({ effective: '01.04.2026' }) },
  ], { asOf: ASOF });
  const c = a.contracts[0];
  assert.equal(c.fields.delivery.value, '2026-05-01');
  assert.equal(c.proposals[0].kind, 'pending');
});

test('подписанное без даты вступления в силу — требует проверки, не применяется', () => {
  const text = amendment().replace(/2\. Настоящее соглашение.*\n/u, '');
  const a = analyze([{ name: 'c.txt', text: contract() }, { name: 'a.txt', text }], { asOf: ASOF });
  const c = a.contracts[0];
  assert.equal(c.fields.delivery.value, '2026-05-01');
  assert.ok(c.needsReview);
  assert.ok(c.flags.some((f) => /дата вступления в силу/.test(f.text)));
});

test('подписанное одной стороной — требует проверки', () => {
  const a = analyze([
    { name: 'c.txt', text: contract() },
    { name: 'a.txt', text: amendment({ status: 'подписано поставщиком 01.03.2026.' }) },
  ], { asOf: ASOF });
  const c = a.contracts[0];
  assert.equal(c.fields.delivery.value, '2026-05-01');
  assert.ok(c.needsReview);
});

test('два ДС применяются по дате вступления в силу, а не по имени файла', () => {
  const a = analyze([
    { name: 'c.txt', text: contract() },
    { name: 'a_first_by_name.txt', text: amendment({ no: 2, effective: '05.03.2026', body: '1. Пункт 3.1 договора изложить в следующей редакции: «Поставщик обязуется поставить товар не позднее 20.06.2026».' }) },
    { name: 'b_second_by_name.txt', text: amendment({ no: 1, effective: '02.03.2026' }) },
  ], { asOf: ASOF });
  const f = a.contracts[0].fields.delivery;
  assert.equal(f.value, '2026-06-20');
  assert.deepEqual(f.history.map((h) => h.value), ['2026-05-01', '2026-06-15', '2026-06-20']);
});

test('ДС без формулы «изложить в редакции» тоже применяется', () => {
  const a = analyze([
    { name: 'c.txt', text: contract() },
    { name: 'a.txt', text: amendment({ body: '1. Стороны договорились изменить срок поставки на 10.06.2026.' }) },
  ], { asOf: ASOF });
  assert.equal(a.contracts[0].fields.delivery.value, '2026-06-10');
});

test('договор без срока и суммы — «нет данных», ничего не выдумываем', () => {
  const text = `ДОГОВОР ПОСТАВКИ № X-1
Статус: подписан обеими сторонами 01.02.2026.
1.1. Поставщик: ООО «Пусто».
2.1. Оплата производится не позднее 01.04.2026.
2.2. Аванс 100 000 рублей.
`;
  const a = analyze([{ name: 'x.txt', text }], { asOf: ASOF });
  const c = a.contracts[0];
  assert.equal(c.fields.amount.display, 'нет данных');
  assert.equal(c.fields.delivery.display, 'нет данных');
  assert.deepEqual(c.missing, ['amount', 'delivery']);
});

test('документ со ссылкой на незагруженный договор не привязывается молча', () => {
  const a = analyze([
    { name: 'c.txt', text: contract() },
    { name: 'a.txt', text: amendment({ num: 'STN-777' }) },
  ], { asOf: ASOF });
  assert.equal(a.unlinked.length, 1);
  assert.match(a.unlinked[0].linkProblem, /STN-777/);
  assert.equal(a.contracts[0].fields.delivery.value, '2026-05-01');
});

test('общая фраза о «дате вступления в силу» в договоре не считается датой вступления', () => {
  const a = analyze(sample(), { asOf: ASOF });
  for (const d of a.documents.filter((x) => x.type === 'contract')) assert.equal(d.effective, null);
  assert.equal(a.documents.find((d) => d.name === '02_amendment_signed.txt').effective.date, '2026-03-01');
});

test('ДС «вступает в силу с даты подписания» применяется с даты подписания', () => {
  const text = amendment().replace('вступает в силу 01.03.2026', 'вступает в силу с даты его подписания');
  const a = analyze([{ name: 'c.txt', text: contract() }, { name: 'a.txt', text }], { asOf: ASOF });
  assert.equal(a.contracts[0].fields.delivery.value, '2026-06-15');
});

test('два договора с одним номером — требует проверки', () => {
  const a = analyze([
    { name: 'c1.txt', text: contract() },
    { name: 'c2.txt', text: contract({ date: '02.05.2026' }) },
  ], { asOf: ASOF });
  assert.ok(a.contracts.every((c) => c.needsReview));
});

test('неподписанный договор — требует проверки', () => {
  const a = analyze([{ name: 'c.txt', text: contract({ status: 'проект, не подписан.' }) }], { asOf: ASOF });
  assert.ok(a.contracts[0].needsReview);
});
