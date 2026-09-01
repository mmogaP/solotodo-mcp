-- Esquema de autorización OAuth 2.1 del servidor MCP.
--
-- Nada se guarda en claro: códigos y tokens se almacenan como SHA-256, de modo que
-- una filtración de la base no permite suplantar a nadie.
--
-- Aplicar:  npm run db:migrate

-- Clientes registrados dinámicamente (RFC 7591). Claude se registra solo la
-- primera vez que agregas el conector.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  redirect_uris  TEXT NOT NULL,          -- JSON array
  created_at     INTEGER NOT NULL,       -- epoch en segundos
  last_used_at   INTEGER
);

-- Códigos de autorización: un solo uso y vida muy corta.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,         -- PKCE S256, obligatorio
  resource        TEXT,                  -- RFC 8707: recurso al que queda ligado
  scope           TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER                -- distinto de NULL = ya canjeado
);

CREATE INDEX IF NOT EXISTS idx_codes_expires ON oauth_codes (expires_at);

-- Tokens de acceso y refresh. Se revocan borrando la fila.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  resource     TEXT,
  scope        TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tokens_expires ON oauth_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_tokens_client ON oauth_tokens (client_id);

-- Intentos fallidos por IP, para frenar fuerza bruta contra la clave maestra.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);
