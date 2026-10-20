import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, Sofa } from 'lucide-react';
import type { Item } from '../../shared/domain';
import { patch, upload } from './api';
import { useApp } from './main';

export function ItemPhoto({
  item,
  order,
  editable,
}: {
  item: Item;
  order: { id: string; version: number };
  editable: boolean;
}) {
  const { refresh, notify } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [item.photo?.id, item.photo?.version]);
  const image =
    item.photo && !broken
      ? `/api/documents/${item.photo.id}/download?preview=1&version=${item.photo.version}`
      : null;
  async function choose(file: File) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!/\.(png|jpe?g)$/i.test(file.name)) throw new Error('Выберите фотографию JPG или PNG');
      const q = new URLSearchParams({
        order_id: order.id,
        item_id: item.id!,
        order_version: String(order.version),
        category: 'photo',
        visibility: 'technical',
        comment: 'Фото изделия: ' + item.model,
      });
      await upload('/documents?' + q, file);
      notify('Фото сохранено. Оно подставится в предложение и приложение');
      refresh();
    } catch (e: any) {
      setError(e.message);
      if (e.status === 409) {
        notify(e.message);
        refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await patch(`/orders/${order.id}/items/${item.id}/photo`, {
        version: order.version,
        photo_document_id: null,
      });
      notify('Фото убрано из изделия');
      refresh();
    } catch (e: any) {
      setError(e.message);
      if (e.status === 409) {
        notify(e.message);
        refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="product-photo" data-help="item-photo">
      {editable && (
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,.jpg,.jpeg,.png"
          hidden
          aria-label={'Загрузить фото изделия ' + item.model}
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void choose(f);
          }}
        />
      )}
      {busy ? (
        <div className="product-icon product-photo-target">
          <Loader2 className="spin" size={25} />
          <b>Сохраняем фото…</b>
        </div>
      ) : image ? (
        <a
          className="product-icon product-photo-target has-photo"
          href={image}
          target="_blank"
          rel="noreferrer"
          aria-label={'Открыть фото изделия ' + item.model}
        >
          <img src={image} alt={'Фото изделия ' + item.model} onError={() => setBroken(true)} />
        </a>
      ) : editable ? (
        <button
          type="button"
          className="product-icon product-photo-target photo-add"
          onClick={() => input.current?.click()}
          aria-label={'Добавить фото изделия ' + item.model}
        >
          <ImagePlus size={30} strokeWidth={1.5} />
          <b>{broken ? 'Загрузить другое фото' : 'Добавить фото'}</b>
          <small>JPG или PNG</small>
        </button>
      ) : (
        <div className="product-icon product-photo-target">
          <Sofa size={38} strokeWidth={1.2} />
          <small>Фото изделия</small>
        </div>
      )}
      {editable && item.photo_document_id && (
        <div className="product-photo-actions">
          <button
            className="text-btn"
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            Заменить
          </button>
          <button className="text-btn" type="button" disabled={busy} onClick={() => void clear()}>
            Убрать
          </button>
        </div>
      )}
      {editable && (
        <small className="product-photo-hint">Для предложения и приложения к договору</small>
      )}
      {error && (
        <small className="form-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
