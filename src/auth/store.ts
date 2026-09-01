/** Persistencia del estado OAuth en D1. Todo se guarda hasheado. */
import { nowSeconds, sha256Hex } from './crypto.js';

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string;
}

export interface TokenData {
  clientId: string;
  kind: 'access' | 'refresh';
  resource: string | null;
  scope: string;
  expiresAt: number;
}

/** Duración de cada artefacto, en segundos. */
export const CODE_TTL = 120;
export const ACCESS_TOKEN_TTL = 60 * 60; // 1 hora
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 días

/** Bloqueo por fuerza bruta contra la clave maestra. */
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_SECONDS = 15 * 60;

export class AuthStore {
  constructor(private readonly db: D1Database) {}

  // --- Clientes ----------------------------------------------------------

  async registerClient(clientName: string, redirectUris: string[], clientId: string): Promise<OAuthClient> {
    const createdAt = nowSeconds();
    await this.db
      .prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
      .bind(clientId, clientName, JSON.stringify(redirectUris), createdAt)
      .run();
    return { clientId, clientName, redirectUris, createdAt };
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const row = await this.db
      .prepare('SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients WHERE client_id = ?')
      .bind(clientId)
      .first<{ client_id: string; client_name: string; redirect_uris: string; created_at: number }>();
    if (!row) return null;
    return {
      clientId: row.client_id,
      clientName: row.client_name,
      redirectUris: safeParseArray(row.redirect_uris),
      createdAt: row.created_at,
    };
  }

  // --- Códigos de autorización -------------------------------------------

  async saveCode(code: string, data: AuthCodeData): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await sha256Hex(code),
        data.clientId,
        data.redirectUri,
        data.codeChallenge,
        data.resource,
        data.scope,
        nowSeconds() + CODE_TTL,
      )
      .run();
  }

  /**
   * Canjea un código marcándolo como consumido en la misma sentencia. El UPDATE
   * condicional es lo que garantiza un solo uso incluso con dos canjes simultáneos:
   * el segundo no afecta filas y se rechaza.
   */
  async consumeCode(code: string): Promise<AuthCodeData | null> {
    const hash = await sha256Hex(code);
    const now = nowSeconds();

    const result = await this.db
      .prepare('UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?')
      .bind(now, hash, now)
      .run();

    if (!result.meta.changes) return null;

    const row = await this.db
      .prepare('SELECT client_id, redirect_uri, code_challenge, resource, scope FROM oauth_codes WHERE code_hash = ?')
      .bind(hash)
      .first<{
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string | null;
        scope: string;
      }>();
    if (!row) return null;

    return {
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      resource: row.resource,
      scope: row.scope,
    };
  }

  // --- Tokens -------------------------------------------------------------

  async saveToken(token: string, data: Omit<TokenData, 'expiresAt'> & { ttl: number }): Promise<number> {
    const now = nowSeconds();
    const expiresAt = now + data.ttl;
    await this.db
      .prepare(
        `INSERT INTO oauth_tokens (token_hash, client_id, kind, resource, scope, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(await sha256Hex(token), data.clientId, data.kind, data.resource, data.scope, expiresAt, now)
      .run();
    return expiresAt;
  }

  async getToken(token: string, kind: 'access' | 'refresh'): Promise<TokenData | null> {
    const row = await this.db
      .prepare('SELECT client_id, kind, resource, scope, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = ?')
      .bind(await sha256Hex(token), kind)
      .first<{ client_id: string; kind: 'access' | 'refresh'; resource: string | null; scope: string; expires_at: number }>();
    if (!row) return null;
    if (row.expires_at <= nowSeconds()) return null;
    return {
      clientId: row.client_id,
      kind: row.kind,
      resource: row.resource,
      scope: row.scope,
      expiresAt: row.expires_at,
    };
  }

  async deleteToken(token: string): Promise<void> {
    await this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }

  /** Revoca todo lo emitido. Sirve como botón de pánico. */
  async revokeAll(): Promise<number> {
    const result = await this.db.prepare('DELETE FROM oauth_tokens').run();
    return result.meta.changes ?? 0;
  }

  /** Limpia códigos y tokens vencidos. Se invoca de forma oportunista. */
  async pruneExpired(): Promise<void> {
    const now = nowSeconds();
    await this.db.batch([
      this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now - CODE_TTL),
      this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').bind(now),
    ]);
  }

  // --- Protección de fuerza bruta ----------------------------------------

  /** Segundos restantes de bloqueo, o 0 si la IP puede intentar. */
  async lockoutRemaining(ip: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT locked_until FROM login_attempts WHERE ip = ?')
      .bind(ip)
      .first<{ locked_until: number | null }>();
    if (!row?.locked_until) return 0;
    return Math.max(0, row.locked_until - nowSeconds());
  }

  async recordLoginFailure(ip: string): Promise<void> {
    const now = nowSeconds();
    await this.db
      .prepare(
        `INSERT INTO login_attempts (ip, failures, locked_until) VALUES (?, 1, NULL)
         ON CONFLICT(ip) DO UPDATE SET
           failures = login_attempts.failures + 1,
           locked_until = CASE WHEN login_attempts.failures + 1 >= ? THEN ? ELSE login_attempts.locked_until END`,
      )
      .bind(ip, MAX_LOGIN_FAILURES, now + LOCKOUT_SECONDS)
      .run();
  }

  async clearLoginFailures(ip: string): Promise<void> {
    await this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  }
}

function safeParseArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
