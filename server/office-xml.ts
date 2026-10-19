import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import PizZip from 'pizzip';
export const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
export type XmlDocument = ReturnType<DOMParser['parseFromString']>;
export type XmlElement = ReturnType<XmlDocument['createElementNS']>;
export function parseXml(xml: string): XmlDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported XML declaration');
  return new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
}
export function serializeXml(doc: XmlDocument) {
  return new XMLSerializer().serializeToString(doc);
}
export function xmlText(value: unknown) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
export function escapeXml(value: unknown) {
  return xmlText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
export function nodes(root: any, local: string, ns = S): XmlElement[] {
  return Array.from(root.getElementsByTagNameNS(ns, local)) as XmlElement[];
}
export function child(root: any, local: string): XmlElement | undefined {
  return Array.from(root.childNodes).find((n: any) => n.nodeType === 1 && n.localName === local) as
    XmlElement | undefined;
}
export function readPart(zip: PizZip, path: string, empty?: string) {
  const part = zip.file(path);
  if (!part && !empty) throw new Error('Missing template part: ' + path);
  return parseXml(part?.asText() || empty!);
}
export function savePart(zip: PizZip, path: string, doc: XmlDocument) {
  zip.file(path, serializeXml(doc));
}
export function columnIndex(letters: string) {
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}
function columnPart(address: string) {
  return address.match(/^[A-Z]+/)![0];
}
export function cell(doc: XmlDocument, address: string): XmlElement {
  const found = nodes(doc, 'c').find((n) => n.getAttribute('r') === address);
  if (found) return found;
  const rowNumber = Number(address.match(/\d+$/)![0]),
    data = nodes(doc, 'sheetData')[0];
  let row = nodes(data, 'row').find((n) => Number(n.getAttribute('r')) === rowNumber);
  if (!row) {
    row = doc.createElementNS(S, 'row');
    row.setAttribute('r', String(rowNumber));
    const next = nodes(data, 'row').find((n) => Number(n.getAttribute('r')) > rowNumber);
    data.insertBefore(row, next || null);
  }
  const c = doc.createElementNS(S, 'c');
  c.setAttribute('r', address);
  const next = nodes(row, 'c').find(
    (n) => columnIndex(columnPart(n.getAttribute('r')!)) > columnIndex(columnPart(address)),
  );
  row.insertBefore(c, next || null);
  return c;
}
export function setCell(
  doc: XmlDocument,
  address: string,
  value: string | number,
  formula?: string,
) {
  const c = cell(doc, address);
  while (c.firstChild) c.removeChild(c.firstChild);
  c.removeAttribute('t');
  if (formula) {
    const f = doc.createElementNS(S, 'f');
    f.textContent = formula.replace(/^=/, '');
    c.appendChild(f);
    if (typeof value === 'string') c.setAttribute('t', 'str');
    const v = doc.createElementNS(S, 'v');
    v.textContent = xmlText(value);
    c.appendChild(v);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite spreadsheet value');
    const v = doc.createElementNS(S, 'v');
    v.textContent = String(value);
    c.appendChild(v);
  } else {
    c.setAttribute('t', 'inlineStr');
    const is = doc.createElementNS(S, 'is'),
      t = doc.createElementNS(S, 't');
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    t.textContent = xmlText(value);
    is.appendChild(t);
    c.appendChild(is);
  }
}
function shiftedRef(ref: string, start: number, delta: number) {
  return ref.replace(
    /(\$?[A-Z]{1,3}\$?)(\d+)/g,
    (_, col, n) => col + (Number(n) >= start ? Number(n) + delta : n),
  );
}
export function expandRows(doc: XmlDocument, start: number, count: number) {
  if (count < 1 || count > 200) throw new Error('Invalid document row count');
  const rows = nodes(doc, 'row'),
    prototype = rows.find((row) => Number(row.getAttribute('r')) === start);
  if (!prototype) throw new Error('Missing template position row');
  const delta = count - 1;
  for (const row of rows) {
    const number = Number(row.getAttribute('r'));
    if (number <= start) continue;
    row.setAttribute('r', String(number + delta));
    for (const c of nodes(row, 'c'))
      c.setAttribute('r', shiftedRef(c.getAttribute('r')!, start, delta));
    for (const f of nodes(row, 'f')) f.textContent = shiftedRef(f.textContent || '', start, delta);
  }
  for (let i = 0; i < count; i++) {
    const row = prototype.cloneNode(true) as XmlElement;
    row.setAttribute('r', String(start + i));
    for (const c of nodes(row, 'c'))
      c.setAttribute('r', shiftedRef(c.getAttribute('r')!, start, i));
    for (const f of nodes(row, 'f')) f.textContent = shiftedRef(f.textContent || '', start, i);
    prototype.parentNode!.insertBefore(row, prototype);
  }
  prototype.parentNode!.removeChild(prototype);
  const merges = nodes(doc, 'mergeCells')[0];
  if (merges) {
    for (const merge of [...nodes(merges, 'mergeCell')]) {
      const ref = merge.getAttribute('ref')!,
        numbers = ref.match(/\d+/g)!.map(Number);
      if (numbers.every((n) => n === start)) {
        for (let i = 1; i < count; i++) {
          const m = merge.cloneNode(true) as XmlElement;
          m.setAttribute('ref', shiftedRef(ref, start, i));
          merges.appendChild(m);
        }
      } else merge.setAttribute('ref', shiftedRef(ref, start, delta));
    }
    merges.setAttribute('count', String(nodes(merges, 'mergeCell').length));
  }
  for (const d of nodes(doc, 'dimension'))
    d.setAttribute('ref', shiftedRef(d.getAttribute('ref')!, start, delta));
  for (const brk of nodes(doc, 'brk')) {
    const id = Number(brk.getAttribute('id'));
    if (id >= start) brk.setAttribute('id', String(id + delta));
  }
}
export function replaceTokens(doc: XmlDocument, values: Record<string, unknown>) {
  const textNodes = [
    ...nodes(doc, 't'),
    ...nodes(doc, 'c')
      .filter((c) => c.getAttribute('t') === 'str')
      .flatMap((c) => nodes(c, 'v')),
  ];
  for (const t of textNodes)
    t.textContent = (t.textContent || '').replace(/\{([a-z_]+)\}/g, (_, key) => {
      if (!(key in values)) throw new Error('Unknown spreadsheet field: ' + key);
      return xmlText(values[key]);
    });
}
function ensureWorksheetChild(doc: XmlDocument, name: string, before: string[]) {
  const root = doc.documentElement!,
    existing = child(root, name);
  if (existing) return existing;
  const el = doc.createElementNS(S, name);
  const next = Array.from(root.childNodes).find((n: any) => before.includes(n.localName)) as
    XmlElement | undefined;
  root.insertBefore(el, next || null);
  return el;
}
export function printSetup(
  zip: PizZip,
  sheet: XmlDocument,
  kind: 'proposal' | 'invoice',
  lastRow: number,
) {
  const pr = ensureWorksheetChild(sheet, 'sheetPr', [
    'dimension',
    'sheetViews',
    'sheetFormatPr',
    'cols',
    'sheetData',
  ]);
  const fit = child(pr, 'pageSetUpPr') || sheet.createElementNS(S, 'pageSetUpPr');
  fit.setAttribute('fitToPage', '1');
  if (!fit.parentNode) pr.appendChild(fit);
  const margins = ensureWorksheetChild(sheet, 'pageMargins', [
    'pageSetup',
    'headerFooter',
    'rowBreaks',
    'colBreaks',
    'drawing',
    'extLst',
  ]);
  for (const [k, v] of Object.entries({
    left: '0.25',
    right: '0.25',
    top: '0.35',
    bottom: '0.35',
    header: '0.15',
    footer: '0.15',
  }))
    margins.setAttribute(k, v);
  const setup = ensureWorksheetChild(sheet, 'pageSetup', [
    'headerFooter',
    'rowBreaks',
    'colBreaks',
    'drawing',
    'extLst',
  ]);
  setup.setAttribute('paperSize', '9');
  setup.setAttribute('orientation', kind === 'invoice' ? 'landscape' : 'portrait');
  setup.setAttribute('fitToWidth', '1');
  setup.setAttribute('fitToHeight', '0');
  const workbook = readPart(zip, 'xl/workbook.xml'),
    root = workbook.documentElement!;
  let names = child(root, 'definedNames');
  if (!names) {
    names = workbook.createElementNS(S, 'definedNames');
    root.insertBefore(names, child(root, 'calcPr') || null);
  }
  for (const n of [...nodes(names, 'definedName')])
    if (['_xlnm.Print_Area', '_xlnm.Print_Titles'].includes(n.getAttribute('name') || ''))
      names.removeChild(n);
  const sheetName = nodes(workbook, 'sheet')[0].getAttribute('name')!.replace(/'/g, "''");
  for (const [name, ref] of [
    [
      '_xlnm.Print_Area',
      `'${sheetName}'!$A$${kind === 'invoice' ? 1 : 9}:$${kind === 'invoice' ? 'AP' : 'F'}$${lastRow}`,
    ],
    [
      '_xlnm.Print_Titles',
      `'${sheetName}'!$${kind === 'invoice' ? 22 : 9}:$${kind === 'invoice' ? 24 : 11}`,
    ],
  ]) {
    const n = workbook.createElementNS(S, 'definedName');
    n.setAttribute('name', name);
    n.setAttribute('localSheetId', '0');
    n.textContent = ref;
    names.appendChild(n);
  }
  const calc = child(root, 'calcPr') || workbook.createElementNS(S, 'calcPr');
  calc.setAttribute('fullCalcOnLoad', '1');
  calc.setAttribute('forceFullCalc', '1');
  if (!calc.parentNode) root.appendChild(calc);
  savePart(zip, 'xl/workbook.xml', workbook);
  zip.remove('xl/calcChain.xml');
  const types = readPart(zip, '[Content_Types].xml');
  for (const n of nodes(types, 'Override', CT))
    if (n.getAttribute('PartName') === '/xl/calcChain.xml') n.parentNode!.removeChild(n);
  savePart(zip, '[Content_Types].xml', types);
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (rels) {
    const d = parseXml(rels.asText());
    for (const n of nodes(d, 'Relationship', PKG))
      if (n.getAttribute('Type')?.endsWith('/calcChain')) n.parentNode!.removeChild(n);
    savePart(zip, 'xl/_rels/workbook.xml.rels', d);
  }
}
export type OfficeImage = { id: string; data: Buffer; mime: string; width: number; height: number };
export function imageSize(data: Buffer, mime: string) {
  let width = 0,
    height = 0;
  if (mime === 'image/png' && data.length >= 24) {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  }
  if (mime === 'image/jpeg') {
    for (let p = 2; p + 9 < data.length;) {
      if (data[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = data[p + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        p += 2;
        continue;
      }
      const size = data.readUInt16BE(p + 2);
      if (size < 2 || p + size + 2 > data.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        height = data.readUInt16BE(p + 5);
        width = data.readUInt16BE(p + 7);
        break;
      }
      p += size + 2;
    }
  }
  if (width < 1 || height < 1 || width > 50000 || height > 50000 || width * height > 150_000_000)
    throw new Error('Не удалось прочитать размеры фотографии. Выберите другой JPG или PNG');
  return { width, height };
}
function addType(zip: PizZip, path: string, type: string) {
  const doc = readPart(zip, '[Content_Types].xml'),
    root = doc.documentElement!;
  if (!nodes(root, 'Override', CT).some((n) => n.getAttribute('PartName') === '/' + path)) {
    const el = doc.createElementNS(CT, 'Override');
    el.setAttribute('PartName', '/' + path);
    el.setAttribute('ContentType', type);
    root.appendChild(el);
  }
  savePart(zip, '[Content_Types].xml', doc);
}
function imageType(zip: PizZip, mime: string) {
  const ext = mime === 'image/png' ? 'png' : 'jpeg',
    doc = readPart(zip, '[Content_Types].xml');
  if (!nodes(doc, 'Default', CT).some((n) => n.getAttribute('Extension') === ext)) {
    const n = doc.createElementNS(CT, 'Default');
    n.setAttribute('Extension', ext);
    n.setAttribute('ContentType', mime);
    doc.documentElement!.appendChild(n);
    savePart(zip, '[Content_Types].xml', doc);
  }
  return ext;
}
function relationship(zip: PizZip, path: string, id: string, target: string, type: string) {
  const doc = readPart(zip, path, `<Relationships xmlns="${PKG}"/>`),
    el = doc.createElementNS(PKG, 'Relationship');
  el.setAttribute('Id', id);
  el.setAttribute('Target', target);
  el.setAttribute('Type', R + '/' + type);
  doc.documentElement!.appendChild(el);
  savePart(zip, path, doc);
}
export function embedWordImages(
  zip: PizZip,
  images: Map<string, OfficeImage>,
  rows: { index: number; photo_document_id: string | null }[],
) {
  const doc = readPart(zip, 'word/document.xml');
  const embedded = new Map<string, { name: string; id: string }>();
  for (const row of rows) {
    const t = nodes(doc, 't', W).find((n) => n.textContent === 'LOOMAIMAGE_' + row.index);
    if (!t) continue;
    const image = row.photo_document_id && images.get(row.photo_document_id);
    if (!image) {
      t.textContent = '';
      continue;
    }
    let entry = embedded.get(image.id);
    if (!entry) {
      const ext = imageType(zip, image.mime);
      entry = { name: `looma-${row.index}.${ext}`, id: `rIdLooma${row.index}` };
      embedded.set(image.id, entry);
      zip.file('word/media/' + entry.name, image.data);
      relationship(zip, 'word/_rels/document.xml.rels', entry.id, 'media/' + entry.name, 'image');
    }
    const { id } = entry;
    const scale = Math.min(180 / image.width, 110 / image.height),
      cx = Math.round(image.width * scale * 9525),
      cy = Math.round(image.height * scale * 9525);
    const run = parseXml(
      `<w:r xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${1000 + row.index}" name="Изделие ${row.index}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${1000 + row.index}" name="Изделие ${row.index}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
    ).documentElement!;
    const old = t.parentNode!;
    old.parentNode!.replaceChild(doc.importNode(run, true), old);
  }
  savePart(zip, 'word/document.xml', doc);
}
export function embedExcelImages(
  zip: PizZip,
  sheet: XmlDocument,
  images: Map<string, OfficeImage>,
  rows: { index: number; photo_document_id: string | null }[],
) {
  const anchors: string[] = [];
  const embedded = new Map<string, string>();
  for (const row of rows) {
    const image = row.photo_document_id && images.get(row.photo_document_id);
    if (!image) continue;
    let id = embedded.get(image.id);
    if (!id) {
      const ext = imageType(zip, image.mime),
        name = `looma-${row.index}.${ext}`;
      id = `rIdImage${row.index}`;
      embedded.set(image.id, id);
      zip.file('xl/media/' + name, image.data);
      relationship(zip, 'xl/drawings/_rels/looma.xml.rels', id, '../media/' + name, 'image');
    }
    const scale = Math.min(210 / image.width, 130 / image.height),
      cx = Math.round(image.width * scale * 9525),
      cy = Math.round(image.height * scale * 9525);
    anchors.push(
      `<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>76200</xdr:colOff><xdr:row>${10 + row.index}</xdr:row><xdr:rowOff>76200</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${row.index}" name="Изделие ${row.index}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`,
    );
  }
  if (!anchors.length) return;
  zip.file(
    'xl/drawings/looma.xml',
    `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}">${anchors.join('')}</xdr:wsDr>`,
  );
  relationship(
    zip,
    'xl/worksheets/_rels/sheet1.xml.rels',
    'rIdLoomaDrawing',
    '../drawings/looma.xml',
    'drawing',
  );
  const drawing = ensureWorksheetChild(sheet, 'drawing', [
    'legacyDrawing',
    'legacyDrawingHF',
    'picture',
    'oleObjects',
    'controls',
    'tableParts',
    'extLst',
  ]);
  drawing.setAttributeNS(R, 'r:id', 'rIdLoomaDrawing');
  addType(
    zip,
    'xl/drawings/looma.xml',
    'application/vnd.openxmlformats-officedocument.drawing+xml',
  );
}
