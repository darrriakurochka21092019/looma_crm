ALTER TABLE clients ADD COLUMN IF NOT EXISTS document_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS document_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS photo_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS generated_kind text
  CHECK(generated_kind IN ('contract','appendix','proposal','invoice'));
CREATE UNIQUE INDEX IF NOT EXISTS documents_generated_kind
  ON documents(order_id,generated_kind) WHERE generated_kind IS NOT NULL;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS generation_data jsonb;
