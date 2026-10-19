import { useEffect, useState } from 'react';
import { Download, FileText, RefreshCw } from 'lucide-react';
import { useApp, useLoad, LoadState } from './main';
import { decimal, key, money, post } from './api';
import { rublesToCents } from '../../shared/domain';
import {
  generatedDocumentLabels,
  type DocumentFields,
  type DocumentParty,
  type GeneratedDocumentKind,
} from '../../shared/document-generation';
import { DocumentPartyFields } from './document-party';

type Draft = {
  buyer: DocumentParty;
  seller: DocumentParty;
  fields: DocumentFields;
  item_images: Record<string, string>;
  item_descriptions: Record<string, string>;
};
export function DocumentGenerationForm({
  data: order,
  onSaved,
}: {
  data: any;
  onSaved: (s?: string) => void;
}) {
  const { user, refresh } = useApp(),
    [nonce, setNonce] = useState(0);
  const { data, error: loadError } = useLoad<any>(
    `/orders/${order.id}/document-data?refresh=${nonce}`,
  );
  const [draft, setDraft] = useState<Draft | null>(null),
    [kinds, setKinds] = useState<GeneratedDocumentKind[]>([]);
  const [advance, setAdvance] = useState(''),
    [vat, setVat] = useState(''),
    [packages, setPackages] = useState('');
  const [saveClient, setSaveClient] = useState(user.role !== 'accountant'),
    [saveCompany, setSaveCompany] = useState(user.role === 'owner');
  const [idem] = useState(key),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<any>(null);
  useEffect(() => {
    if (!data) return;
    setDraft({
      buyer: data.buyer,
      seller: data.seller,
      fields: data.fields,
      item_images: data.item_images,
      item_descriptions: data.item_descriptions,
    });
    setAdvance(decimal(data.fields.advance_amount));
    setVat(String(data.fields.vat_rate_bps / 100));
    setPackages(data.fields.package_count === null ? '' : String(data.fields.package_count));
    setKinds((current) => (current.length ? current : data.allowed_kinds));
  }, [data]);
  if (result)
    return (
      <div className="document-generation-form">
        <div className="document-result">
          <FileText size={32} />
          <h3>Документы созданы</h3>
          <p>
            Файлы сохранены в заказе. Их можно скачать сейчас или открыть позднее в разделе
            «Документы».
          </p>
        </div>
        <div className="generated-file-list">
          {result.documents.map((d: any) => (
            <a
              className="generated-file"
              key={d.id}
              href={`/api/documents/${d.id}/download?version=${d.version}`}
            >
              <FileText size={20} />
              <span>
                <b>{d.label}</b>
                <small>
                  {d.name} · версия {d.version}
                </small>
              </span>
              <Download size={18} />
            </a>
          ))}
        </div>
        <div className="form-footer">
          {result.documents.length > 1 && (
            <a
              className="btn"
              href={`/api/orders/${order.id}/document-bundle?files=${encodeURIComponent(result.documents.map((d: any) => d.id + ':' + d.version).join(','))}`}
            >
              <Download size={16} />
              Скачать комплект ZIP
            </a>
          )}
          <button className="btn dark" onClick={() => onSaved('Документы сформированы')}>
            Готово
          </button>
        </div>
      </div>
    );
  if (!data || !draft) return <LoadState error={loadError} />;
  const set = (name: keyof DocumentFields, value: any) =>
    setDraft((v) => v && { ...v, fields: { ...v.fields, [name]: value } });
  let advanceValue = 0;
  try {
    advanceValue = rublesToCents(advance);
  } catch {}
  const contractual = kinds.includes('contract'),
    commercial = user.role !== 'accountant';
  return (
    <form
      className="document-generation-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
          if (!kinds.length) throw new Error('Выберите хотя бы один документ');
          const amount = rublesToCents(advance);
          const rate = draft.fields.vat_mode === 'included' ? Number(vat.replace(',', '.')) : 0;
          if (!Number.isFinite(rate) || rate < 0 || rate > 100)
            throw new Error('Укажите ставку НДС от 0 до 100%');
          if (packages && !/^\d+$/.test(packages))
            throw new Error('Количество мест должно быть целым числом');
          const created = await post(`/orders/${order.id}/generate-documents`, {
            ...draft,
            idempotency_key: idem,
            source_token: data.source_token,
            kinds,
            save_client: saveClient,
            save_company: saveCompany,
            fields: {
              ...draft.fields,
              advance_amount: amount,
              vat_rate_bps: Math.round(rate * 100),
              package_count: packages === '' ? null : Number(packages),
            },
          });
          setResult(created);
          refresh();
        } catch (err: any) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted">
        Данные подставлены из карточек клиента и заказа. Проверьте реквизиты и условия перед
        созданием файлов.
      </p>
      <div className="document-kind-grid">
        {(data.allowed_kinds as GeneratedDocumentKind[]).map((kind) => (
          <label className={'document-kind ' + (kinds.includes(kind) ? 'selected' : '')} key={kind}>
            <input
              type="checkbox"
              checked={kinds.includes(kind)}
              disabled={busy}
              onChange={(e) =>
                setKinds((a) => (e.target.checked ? [...a, kind] : a.filter((k) => k !== kind)))
              }
            />
            <span>
              <b>{generatedDocumentLabels[kind]}</b>
              <small>
                {kind === 'contract' || kind === 'appendix' ? 'Word · DOCX' : 'Excel · XLSX'}
              </small>
            </span>
          </label>
        ))}
      </div>
      <div className="document-totals">
        <span>
          Изделия до скидки <b>{money(data.order.total + data.order.discount)}</b>
        </span>
        <span>
          Скидка <b>{money(data.order.discount)}</b>
        </span>
        <span>
          Итого в документах <b>{money(data.order.total)}</b>
        </span>
      </div>
      <h3>Номера и даты</h3>
      <div className="form-grid">
        <label>
          Номер договора
          <input
            required
            maxLength={100}
            value={draft.fields.contract_number}
            onChange={(e) => set('contract_number', e.target.value)}
          />
        </label>
        <label>
          Дата договора
          <input
            type="date"
            required
            value={draft.fields.contract_date}
            onChange={(e) => set('contract_date', e.target.value)}
          />
        </label>
        <label>
          Номер предложения / накладной
          <input
            required
            maxLength={100}
            value={draft.fields.document_number}
            onChange={(e) => set('document_number', e.target.value)}
          />
        </label>
        <label>
          Дата предложения / накладной
          <input
            type="date"
            required
            value={draft.fields.document_date}
            onChange={(e) => set('document_date', e.target.value)}
          />
        </label>
        <label>
          Город заключения договора
          <input
            required={contractual}
            value={draft.fields.city}
            onChange={(e) => set('city', e.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          Адрес доставки
          <input
            required={contractual}
            value={draft.fields.delivery_address}
            onChange={(e) => set('delivery_address', e.target.value)}
            maxLength={1500}
          />
        </label>
        <label>
          Срок изготовления
          <input
            required={contractual}
            value={draft.fields.production_terms}
            onChange={(e) => set('production_terms', e.target.value)}
            maxLength={1500}
          />
        </label>
        <label>
          Условия доставки и сборки
          <textarea
            required={contractual}
            value={draft.fields.delivery_terms}
            onChange={(e) => set('delivery_terms', e.target.value)}
            maxLength={3000}
          />
        </label>
      </div>
      <h3>Оплата</h3>
      <div className="form-grid">
        <label>
          Аванс по договору, ₽
          <input
            inputMode="decimal"
            required
            value={advance}
            onChange={(e) => setAdvance(e.target.value)}
          />
          <small>Подставлен из плана платежей. Если аванса нет, укажите 0.</small>
        </label>
        <label>
          Окончательный платёж, ₽
          <input readOnly value={money(Math.max(0, data.order.total - advanceValue))} />
        </label>
        <label>
          Срок оплаты аванса, рабочих дней
          <input
            type="number"
            min={0}
            max={365}
            value={draft.fields.advance_days}
            onChange={(e) => set('advance_days', Number(e.target.value))}
          />
        </label>
        <label>
          Срок окончательной оплаты, рабочих дней
          <input
            type="number"
            min={0}
            max={365}
            value={draft.fields.final_days}
            onChange={(e) => set('final_days', Number(e.target.value))}
          />
        </label>
        <label>
          НДС в накладной
          <select value={draft.fields.vat_mode} onChange={(e) => set('vat_mode', e.target.value)}>
            <option value="without">Без НДС</option>
            <option value="included">НДС включён в цену заказа</option>
          </select>
        </label>
        {draft.fields.vat_mode === 'included' && (
          <label>
            Ставка НДС, %
            <input
              inputMode="decimal"
              required
              value={vat}
              onChange={(e) => setVat(e.target.value)}
            />
          </label>
        )}
      </div>
      <DocumentPartyFields
        title="Заказчик — реквизиты из карточки клиента"
        value={draft.buyer}
        onChange={(buyer) => setDraft((v) => v && { ...v, buyer: buyer as DocumentParty })}
      />
      {commercial && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={saveClient}
            onChange={(e) => setSaveClient(e.target.checked)}
          />
          Сохранить реквизиты заказчика в карточке клиента
        </label>
      )}
      <DocumentPartyFields
        title="Исполнитель — реквизиты вашей компании"
        value={draft.seller}
        onChange={(seller) => setDraft((v) => v && { ...v, seller: seller as DocumentParty })}
      />
      {user.role === 'owner' && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={saveCompany}
            onChange={(e) => setSaveCompany(e.target.checked)}
          />
          Сохранить реквизиты исполнителя для следующих заказов
        </label>
      )}
      <details className="document-party">
        <summary>
          <b>Изделия и фотографии</b>
          <span>{data.items.length} позиций из заказа</span>
        </summary>
        <p className="muted">
          Цены в карточках ниже указаны до скидки. В файлах скидка распределяется между изделиями.
          Фотографии выбираются из JPG и PNG, прикреплённых к этому заказу.
        </p>
        {data.items.map((item: any) => (
          <div className="document-item" key={item.id}>
            <b>{item.model}</b>
            <small>
              {item.quantity} шт. × {money(item.price)}
            </small>
            <label>
              Описание в документе
              <textarea
                maxLength={2000}
                rows={3}
                value={draft.item_descriptions[item.id] || ''}
                onChange={(e) =>
                  setDraft(
                    (v) =>
                      v && {
                        ...v,
                        item_descriptions: { ...v.item_descriptions, [item.id]: e.target.value },
                      },
                  )
                }
              />
            </label>
            {commercial && (
              <label>
                Фото изделия
                <select
                  value={draft.item_images[item.id] || ''}
                  onChange={(e) => {
                    const image = e.target.value;
                    setDraft((v) => {
                      if (!v) return v;
                      const selected = { ...v.item_images };
                      if (image) selected[item.id] = image;
                      else delete selected[item.id];
                      return { ...v, item_images: selected };
                    });
                  }}
                >
                  <option value="">Без изображения</option>
                  {data.images.map((image: any) => (
                    <option value={image.id} key={image.id}>
                      {image.name} · V{image.version}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ))}
      </details>
      <details className="document-party">
        <summary>
          <b>Получение товара</b>
          <span>Поля товарной накладной</span>
        </summary>
        <div className="form-grid">
          <label className="span-2">
            Грузополучатель, если отличается от заказчика
            <textarea
              value={draft.fields.recipient}
              onChange={(e) => set('recipient', e.target.value)}
              maxLength={3000}
            />
          </label>
          <label>
            Должность получателя
            <input
              value={draft.fields.recipient_position}
              onChange={(e) => set('recipient_position', e.target.value)}
              maxLength={300}
            />
          </label>
          <label>
            Расшифровка подписи получателя
            <input
              value={draft.fields.recipient_signature}
              onChange={(e) => set('recipient_signature', e.target.value)}
              maxLength={300}
            />
          </label>
          <label>
            Номер доверенности
            <input
              value={draft.fields.power_of_attorney}
              onChange={(e) => set('power_of_attorney', e.target.value)}
              maxLength={100}
            />
          </label>
          <label>
            Дата доверенности
            <input
              type="date"
              value={draft.fields.power_of_attorney_date}
              onChange={(e) => set('power_of_attorney_date', e.target.value)}
            />
          </label>
          <label className="span-2">
            Кем и кому выдана доверенность
            <textarea
              value={draft.fields.power_of_attorney_issued}
              onChange={(e) => set('power_of_attorney_issued', e.target.value)}
              maxLength={1000}
            />
          </label>
          <label>
            Количество грузовых мест
            <input
              inputMode="numeric"
              value={packages}
              onChange={(e) => setPackages(e.target.value)}
            />
            <small>Оставьте пустым, если количество мест ещё не определено.</small>
          </label>
        </div>
      </details>
      {error && (
        <div className="form-error" role="alert">
          {error}
          <button
            type="button"
            className="text-btn"
            disabled={busy}
            onClick={() => {
              setError('');
              setNonce((n) => n + 1);
            }}
          >
            <RefreshCw size={14} />
            Загрузить данные карточек заново
          </button>
        </div>
      )}
      <div className="form-footer">
        <button className="btn dark" disabled={busy || !kinds.length}>
          {busy
            ? 'Создаём документы…'
            : kinds.length === 1
              ? 'Создать документ'
              : 'Создать документы'}
        </button>
      </div>
    </form>
  );
}
