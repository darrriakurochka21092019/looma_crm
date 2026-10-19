import { documentPartyFields, type DocumentParty } from '../../shared/document-generation';

export function DocumentPartyFields({
  value,
  onChange,
  title,
  expanded = false,
}: {
  value: Partial<DocumentParty>;
  onChange: (v: Partial<DocumentParty>) => void;
  title: string;
  expanded?: boolean;
}) {
  return (
    <details className="document-party" open={expanded || undefined}>
      <summary>
        <b>{title}</b>
        <span>{value.name || 'Наименование, адрес, банковские реквизиты и подпись'}</span>
      </summary>
      <div className="form-grid">
        {documentPartyFields.map((field) => (
          <label key={field.key} className={field.long ? 'span-2' : ''}>
            {field.label}
            {field.long ? (
              <textarea
                rows={2}
                value={value[field.key] || ''}
                maxLength={field.key === 'details' ? 10000 : field.key === 'basis' ? 1000 : 1500}
                onChange={(e) => onChange({ ...value, [field.key]: e.target.value })}
              />
            ) : (
              <input
                value={value[field.key] || ''}
                maxLength={300}
                onChange={(e) => onChange({ ...value, [field.key]: e.target.value })}
              />
            )}
          </label>
        ))}
      </div>
    </details>
  );
}
