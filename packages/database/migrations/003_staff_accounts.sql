-- Replace the shared credential with persistent, individually attributable accounts.
CREATE TABLE staff_accounts (
  id uuid PRIMARY KEY,
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9_.-]{3,32}$'),
  role text NOT NULL CHECK (role IN ('admin', 'moderator')),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_accounts_username ON staff_accounts(lower(username));
-- There is exactly one administrator; renaming it must not seed another one.
CREATE UNIQUE INDEX staff_accounts_single_admin ON staff_accounts(role) WHERE role='admin';

ALTER TABLE admin_sessions ADD COLUMN account_id uuid REFERENCES staff_accounts(id) ON DELETE CASCADE;
ALTER TABLE admin_sessions ADD COLUMN credential_version integer;
ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_account_version CHECK (
  (account_id IS NULL AND credential_version IS NULL) OR
  (account_id IS NOT NULL AND credential_version IS NOT NULL AND credential_version > 0)
);
CREATE INDEX admin_sessions_account ON admin_sessions(account_id);
-- Old shared-password sessions cannot carry an individual account identity.
DELETE FROM admin_sessions;

CREATE TABLE staff_account_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES staff_accounts(id),
  account_id uuid NOT NULL REFERENCES staff_accounts(id),
  action text NOT NULL CHECK (action IN ('create', 'update')),
  username text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
-- Credentials and password hashes are deliberately excluded from audit records.
