-- Per-account and per-role, so a shared PC or a role change cannot consume
-- another employee's introduction. Included in ordinary PostgreSQL backups.
ALTER TABLE users ADD COLUMN IF NOT EXISTS help_progress jsonb NOT NULL DEFAULT '{}';
