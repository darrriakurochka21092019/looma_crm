import { z } from 'zod';

export const generatedDocumentKinds = ['contract', 'appendix', 'proposal', 'invoice'] as const;
export type GeneratedDocumentKind = (typeof generatedDocumentKinds)[number];
export const generatedDocumentLabels: Record<GeneratedDocumentKind, string> = {
  contract: 'Договор',
  appendix: 'Приложение к договору',
  proposal: 'Коммерческое предложение',
  invoice: 'Товарная накладная ТОРГ-12',
};
const line = (max = 300) => z.string().trim().max(max).default('');
export const documentPartySchema = z.object({
  name: line(),
  address: line(1500),
  inn: line(40),
  kpp: line(40),
  ogrn: line(40),
  okpo: line(40),
  bank: line(),
  account: line(80),
  corr_account: line(80),
  bik: line(40),
  bank_inn: line(40),
  bank_kpp: line(40),
  phone: line(100),
  email: line(200),
  representative: line(),
  position: line(),
  basis: line(1000),
  signature: line(),
  passport: line(1500),
  details: line(10000),
});
export type DocumentParty = z.infer<typeof documentPartySchema>;
export const documentPartyFields: { key: keyof DocumentParty; label: string; long?: boolean }[] = [
  { key: 'name', label: 'Полное наименование / ФИО' },
  { key: 'address', label: 'Юридический адрес / адрес регистрации', long: true },
  { key: 'inn', label: 'ИНН' },
  { key: 'kpp', label: 'КПП' },
  { key: 'ogrn', label: 'ОГРН / ОГРНИП' },
  { key: 'okpo', label: 'ОКПО' },
  { key: 'bank', label: 'Банк' },
  { key: 'account', label: 'Расчётный счёт' },
  { key: 'corr_account', label: 'Корреспондентский счёт' },
  { key: 'bik', label: 'БИК' },
  { key: 'bank_inn', label: 'ИНН банка' },
  { key: 'bank_kpp', label: 'КПП банка' },
  { key: 'phone', label: 'Телефон для документов' },
  { key: 'email', label: 'Email для документов' },
  { key: 'representative', label: 'ФИО представителя' },
  { key: 'position', label: 'Должность представителя' },
  { key: 'basis', label: 'Основание полномочий представителя', long: true },
  { key: 'signature', label: 'Расшифровка подписи' },
  { key: 'passport', label: 'Паспортные данные, если нужны в документе', long: true },
  { key: 'details', label: 'Дополнительные реквизиты', long: true },
];
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    'Проверьте дату документа',
  );
export const documentFieldsSchema = z.object({
  contract_number: z.string().trim().min(1, 'Укажите номер договора').max(100),
  contract_date: isoDate,
  document_number: z.string().trim().min(1, 'Укажите номер документа').max(100),
  document_date: isoDate,
  city: line(100),
  delivery_address: line(1500),
  production_terms: line(1500),
  delivery_terms: line(3000),
  advance_amount: z.number().int().min(0).max(9e12),
  advance_days: z.number().int().min(0).max(365).default(2),
  final_days: z.number().int().min(0).max(365).default(2),
  vat_mode: z.enum(['without', 'included']).default('without'),
  vat_rate_bps: z.number().int().min(0).max(10000).default(0),
  recipient: line(3000),
  recipient_position: line(),
  recipient_signature: line(),
  power_of_attorney: line(100),
  power_of_attorney_date: z.union([z.literal(''), isoDate]).default(''),
  power_of_attorney_issued: line(1000),
  package_count: z.number().int().min(0).max(100000).nullable().default(null),
});
export type DocumentFields = z.infer<typeof documentFieldsSchema>;
export const documentGenerationSchema = z.object({
  idempotency_key: z.string().uuid(),
  source_token: z.string().regex(/^[a-f0-9]{64}$/),
  kinds: z
    .array(z.enum(generatedDocumentKinds))
    .min(1)
    .max(4)
    .refine((kinds) => new Set(kinds).size === kinds.length, 'Выберите каждый документ один раз'),
  buyer: documentPartySchema,
  seller: documentPartySchema,
  fields: documentFieldsSchema,
  item_images: z.record(z.string().uuid(), z.string().uuid()).default({}),
  item_descriptions: z.record(z.string().uuid(), z.string().trim().min(1).max(2000)).default({}),
  save_client: z.boolean().default(false),
  save_company: z.boolean().default(false),
});
export type DocumentGenerationInput = z.infer<typeof documentGenerationSchema>;
