-- Dupla Chave — esquema inicial.
-- O banco é índice/cache. O estado de segurança (membros, threshold, propostas)
-- é sempre relido da Solana antes de qualquer decisão. Nada aqui é segredo:
-- só chaves públicas, assinaturas e dados de operação.

CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  policy      jsonb NOT NULL,
  created_at  bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  public_key  text NOT NULL,
  created_at  bigint NOT NULL,
  revoked_at  bigint
);

CREATE TABLE IF NOT EXISTS smart_accounts (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  cluster     text NOT NULL,
  multisig    text NOT NULL UNIQUE,
  vault       text NOT NULL,
  roles       jsonb NOT NULL,   -- papéis esperados (cache); a chain é a verdade
  frozen_by   text,             -- rotação em andamento
  created_at  bigint NOT NULL
);

-- Só material público. permissions = máscara do Squads (1 Initiate, 2 Vote, 4 Execute).
CREATE TABLE IF NOT EXISTS members (
  account_id  text NOT NULL REFERENCES smart_accounts(id),
  public_key  text NOT NULL,
  role        text NOT NULL CHECK (role IN ('CLIENT','SERVER','EXECUTOR','PROPOSER')),
  permissions smallint NOT NULL,
  status      text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  device_id   text,
  created_at  bigint NOT NULL,
  revoked_at  bigint,
  PRIMARY KEY (account_id, public_key)
);
CREATE INDEX IF NOT EXISTS members_public_key ON members(public_key);

-- INVARIANTE 6: chave revogada nunca volta a ser ativa.
CREATE OR REPLACE FUNCTION members_no_unrevoke() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'chave revogada não volta a ser ativa: %', OLD.public_key;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS members_no_unrevoke ON members;
CREATE TRIGGER members_no_unrevoke BEFORE UPDATE ON members FOR EACH ROW EXECUTE FUNCTION members_no_unrevoke();

CREATE TABLE IF NOT EXISTS transaction_intents (
  id                 text PRIMARY KEY,
  account_id         text NOT NULL REFERENCES smart_accounts(id),
  kind               text NOT NULL,
  type               text NOT NULL,
  transaction_index  text NOT NULL,
  intent             jsonb NOT NULL,
  intent_hash        text NOT NULL,
  transaction_hash   text NOT NULL,
  status             text NOT NULL,
  risk_flags         jsonb NOT NULL,
  reasons            jsonb NOT NULL,
  signatures         jsonb NOT NULL,
  updated_at         bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS intents_account ON transaction_intents(account_id, updated_at);
ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS prepared jsonb;

-- Espelho do que foi criado no programa (endereço e hash da conta on-chain).
-- O status da proposta NÃO é guardado: é sempre lido da chain.
CREATE TABLE IF NOT EXISTS squads_transactions (
  account_id         text NOT NULL REFERENCES smart_accounts(id),
  multisig           text NOT NULL,
  transaction_index  text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('VAULT','CONFIG')),
  address            text NOT NULL,
  hash               text NOT NULL,
  intent_id          text NOT NULL,
  create_signature   text NOT NULL,
  created_at         bigint NOT NULL,
  PRIMARY KEY (multisig, transaction_index)
);

-- Evidência: cada decisão assinada (declaração + assinatura), nunca chave privada.
CREATE TABLE IF NOT EXISTS approvals (
  id            text PRIMARY KEY,
  intent_id     text NOT NULL,
  account_id    text NOT NULL,
  public_key    text NOT NULL,
  role          text NOT NULL,
  decision      text NOT NULL,
  statement     jsonb NOT NULL,
  tx_signature  text,
  created_at    bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS key_rotations (
  id               text PRIMARY KEY,
  account_id       text NOT NULL REFERENCES smart_accounts(id),
  role             text NOT NULL CHECK (role IN ('CLIENT','SERVER')),
  old_key          text NOT NULL,
  new_key          text,
  new_device_name  text,
  status           text NOT NULL,
  challenge        text NOT NULL,
  created_at       bigint NOT NULL,
  expires_at       bigint NOT NULL,
  intent_id        text,
  possession       jsonb,
  history          jsonb NOT NULL
);

ALTER TABLE key_rotations ADD COLUMN IF NOT EXISTS possession jsonb;

CREATE TABLE IF NOT EXISTS consumed_nonces (
  scope       text NOT NULL,
  nonce       text NOT NULL,
  expires_at  bigint NOT NULL,
  PRIMARY KEY (scope, nonce)
);

CREATE TABLE IF NOT EXISTS challenges (
  id          text PRIMARY KEY,
  purpose     text NOT NULL,
  subject     text NOT NULL,
  challenge   text NOT NULL,
  expires_at  bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS security_events (
  id          text PRIMARY KEY,
  account_id  text,
  code        text NOT NULL,
  message     text NOT NULL,
  at          bigint NOT NULL
);

-- Auditoria: só inserção, encadeada por hash (prev_hash → hash).
CREATE TABLE IF NOT EXISTS audit_log (
  seq                bigint PRIMARY KEY,
  at                 bigint NOT NULL,
  type               text NOT NULL,
  account_id         text,
  user_id            text,
  device_id          text,
  public_key         text,
  multisig           text,
  transaction_index  text,
  proposal           text,
  intent_id          text,
  intent_hash        text,
  tx_signature       text,
  details            jsonb NOT NULL,
  prev_hash          text NOT NULL,
  hash               text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS audit_account ON audit_log(account_id, seq);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log é só inserção';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
