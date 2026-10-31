-- Double Check — estado que vivia em memória passa ao banco; índices das buscas
-- quentes; purga do que vence; fim das tabelas do modelo 2 de 2.

-- "Continuar no celular": o pedido que o QR abre. `poll` é o segredo do computador.
CREATE TABLE IF NOT EXISTS handoffs (
  token       text PRIMARY KEY,
  poll        text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('CONNECT','SIGN_INTENT')),
  label       text NOT NULL,
  subject     text,
  account_id  text,
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL,
  status      text NOT NULL CHECK (status IN ('WAITING','DONE','FAILED','EXPIRED')),
  error       text,
  result      jsonb
);
CREATE INDEX IF NOT EXISTS handoffs_expires ON handoffs(expires_at);

-- Cadastro preparado (a carteira ainda vai assinar e pagar a criação da multisig).
CREATE TABLE IF NOT EXISTS pending_enrollments (
  id          text PRIMARY KEY,
  record      jsonb NOT NULL,
  created_at  bigint NOT NULL
);

-- Busca da chave do webapp pela passkey (entrar com a biometria) sem varrer as contas.
CREATE INDEX IF NOT EXISTS webapp_keys_credential ON webapp_keys(credential_id);

-- Varredura: só contas com algo em aberto.
CREATE INDEX IF NOT EXISTS intents_awaiting ON transaction_intents(account_id) WHERE status = 'AWAITING_CLIENT';
CREATE INDEX IF NOT EXISTS security_changes_open ON security_changes(account_id) WHERE status IN ('PREPARED','PENDING');

-- Purga do que vence.
CREATE INDEX IF NOT EXISTS challenges_expires ON challenges(expires_at);
CREATE INDEX IF NOT EXISTS nonces_expires ON consumed_nonces(expires_at);

-- Modelo 2 de 2: tabelas sem uso no código (produção: 0 e 1 linha legadas).
DROP TABLE IF EXISTS key_rotations;
DROP TABLE IF EXISTS passkeys;
