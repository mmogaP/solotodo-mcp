/**
 * D1 en memoria para las pruebas.
 *
 * No es un motor SQL: reconoce exactamente las sentencias que emite `AuthStore` y
 * opera sobre arreglos. Si alguien agrega una consulta nueva sin enseñársela acá,
 * lanza en vez de devolver un resultado silenciosamente equivocado.
 */

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  created_at: number;
  last_used_at: number | null;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  scope: string;
  expires_at: number;
  consumed_at: number | null;
}

interface TokenRow {
  token_hash: string;
  client_id: string;
  kind: 'access' | 'refresh';
  resource: string | null;
  scope: string;
  expires_at: number;
  created_at: number;
}

interface AttemptRow {
  ip: string;
  failures: number;
  locked_until: number | null;
}

export class FakeD1 {
  clients: ClientRow[] = [];
  codes: CodeRow[] = [];
  tokens: TokenRow[] = [];
  attempts: AttemptRow[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql.replace(/\s+/g, ' ').trim());
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const [a, b, c, d, e, f, g] = this.args as string[];

    if (this.sql.startsWith('INSERT INTO oauth_clients')) {
      this.db.clients.push({
        client_id: a!,
        client_name: b!,
        redirect_uris: c!,
        created_at: Number(d),
        last_used_at: null,
      });
      return changes(1);
    }

    if (this.sql.startsWith('INSERT INTO oauth_codes')) {
      this.db.codes.push({
        code_hash: a!,
        client_id: b!,
        redirect_uri: c!,
        code_challenge: d!,
        resource: (e as string | null) ?? null,
        scope: f!,
        expires_at: Number(g),
        consumed_at: null,
      });
      return changes(1);
    }

    if (this.sql.startsWith('UPDATE oauth_codes SET consumed_at')) {
      const [consumedAt, codeHash, now] = this.args as [number, string, number];
      const row = this.db.codes.find(
        (item) => item.code_hash === codeHash && item.consumed_at === null && item.expires_at > now,
      );
      if (!row) return changes(0);
      row.consumed_at = consumedAt;
      return changes(1);
    }

    if (this.sql.startsWith('INSERT INTO oauth_tokens')) {
      this.db.tokens.push({
        token_hash: a!,
        client_id: b!,
        kind: c as 'access' | 'refresh',
        resource: (d as string | null) ?? null,
        scope: e!,
        expires_at: Number(f),
        created_at: Number(g),
      });
      return changes(1);
    }

    if (this.sql === 'DELETE FROM oauth_tokens') {
      const removed = this.db.tokens.length;
      this.db.tokens = [];
      return changes(removed);
    }

    if (this.sql.startsWith('DELETE FROM oauth_tokens WHERE token_hash')) {
      const before = this.db.tokens.length;
      this.db.tokens = this.db.tokens.filter((item) => item.token_hash !== a);
      return changes(before - this.db.tokens.length);
    }

    if (this.sql.startsWith('DELETE FROM oauth_tokens WHERE expires_at')) {
      const cutoff = Number(a);
      const before = this.db.tokens.length;
      this.db.tokens = this.db.tokens.filter((item) => item.expires_at >= cutoff);
      return changes(before - this.db.tokens.length);
    }

    if (this.sql.startsWith('DELETE FROM oauth_codes WHERE expires_at')) {
      const cutoff = Number(a);
      const before = this.db.codes.length;
      this.db.codes = this.db.codes.filter((item) => item.expires_at >= cutoff);
      return changes(before - this.db.codes.length);
    }

    if (this.sql.startsWith('INSERT INTO login_attempts')) {
      const [ip, maxFailures, lockedUntil] = this.args as [string, number, number];
      const existing = this.db.attempts.find((item) => item.ip === ip);
      if (!existing) {
        this.db.attempts.push({ ip, failures: 1, locked_until: null });
        return changes(1);
      }
      existing.failures += 1;
      if (existing.failures >= maxFailures) existing.locked_until = lockedUntil;
      return changes(1);
    }

    if (this.sql.startsWith('DELETE FROM login_attempts')) {
      const before = this.db.attempts.length;
      this.db.attempts = this.db.attempts.filter((item) => item.ip !== a);
      return changes(before - this.db.attempts.length);
    }

    throw new Error(`FakeD1: sentencia no reconocida en run(): ${this.sql}`);
  }

  async first<T>(): Promise<T | null> {
    const [a, b] = this.args as string[];

    if (this.sql.startsWith('SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients')) {
      return (this.db.clients.find((item) => item.client_id === a) as T | undefined) ?? null;
    }

    if (this.sql.startsWith('SELECT client_id, redirect_uri, code_challenge, resource, scope FROM oauth_codes')) {
      return (this.db.codes.find((item) => item.code_hash === a) as T | undefined) ?? null;
    }

    if (this.sql.startsWith('SELECT client_id, kind, resource, scope, expires_at FROM oauth_tokens')) {
      return (this.db.tokens.find((item) => item.token_hash === a && item.kind === b) as T | undefined) ?? null;
    }

    if (this.sql.startsWith('SELECT locked_until FROM login_attempts')) {
      return (this.db.attempts.find((item) => item.ip === a) as T | undefined) ?? null;
    }

    throw new Error(`FakeD1: sentencia no reconocida en first(): ${this.sql}`);
  }
}

function changes(count: number): { meta: { changes: number } } {
  return { meta: { changes: count } };
}

export const TEST_PASSWORD = 'clave-de-prueba-muy-larga-y-secreta';

/** Env de pruebas con D1 falso y la clave maestra fijada. */
export function makeTestEnv(overrides: Record<string, unknown> = {}): { env: Env; db: FakeD1 } {
  const db = new FakeD1();
  const env = {
    DB: db,
    MCP_AUTH_PASSWORD: TEST_PASSWORD,
    SOLOTODO_API_BASE: 'https://publicapi.solotodo.com',
    SOLOTODO_CACHE_TTL: '0',
    SOLOTODO_TIMEOUT_MS: '30000',
    ...overrides,
  } as unknown as Env;
  return { env, db };
}
