CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('owner','manager','accountant','master')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS invitations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, name text NOT NULL, role text NOT NULL CHECK(role IN ('manager','accountant','master')), token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, created_by uuid REFERENCES users(id));
CREATE TABLE IF NOT EXISTS settings (id integer PRIMARY KEY CHECK(id=1), data jsonb NOT NULL, version integer NOT NULL DEFAULT 1);
INSERT INTO settings(id,data) VALUES(1,'{"company_name":"LOOMA","legal_details":"","timezone":"Europe/Moscow","tax_regime":"Не указан","tax_base":"receipts","tax_rate_bps":600,"opening_balance":0,"manager_can_close":false,"contract_approved":false,"contract_template":null,"storage_quota_mb":1024,"max_file_mb":25,"step_names":["Подготовка материалов","Каркас","Раскрой","Пошив / обивка","Сборка","Контроль качества","Доставка"]}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS clients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL DEFAULT 'person' CHECK(type IN ('person','company')),
 name text NOT NULL, phone text NOT NULL, email text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
 details text NOT NULL DEFAULT '', source text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', consent_basis text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_phone ON clients(phone) WHERE phone <> '';
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 101;
CREATE TABLE IF NOT EXISTS orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigserial UNIQUE, number text UNIQUE NOT NULL,
 client_id uuid NOT NULL REFERENCES clients(id), title text NOT NULL, external_ref text UNIQUE,
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','calculation','approval','contract','production','ready','closed','paused','cancelled')),
 due_date date NOT NULL, manager_id uuid REFERENCES users(id), master_id uuid REFERENCES users(id),
 discount bigint NOT NULL DEFAULT 0 CHECK(discount>=0), notes text NOT NULL DEFAULT '', status_reason text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1, closed_at timestamptz, handed_over_at timestamptz, archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_due ON orders(due_date,status);
CREATE INDEX IF NOT EXISTS orders_manager ON orders(manager_id);
CREATE INDEX IF NOT EXISTS orders_master ON orders(master_id);
CREATE INDEX IF NOT EXISTS orders_client ON orders(client_id);
CREATE TABLE IF NOT EXISTS order_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), kind text NOT NULL DEFAULT 'Диван',
 model text NOT NULL, position integer NOT NULL DEFAULT 0, quantity integer NOT NULL CHECK(quantity>0 AND quantity<=1000), dimensions text NOT NULL DEFAULT '',
 fabric text NOT NULL DEFAULT '', color text NOT NULL DEFAULT '', filling text NOT NULL DEFAULT '', mechanism text NOT NULL DEFAULT '',
 notes text NOT NULL DEFAULT '', price bigint NOT NULL CHECK(price>=0), planned_cost bigint NOT NULL DEFAULT 0 CHECK(planned_cost>=0)
);
CREATE INDEX IF NOT EXISTS items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS payment_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), title text NOT NULL, amount bigint NOT NULL CHECK(amount>0), due_date date NOT NULL);
CREATE TABLE IF NOT EXISTS production_steps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), name text NOT NULL, position integer NOT NULL,
 assignee_id uuid REFERENCES users(id), due_date date, status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','doing','done','skipped')),
 comment text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS steps_order ON production_steps(order_id);
CREATE TABLE IF NOT EXISTS tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text NOT NULL DEFAULT '', order_id uuid REFERENCES orders(id),
 author_id uuid NOT NULL REFERENCES users(id), assignee_id uuid NOT NULL REFERENCES users(id), due_at timestamptz NOT NULL,
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','doing','waiting','done')), version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id,due_at);
CREATE TABLE IF NOT EXISTS task_comments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES tasks(id), author_id uuid NOT NULL REFERENCES users(id), text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS expenses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders(id), category text NOT NULL,
 supplier text NOT NULL DEFAULT '', amount bigint NOT NULL CHECK(amount>0), incurred_on date NOT NULL,
 notes text NOT NULL DEFAULT '', tax_payment boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT tax_payment OR order_id IS NULL)
);
CREATE INDEX IF NOT EXISTS expenses_order ON expenses(order_id);
CREATE INDEX IF NOT EXISTS expenses_date ON expenses(incurred_on);
CREATE TABLE IF NOT EXISTS money_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('receipt','refund','expense_payment')),
 order_id uuid REFERENCES orders(id), expense_id uuid REFERENCES expenses(id), amount bigint NOT NULL CHECK(amount>0),
 occurred_on date NOT NULL, method text NOT NULL DEFAULT 'Перевод', account text NOT NULL DEFAULT 'Расчётный счёт',
 status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('draft','confirmed')), note text NOT NULL DEFAULT '',
 author_id uuid NOT NULL REFERENCES users(id), idempotency_key uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind IN ('receipt','refund') AND order_id IS NOT NULL AND expense_id IS NULL) OR (kind='expense_payment' AND expense_id IS NOT NULL AND order_id IS NULL))
);
CREATE INDEX IF NOT EXISTS movements_order ON money_movements(order_id);
CREATE INDEX IF NOT EXISTS movements_expense ON money_movements(expense_id);
CREATE INDEX IF NOT EXISTS movements_date ON money_movements(occurred_on,status);
CREATE TABLE IF NOT EXISTS file_blobs (storage_key text PRIMARY KEY,size integer NOT NULL CHECK(size>0),mime text NOT NULL,sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), category text NOT NULL,
 visibility text NOT NULL CHECK(visibility IN ('commercial','financial','technical')), comment text NOT NULL DEFAULT '',
 current_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_order ON documents(order_id);
