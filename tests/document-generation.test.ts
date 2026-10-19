import { test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import * as XLSX from '@e965/xlsx';
import { documentFieldsSchema, documentPartySchema } from '../shared/document-generation.js';
import { documentLines, moneyWords, numberWords } from '../server/document-data.js';
import { generateDocument, type DocumentContext } from '../server/document-engine.js';
import { imageSize, nodes, readPart } from '../server/office-xml.js';

const fields = documentFieldsSchema.parse({
  contract_number: 'TEST-42',
  contract_date: '2026-10-19',
  document_number: 'INV-42',
  document_date: '2026-10-20',
  city: 'Москва',
  delivery_address: 'Тестовый адрес, 42',
  production_terms: 'До 31 декабря 2026 года',
  delivery_terms: 'Доставка и сборка включены',
  advance_amount: 100,
  package_count: 3,
});
const item = (id: string, price: number, quantity: number) => ({
  id,
  kind: 'Кровать',
  model: 'Луна & Облако <тест>',
  quantity,
  price,
  dimensions: '180 × 200 см',
  fabric: 'Велюр',
  color: 'Бежевый',
  filling: 'ППУ',
  mechanism: 'Подъёмный',
  notes: 'INTERNAL_COST_DO_NOT_EXPORT',
  planned_cost: 987654,
});
const party = documentPartySchema.parse({
  name: 'Тестовый заказчик & «Комфорт»',
  inn: '0000000000',
  address: 'Москва, Тестовая улица, 42',
  representative: 'Петрова Анна Сергеевна',
});
const context = (): DocumentContext => ({
  order: { number: 'LM-TEST', title: 'Тестовый комплект', discount: 1, total: 299 },
  items: [item('one', 100, 3)],
  buyer: party,
  seller: documentPartySchema.parse({
    name: 'ИП Тестов Иван Иванович',
    phone: '+7 (000) 123-45-67',
    email: 'test@example.test',
  }),
  fields: { ...fields },
  item_images: {},
  item_descriptions: {},
  images: new Map(),
});
const textInOffice = (bytes: Buffer) => {
  const zip = new PizZip(bytes);
  return Object.entries(zip.files)
    .filter(([name]) => name.endsWith('.xml'))
    .map(([, f]) => f.asText())
    .join('\n');
};
const workbook = (bytes: Buffer) => {
  const w = XLSX.read(bytes, { cellNF: true });
  return w.Sheets[w.SheetNames[0]];
};

test('Документы: русские числительные и деньги прописью без потери копеек', () => {
  assert.equal(numberWords(0), 'ноль');
  assert.equal(numberWords(21002), 'двадцать одна тысяча два');
  assert.equal(numberWords(2000002), 'два миллиона два');
  assert.equal(moneyWords(101), 'один рубль 01 копейка');
  assert.equal(moneyWords(224), 'два рубля 24 копейки');
  assert.equal(moneyWords(1111), 'одиннадцать рублей 11 копеек');
  assert.equal(moneyWords(9e12), 'девяносто миллиардов рублей 00 копеек');
  assert.throws(() => moneyWords(-1));
});

test('Документы: скидка, количество и НДС сходятся до копейки на граничных суммах', () => {
  for (const items of [
    [item('a', 100, 3)],
    [item('a', 1, 999), item('b', 17, 7)],
    [item('a', 0, 1), item('b', 99999999, 1000)],
  ]) {
    const subtotal = items.reduce((s, i) => s + i.quantity * i.price, 0);
    for (const discount of [0, 1, Math.floor(subtotal / 3), subtotal]) {
      for (const rate of [0, 500, 2000, 10000]) {
        const lines = documentLines(items, discount, {
          ...fields,
          vat_mode: 'included',
          vat_rate_bps: rate,
        });
        assert.equal(
          lines.reduce((s, l) => s + l.total, 0),
          subtotal - discount,
        );
        assert.equal(
          lines.reduce((s, l) => s + l.quantity, 0),
          items.reduce((s, i) => s + i.quantity, 0),
        );
        for (const l of lines) {
          assert.equal(l.quantity * l.price, l.total);
          assert.equal(l.net + l.vat, l.total);
          assert.ok(Number.isSafeInteger(l.price));
        }
      }
    }
  }
  const half = documentLines([item('a', 3, 1)], 0, {
    ...fields,
    vat_mode: 'included',
    vat_rate_bps: 2000,
  });
  assert.equal(half[0].net, 3);
  assert.equal(half[0].vat, 0);
  assert.throws(() => documentLines([item('a', 1, 1)], 2, fields));
});

test('Встроенные Word/Excel шаблоны заполняются без служебных меток и внутренних заметок', async () => {
  for (const kind of ['contract', 'appendix', 'proposal', 'invoice'] as const) {
    const result = await generateDocument(kind, context());
    const xml = textInOffice(result.data);
    assert.doesNotMatch(xml, /\{[#/]?[a-z_]+\}|LOOMAIMAGE_|INTERNAL_COST_DO_NOT_EXPORT/);
    assert.match(xml, /Тестовый заказчик/);
    assert.match(result.name, kind === 'contract' || kind === 'appendix' ? /\.docx$/ : /\.xlsx$/);
    if (kind === 'appendix') {
      const doc = readPart(new PizZip(result.data), 'word/document.xml');
      assert.equal(
        nodes(doc, 'tr', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main').filter(
          (r) => r.textContent?.includes('Луна'),
        ).length,
        2,
      );
    }
  }
});

test('Excel: числовые суммы, формулы, даты и отдельный плательщик сохраняются', async () => {
  const c = context();
  c.fields.vat_mode = 'included';
  c.fields.vat_rate_bps = 2000;
  c.fields.recipient = 'Другой грузополучатель';
  const proposal = workbook((await generateDocument('proposal', c)).data);
  assert.equal(proposal.D12.t, 'n');
  assert.equal(proposal.E12.t, 'n');
  assert.equal(proposal.F12.f, 'ROUND(D12*E12,2)');
  assert.equal(proposal.F14.v, 2.99);
  assert.equal(proposal.F14.f, 'SUM(F12:F13)');
  const invoice = workbook((await generateDocument('invoice', c)).data);
  assert.equal(invoice.AN27.v, 2.99);
  assert.equal(invoice.AN27.f, 'SUM(AN25:AN26)');
  assert.equal(Math.round((invoice.AE27.v + invoice.AK27.v) * 100), 299);
  assert.equal(invoice.O19.t, 'n');
  assert.equal(invoice.O19.z, 'dd.mm.yyyy');
  assert.match(invoice.D8.v, /Другой грузополучатель/);
  assert.match(invoice.D14.v, /Тестовый заказчик/);
  assert.equal(invoice.D14.f, undefined);
  assert.equal(invoice.M25.v, '796');
  const z = new PizZip((await generateDocument('invoice', c)).data);
  assert.match(z.file('xl/workbook.xml')!.asText(), /_xlnm.Print_Area/);
  assert.equal(z.file('xl/calcChain.xml'), null);
});

test('Word и Excel: текст экранируется, выбранное фото встраивается один раз, снятый выбор убирает фото', async () => {
  const c = context();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=',
    'base64',
  );
  c.images.set('photo', {
    id: 'photo',
    data: png,
    mime: 'image/png',
    ...imageSize(png, 'image/png'),
  });
  c.items[0].photo_document_id = 'photo';
  c.item_images.one = 'photo';
  c.item_descriptions.one = '=HYPERLINK("https://example.invalid") & <тест>';
  for (const kind of ['appendix', 'proposal'] as const) {
    const r = await generateDocument(kind, c),
      z = new PizZip(r.data);
    assert.ok(Object.keys(z.files).some((n) => n.includes('/media/looma-')));
    assert.equal(Object.keys(z.files).filter((n) => n.includes('/media/looma-')).length, 1);
    if (kind === 'proposal') {
      const s = workbook(r.data);
      assert.equal(s.C12.t, 's');
      assert.equal(s.C12.f, undefined);
      assert.equal(s.C12.v, c.item_descriptions.one);
    }
    c.item_images = {};
    const without = new PizZip((await generateDocument(kind, c)).data);
    assert.equal(
      Object.keys(without.files).some((n) => n.includes('/media/looma-')),
      false,
    );
    c.item_images.one = 'photo';
  }
});
