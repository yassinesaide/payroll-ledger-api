-- Double-entry ledger. Amounts are integers in minor units (cents) to avoid floating-point errors.

CREATE TABLE IF NOT EXISTS accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner       TEXT NOT NULL,
  currency    CHAR(3) NOT NULL,
  -- system accounts (treasury, payout clearing, payout sink) may go negative
  kind        TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer', 'system')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS system_accounts_uq ON accounts(owner, currency) WHERE kind = 'system';

-- One row per account, locked with SELECT ... FOR UPDATE when money moves.
CREATE TABLE IF NOT EXISTS account_balances (
  account_id  UUID PRIMARY KEY REFERENCES accounts(id),
  balance     BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN ('deposit', 'transfer', 'payout_hold', 'payout_settle', 'payout_refund')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every transaction writes entries that sum to zero (debits = credits).
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  amount          BIGINT NOT NULL CHECK (amount <> 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries(account_id);

-- Idempotency: the first request with a key does the work and stores the response
-- in the same database transaction; retries get the stored response back.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  method_path   TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INT,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- PostgreSQL-backed job queue for payouts (workers claim jobs with FOR UPDATE SKIP LOCKED).
CREATE TABLE IF NOT EXISTS payouts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id),
  amount        BIGINT NOT NULL CHECK (amount > 0),
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'paid', 'dead')),
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_run_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payouts_ready_idx ON payouts(status, next_run_at);
