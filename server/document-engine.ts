import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import type {
  DocumentFields,
  DocumentParty,
  GeneratedDocumentKind,
} from '../shared/document-generation.js';
import { documentLines, templateValues } from './document-data.js';
import { AppError } from './db.js';
import {
  embedExcelImages,
  embedWordImages,
  expandRows,
  nodes,
  printSetup,
  readPart,
  replaceTokens,
  savePart,
  setCell,
  type OfficeImage,
} from './office-xml.js';

export type DocumentContext = {
  order: any;
  items: any[];
  buyer: DocumentParty;
  seller: DocumentParty;
  fields: DocumentFields;
  item_images: Record<string, string>;
  item_descriptions: Record<string, string>;
  images: Map<string, OfficeImage>;
};
export async function generateDocument(kind: GeneratedDocumentKind, context: DocumentContext) {
  const { order, items, buyer, seller, fields, images } = context;
  const lines = documentLines(
    items,
    order.discount,
    fields,
    context.item_descriptions,
    context.item_images,
  );
  const values = templateValues(order, buyer, seller, fields, lines);
  const extension = kind === 'contract' || kind === 'appendix' ? 'docx' : 'xlsx';
  const template = await readFile(resolve('templates/documents', kind + '.' + extension));
  let zip: PizZip;
  if (extension === 'docx') {
    const doc = new Docxtemplater(new PizZip(template), {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
    });
    doc.render(values);
    zip = doc.getZip();
    if (kind === 'appendix') embedWordImages(zip, images, lines);
  } else {
    zip = new PizZip(template);
    const worksheet = readPart(zip, 'xl/worksheets/sheet1.xml');
    const height = (rowNumber: number, points: number) => {
      if (points > 409.5)
        throw new AppError(
          400,
          'Текст слишком длинный для строки Excel. Сократите описание изделия или реквизиты в форме создания документов',
        );
      const row = nodes(worksheet, 'row').find((n) => Number(n.getAttribute('r')) === rowNumber)!;
      row.setAttribute('ht', String(points));
      row.setAttribute('customHeight', '1');
    };
    const start = kind === 'proposal' ? 12 : 25,
      delta = lines.length - 1;
    expandRows(worksheet, start, lines.length);
    if (zip.file('xl/sharedStrings.xml')) {
      const strings = readPart(zip, 'xl/sharedStrings.xml');
      replaceTokens(strings, values);
      savePart(zip, 'xl/sharedStrings.xml', strings);
    }
    replaceTokens(worksheet, values);
    const gross = lines.reduce((s, l) => s + l.total, 0),
      net = lines.reduce((s, l) => s + l.net, 0),
      vat = lines.reduce((s, l) => s + l.vat, 0),
      qty = lines.reduce((s, l) => s + l.quantity, 0);
    const last = start + lines.length - 1,
      total = last + 1;
    for (const [i, line] of lines.entries()) {
      const r = start + i;
      if (kind === 'proposal') {
        setCell(worksheet, 'A' + r, line.index);
        setCell(worksheet, 'B' + r, '');
        setCell(worksheet, 'C' + r, line.description);
        setCell(worksheet, 'D' + r, line.quantity);
        setCell(worksheet, 'E' + r, line.price / 100);
        setCell(worksheet, 'F' + r, line.total / 100, `ROUND(D${r}*E${r},2)`);
        const rowHeight = Math.max(
          line.photo_document_id ? 112 : 60,
          Math.ceil(line.description.length / 42) * 12 + 16,
        );
        height(r, rowHeight);
      } else {
        setCell(worksheet, 'B' + r, line.index);
        setCell(worksheet, 'C' + r, line.description);
        setCell(worksheet, 'H' + r, '');
        setCell(worksheet, 'I' + r, 'шт');
        setCell(worksheet, 'M' + r, '796');
        setCell(worksheet, 'Y' + r, line.quantity);
        setCell(worksheet, 'Z' + r, line.price / 100);
        setCell(worksheet, 'AN' + r, line.total / 100, `ROUND(Y${r}*Z${r},2)`);
        const divisor = 1 + fields.vat_rate_bps / 10000;
        setCell(
          worksheet,
          'AE' + r,
          line.net / 100,
          fields.vat_mode === 'without' ? `AN${r}` : `ROUND(AN${r}/${divisor},2)`,
        );
        // VAT is the remainder so the two amounts always add back to the gross.
        setCell(worksheet, 'AK' + r, line.vat / 100, `AN${r}-AE${r}`);
        setCell(worksheet, 'AI' + r, values.vat_label);
        height(r, Math.max(36, Math.ceil(line.description.length / 40) * 11 + 8));
      }
    }
    if (kind === 'proposal') {
      height(
        10,
        Math.max(
          32,
          Math.ceil((buyer.name.length + fields.document_number.length + 35) / 100) * 15 + 10,
        ),
      );
      height(14 + delta, Math.max(40, Math.ceil(fields.delivery_terms.length / 125) * 15 + 12));
      setCell(worksheet, 'D' + total, qty, `SUM(D${start}:D${last})`);
      setCell(worksheet, 'F' + total, gross / 100, `SUM(F${start}:F${last})`);
      embedExcelImages(zip, worksheet, images, lines);
      printSetup(zip, worksheet, 'proposal', 18 + delta);
    } else {
      setCell(worksheet, 'Y' + total, qty, `SUM(Y${start}:Y${last})`);
      for (const [col, amount] of [
        ['AE', net],
        ['AK', vat],
        ['AN', gross],
      ] as const)
        setCell(worksheet, col + total, amount / 100, `SUM(${col}${start}:${col}${last})`);
      const compact = (text: string) => text.replace(/\n/g, ', ');
      setCell(worksheet, 'B3', compact(values.seller_text));
      setCell(worksheet, 'D8', compact(values.recipient_text));
      setCell(worksheet, 'D12', compact(values.seller_text), 'B3');
      setCell(worksheet, 'D14', compact(values.buyer_text));
      for (const [r, text] of [
        [3, values.seller_text],
        [8, values.recipient_text],
        [12, values.seller_text],
        [14, values.buyer_text],
      ] as const) {
        height(r, Math.max(30, Math.ceil(text.length / 120) * 12 + 8));
      }
      height(35 + delta, Math.max(18, Math.ceil(fields.power_of_attorney.length / 18) * 11 + 4));
      height(37 + delta, Math.max(18, Math.ceil(fields.power_of_attorney_issued.length / 90) * 11));
      // Invoice date stays a genuine Excel date, not a formatted string.
      const workbook = readPart(zip, 'xl/workbook.xml');
      const base =
        nodes(workbook, 'workbookPr')[0]?.getAttribute('date1904') === '1'
          ? Date.UTC(1904, 0, 1)
          : Date.UTC(1899, 11, 30);
      setCell(
        worksheet,
        'O19',
        (Date.parse(fields.document_date + 'T00:00:00Z') - base) / 86400000,
      );
      printSetup(zip, worksheet, 'invoice', 47 + delta);
    }
    savePart(zip, 'xl/worksheets/sheet1.xml', worksheet);
  }
  const names = {
    contract: 'Договор',
    appendix: 'Приложение',
    proposal: 'Предложение',
    invoice: 'Накладная',
  };
  const number = (
    kind === 'contract' || kind === 'appendix' ? fields.contract_number : fields.document_number
  )
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .slice(0, 80);
  return {
    name: `${names[kind]}_${number}.${extension}`,
    data: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
    lines,
    values,
  };
}