CREATE TABLE IF NOT EXISTS document_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES documents(id), version integer NOT NULL,
 name text NOT NULL, storage_key text NOT NULL UNIQUE, mime text NOT NULL, size integer NOT NULL, sha256 text NOT NULL,
 author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(document_id,version)
);
CREATE TABLE IF NOT EXISTS tax_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), period text NOT NULL, base_amount bigint NOT NULL, rate_bps integer NOT NULL,
 calculated_amount bigint NOT NULL CHECK(calculated_amount>=0), adjustment bigint NOT NULL DEFAULT 0, reason text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','paid')), payment_id uuid UNIQUE REFERENCES money_movements(id), author_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(period)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id bigserial PRIMARY KEY, entity text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
 author_id uuid REFERENCES users(id), before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_events(entity,entity_id,created_at);
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_events are append-only'; END $$;
DROP TRIGGER IF EXISTS audit_immutable ON audit_events;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TABLE IF NOT EXISTS import_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_hash text NOT NULL, file_name text NOT NULL, kind text NOT NULL,
 sheet text NOT NULL, mapping jsonb NOT NULL, source_key text NOT NULL, status text NOT NULL DEFAULT 'preview', author_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS imports_confirmed_hash ON import_jobs(file_hash,kind,sheet) WHERE status='confirmed';
CREATE TABLE IF NOT EXISTS import_rows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES import_jobs(id), row_number integer NOT NULL, data jsonb NOT NULL, error text, result_id text);
CREATE TABLE IF NOT EXISTS import_fingerprints (kind text NOT NULL, fingerprint text NOT NULL, job_id uuid NOT NULL REFERENCES import_jobs(id), PRIMARY KEY(kind,fingerprint));
CREATE TABLE IF NOT EXISTS mutation_keys (key uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), scope text NOT NULL, request_hash text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE VIEW order_totals AS
SELECT o.*, c.name AS client_name,c.phone AS client_phone,c.address AS client_address,
 m.name AS manager_name,w.name AS master_name,
 COALESCE(i.subtotal,0)::bigint - o.discount AS total,COALESCE(i.planned_cost,0)::bigint AS planned_cost,
 COALESCE(e.actual_cost,0)::bigint AS actual_cost,COALESCE(p.paid,0)::bigint AS paid,
 GREATEST(0,COALESCE(i.subtotal,0)-o.discount-COALESCE(p.paid,0))::bigint AS debt,
 GREATEST(0,COALESCE(p.paid,0)-COALESCE(i.subtotal,0)+o.discount)::bigint AS overpayment,
 (COALESCE(i.subtotal,0)-o.discount-COALESCE(e.actual_cost,0))::bigint AS gross_profit
FROM orders o JOIN clients c ON c.id=o.client_id LEFT JOIN users m ON m.id=o.manager_id LEFT JOIN users w ON w.id=o.master_id
LEFT JOIN LATERAL (SELECT SUM(price*quantity) subtotal,SUM(planned_cost*quantity) planned_cost FROM order_items WHERE order_id=o.id) i ON true
LEFT JOIN LATERAL (SELECT SUM(amount) actual_cost FROM expenses WHERE order_id=o.id AND NOT tax_payment) e ON true
LEFT JOIN LATERAL (SELECT SUM(CASE WHEN kind='receipt' THEN amount ELSE -amount END) paid FROM money_movements WHERE order_id=o.id AND status='confirmed') p ON true;
