import type { DocumentFields, DocumentParty } from '../shared/document-generation.js';
import { AppError } from './db.js';

export const months = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
export function longDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${months[m - 1]} ${y} года`;
}
export function shortDate(iso: string) {
  return iso.split('-').reverse().join('.');
}
export function formatMoney(cents: number) {
  return (cents / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
export function plural(n: number, forms: [string, string, string]) {
  const last = n % 100;
  return forms[
    last >= 11 && last <= 19 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2
  ];
}
export function numberWords(n: number, feminine = false): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > 999_999_999_999)
    throw new AppError(400, 'Число слишком большое для документа');
  if (!n) return 'ноль';
  const ones = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const teens = [
    'десять',
    'одиннадцать',
    'двенадцать',
    'тринадцать',
    'четырнадцать',
    'пятнадцать',
    'шестнадцать',
    'семнадцать',
    'восемнадцать',
    'девятнадцать',
  ];
  const tens = [
    '',
    '',
    'двадцать',
    'тридцать',
    'сорок',
    'пятьдесят',
    'шестьдесят',
    'семьдесят',
    'восемьдесят',
    'девяносто',
  ];
  const hundreds = [
    '',
    'сто',
    'двести',
    'триста',
    'четыреста',
    'пятьсот',
    'шестьсот',
    'семьсот',
    'восемьсот',
    'девятьсот',
  ];
  const units: [string, string, string][] = [
    ['', '', ''],
    ['тысяча', 'тысячи', 'тысяч'],
    ['миллион', 'миллиона', 'миллионов'],
    ['миллиард', 'миллиарда', 'миллиардов'],
  ];
  const parts: string[] = [];
  for (let group = 0; n > 0; group++, n = Math.floor(n / 1000)) {
    const value = n % 1000;
    if (!value) continue;
    const words = [hundreds[Math.floor(value / 100)]];
    const rest = value % 100;
    if (rest >= 10 && rest < 20) words.push(teens[rest - 10]);
    else {
      words.push(tens[Math.floor(rest / 10)]);
      const u = rest % 10,
        female = group === 1 || (group === 0 && feminine);
      words.push(female && u === 1 ? 'одна' : female && u === 2 ? 'две' : ones[u]);
    }
    if (group) words.push(plural(value, units[group]));
    parts.unshift(words.filter(Boolean).join(' '));
  }
  return parts.join(' ');
}
export function moneyWords(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 9e12)
    throw new AppError(400, 'Проверьте сумму документа');
  const rub = Math.floor(cents / 100),
    kop = cents % 100;
  return `${numberWords(rub)} ${plural(rub, ['рубль', 'рубля', 'рублей'])} ${String(kop).padStart(2, '0')} ${plural(kop, ['копейка', 'копейки', 'копеек'])}`;
}
export function itemDescription(item: any) {
  const title = item.model.toLowerCase().startsWith(item.kind.toLowerCase())
    ? item.model
    : `${item.kind} ${item.model}`;
  return [
    title,
    ...[
      ['Размеры', item.dimensions],
      ['Обивка', item.fabric],
      ['Цвет', item.color],
      ['Наполнитель', item.filling],
      ['Механизм', item.mechanism],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`),
  ].join('. ');
}
export type DocumentLine = {
  source_id: string;
  index: number;
  description: string;
  quantity: number;
  price: number;
  total: number;
  net: number;
  vat: number;
  photo_document_id: string | null;
};
// Allocate every kopeck, then split a position only when a two-decimal unit price
// cannot represent its discounted amount. Quantity × price and all totals reconcile.
export function documentLines(
  items: any[],
  discount: number,
  fields: DocumentFields,
  descriptions: Record<string, string> = {},
  images: Record<string, string> = {},
): DocumentLine[] {
  const gross = items.map((i) => BigInt(i.price) * BigInt(i.quantity)),
    subtotal = gross.reduce((a, b) => a + b, 0n);
  if (discount < 0 || BigInt(discount) > subtotal)
    throw new AppError(400, 'Проверьте скидку заказа');
  const discounts = gross.map((g) => (subtotal ? (BigInt(discount) * g) / subtotal : 0n));
  let remaining = BigInt(discount) - discounts.reduce((a, b) => a + b, 0n);
  const remainders = gross
    .map((g, i) => ({ i, r: subtotal ? (BigInt(discount) * g) % subtotal : 0n }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (!remaining) break;
    discounts[i]++;
    remaining--;
  }
  const result: DocumentLine[] = [];
  items.forEach((item, i) => {
    const amount = gross[i] - discounts[i],
      quantity = BigInt(item.quantity);
    const base = amount / quantity,
      extra = Number(amount % quantity);
    const groups = [
      [item.quantity - extra, Number(base)],
      [extra, Number(base) + 1],
    ];
    for (const [q, price] of groups) {
      if (!q) continue;
      const total = q * price,
        rate = BigInt(fields.vat_rate_bps);
      const net =
        fields.vat_mode === 'included'
          ? Number((BigInt(total) * 10000n + (10000n + rate) / 2n) / (10000n + rate))
          : total;
      result.push({
        source_id: item.id,
        index: result.length + 1,
        description: descriptions[item.id] || itemDescription(item),
        quantity: q,
        price,
        total,
        net,
        vat: total - net,
        photo_document_id: images[item.id] || null,
      });
    }
  });
  return result;
}
export function partyText(p: DocumentParty) {
  return [
    p.name,
    p.address,
    p.inn && `ИНН ${p.inn}${p.kpp ? ', КПП ' + p.kpp : ''}`,
    p.ogrn && `${p.ogrn.replace(/\D/g, '').length === 15 ? 'ОГРНИП' : 'ОГРН'} ${p.ogrn}`,
    p.passport,
    p.account && `Р/с ${p.account}`,
    p.bank,
    p.bik && `БИК ${p.bik}`,
    p.corr_account && `К/с ${p.corr_account}`,
    p.phone && `Тел. ${p.phone}`,
    p.email,
    p.details,
  ]
    .filter(Boolean)
    .join('\n');
}
export function partyIntro(p: DocumentParty) {
  const representative = [p.position, p.representative].filter(Boolean).join(' ');
  return (
    p.name +
    (representative
      ? ` (представитель: ${representative}${p.basis ? '; основание полномочий: ' + p.basis : ''})`
      : p.ogrn
        ? ` (ОГРН/ОГРНИП ${p.ogrn})`
        : '')
  );
}
export function signature(p: DocumentParty) {
  if (p.signature) return p.signature;
  const name = p.representative || p.name.replace(/^ИП\s+|^Индивидуальный предприниматель\s+/i, '');
  const parts = name.trim().split(/\s+/);
  return parts.length === 3 ? `${parts[1][0]}.${parts[2][0]}. ${parts[0]}` : name;
}
export function templateValues(
  order: any,
  buyer: DocumentParty,
  seller: DocumentParty,
  fields: DocumentFields,
  lines: DocumentLine[],
) {
  const total = lines.reduce((s, i) => s + i.total, 0);
  if (total !== order.total)
    throw new AppError(409, 'Стоимость заказа изменилась. Откройте форму заново');
  if (fields.advance_amount > total)
    throw new AppError(400, 'Аванс не может превышать стоимость заказа');
  const values: Record<string, any> = {
    contract_number: fields.contract_number,
    contract_date: longDate(fields.contract_date),
    document_number: fields.document_number,
    document_date: shortDate(fields.document_date),
    city: fields.city || '________________',
    delivery_address: fields.delivery_address || '________________',
    production_terms: fields.production_terms || '________________',
    delivery_terms: fields.delivery_terms || '________________',
    total: formatMoney(total),
    total_words: moneyWords(total),
    total_words_capitalized: moneyWords(total).replace(/^./, (s) => s.toUpperCase()),
    advance: formatMoney(fields.advance_amount),
    advance_words: moneyWords(fields.advance_amount),
    advance_days: fields.advance_days,
    final: formatMoney(total - fields.advance_amount),
    final_words: moneyWords(total - fields.advance_amount),
    final_days: fields.final_days,
    quantity: lines.reduce((s, i) => s + i.quantity, 0),
    row_count: lines.length,
    row_count_words: numberWords(lines.length),
    package_count: fields.package_count === null ? '' : fields.package_count,
    package_count_words: fields.package_count === null ? '' : numberWords(fields.package_count),
    seller_intro: partyIntro(seller),
    buyer_intro: partyIntro(buyer),
    seller_name: seller.name,
    buyer_name: buyer.name,
    seller_text: partyText(seller),
    buyer_text: partyText(buyer),
    recipient_text: fields.recipient || partyText(buyer),
    seller_signature: signature(seller),
    buyer_signature: signature(buyer),
    seller_position: seller.position,
    buyer_position: buyer.position,
    recipient_position: fields.recipient_position || buyer.position,
    recipient_signature: fields.recipient_signature || signature(buyer),
    power_of_attorney: fields.power_of_attorney,
    power_of_attorney_date: fields.power_of_attorney_date
      ? shortDate(fields.power_of_attorney_date)
      : '',
    power_of_attorney_issued: fields.power_of_attorney_issued,
    order_number: order.number,
    order_title: order.title,
    vat_label:
      fields.vat_mode === 'without'
        ? 'Без НДС'
        : (fields.vat_rate_bps / 100).toLocaleString('ru-RU') + '%',
    date_day: String(Number(fields.document_date.slice(8))),
    date_month: months[Number(fields.document_date.slice(5, 7)) - 1],
    date_year: fields.document_date.slice(0, 4) + ' года',
    seller_phone: seller.phone,
    seller_contact: [seller.phone, seller.email].filter(Boolean).join(' · '),
    seller_contact_name: seller.representative || seller.name,
    seller_okpo: seller.okpo,
    buyer_okpo: buyer.okpo,
  };
  for (const [prefix, party] of [
    ['seller', seller],
    ['buyer', buyer],
  ] as const)
    for (const [k, v] of Object.entries(party)) values[`${prefix}_${k}`] = v || '';
  values.seller_signature = signature(seller);
  values.buyer_signature = signature(buyer);
  values.has_advance = fields.advance_amount > 0;
  values.has_final = total > fields.advance_amount;
  values.items = lines.map((l) => ({
    index: l.index,
    description: l.description,
    quantity: l.quantity,
    unit_price: formatMoney(l.price),
    line_total: formatMoney(l.total),
    image_tag: l.photo_document_id ? `LOOMAIMAGE_${l.index}` : '',
  }));
  return values;
}
