-- Historical order detail stays intact. All operational totals use these views.
CREATE VIEW recorded_order_totals AS
SELECT * FROM order_totals WHERE NOT archived AND status NOT IN ('paused','cancelled');

CREATE VIEW recorded_money_movements AS
SELECT m.* FROM money_movements m
LEFT JOIN expenses e ON e.id=m.expense_id
LEFT JOIN orders o ON o.id=COALESCE(m.order_id,e.order_id)
WHERE o.id IS NULL OR (NOT o.archived AND o.status NOT IN ('paused','cancelled'));

CREATE VIEW recorded_expenses AS
SELECT e.* FROM expenses e LEFT JOIN orders o ON o.id=e.order_id
WHERE o.id IS NULL OR (NOT o.archived AND o.status NOT IN ('paused','cancelled'));

ALTER TABLE tax_reservations ADD COLUMN base_type text NOT NULL DEFAULT 'receipts'
  CHECK(base_type IN ('receipts','management_profit'));
UPDATE tax_reservations SET base_type=COALESCE((SELECT data->>'tax_base' FROM settings WHERE id=1),'receipts');

-- Unpaid reserves follow the current included orders, retaining their chosen rate
-- and manual adjustment. Paid reserves remain historical payment records.
CREATE VIEW current_tax_reservations AS
SELECT t.id,t.period,
  CASE WHEN t.status='paid' THEN t.base_amount ELSE b.amount END AS base_amount,
  t.rate_bps,
  CASE WHEN t.status='paid' THEN t.calculated_amount
    ELSE round(b.amount::numeric*t.rate_bps/10000)::bigint END AS calculated_amount,
  t.adjustment,t.reason,t.status,t.payment_id,t.author_id,t.created_at,t.base_type
FROM tax_reservations t
CROSS JOIN settings s
CROSS JOIN LATERAL (
  SELECT GREATEST(0,CASE WHEN t.base_type='receipts' THEN
    (SELECT COALESCE(sum(CASE WHEN kind='receipt' THEN amount WHEN kind='refund' THEN -amount ELSE 0 END),0)
     FROM recorded_money_movements WHERE status='confirmed'
       AND occurred_on >= (t.period||'-01')::date AND occurred_on < ((t.period||'-01')::date+interval '1 month'))
  ELSE
    (SELECT COALESCE(sum(gross_profit),0) FROM recorded_order_totals
     WHERE status='closed' AND closed_at AT TIME ZONE (s.data->>'timezone') >= (t.period||'-01')::date
       AND closed_at AT TIME ZONE (s.data->>'timezone') < ((t.period||'-01')::date+interval '1 month'))
    - (SELECT COALESCE(sum(amount),0) FROM expenses WHERE order_id IS NULL AND NOT tax_payment
       AND incurred_on >= (t.period||'-01')::date AND incurred_on < ((t.period||'-01')::date+interval '1 month'))
  END)::bigint AS amount
) b WHERE s.id=1;

CREATE TABLE max_recipients (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  max_user_id text NOT NULL UNIQUE CHECK(max_user_id ~ '^[1-9][0-9]{0,18}$'),
  enabled boolean NOT NULL DEFAULT true,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE TABLE task_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_version integer NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('assigned','updated','completed','due','overdue')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,task_version,user_id,kind)
);
CREATE INDEX task_notifications_pending ON task_notifications(next_attempt_at) WHERE status IN ('pending','sending');
CREATE INDEX tasks_due_notifications ON tasks(due_at) WHERE status<>'done';
