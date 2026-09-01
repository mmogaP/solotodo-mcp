/**
 * Servidor de autorización OAuth 2.1 para el transporte MCP.
 *
 * Implementa lo que la especificación MCP exige del lado del servidor:
 *   - RFC 9728  metadata del recurso protegido (para que el cliente descubra el AS)
 *   - RFC 8414  metadata del servidor de autorización
 *   - RFC 7591  registro dinámico de clientes
 *   - RFC 7636  PKCE con S256, obligatorio
 *   - RFC 8707  parámetro `resource`, para que el token quede ligado a este servidor
 *
 * Es de un solo usuario: la identidad se prueba con una clave maestra guardada como
 * secreto del Worker. No hay tabla de usuarios porque no hace falta.
 */
import { Hono } from 'hono';
import { AuthStore, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from './store.js';
import { nowSeconds, randomId, randomToken, secureEquals, verifyPkce } from './crypto.js';
import { renderConsentPage, renderErrorPage } from './login-page.js';

export const SCOPE = 'mcp';

interface OAuthEnv {
  Bindings: Env;
}

/** URL canónica del recurso protegido, tal como la anuncia la metadata. */
export function resourceUrl(request: Request): string {
  return new URL('/mcp', new URL(request.url).origin).toString();
}

export function issuerUrl(request: Request): string {
  return new URL(request.url).origin;
}

export const oauthRoutes = new Hono<OAuthEnv>();

// --- Descubrimiento --------------------------------------------------------

/**
 * RFC 9728. Se sirve también en la variante con sufijo de ruta porque los clientes
 * derivan la URL del path del recurso (`/mcp` -> `/.well-known/...​/mcp`).
 */
const protectedResourceMetadata = (c: { req: { raw: Request } }) => ({
  resource: resourceUrl(c.req.raw),
  authorization_servers: [issuerUrl(c.req.raw)],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
});

oauthRoutes.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(c)));
oauthRoutes.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata(c)));

/** RFC 8414. */
const authorizationServerMetadata = (c: { req: { raw: Request } }) => {
  const issuer = issuerUrl(c.req.raw);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    resource_indicators_supported: true,
  };
};

oauthRoutes.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(c)));
oauthRoutes.get('/.well-known/oauth-authorization-server/mcp', (c) => c.json(authorizationServerMetadata(c)));

// --- Registro dinámico de clientes (RFC 7591) ------------------------------

oauthRoutes.post('/oauth/register', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid_client_metadata', error_description: 'El cuerpo debe ser JSON' }, 400);
  }

  const redirectUris = Array.isArray(body['redirect_uris'])
    ? body['redirect_uris'].filter((uri): uri is string => typeof uri === 'string')
    : [];

  if (redirectUris.length === 0) {
    return c.json({ error: 'invalid_redirect_uri', error_description: 'Se requiere al menos un redirect_uri' }, 400);
  }
  for (const uri of redirectUris) {
    if (!isAcceptableRedirectUri(uri)) {
      return c.json(
        { error: 'invalid_redirect_uri', error_description: `redirect_uri no permitido: ${uri}` },
        400,
      );
    }
  }

  const clientName = typeof body['client_name'] === 'string' ? body['client_name'].slice(0, 120) : 'Cliente MCP';
  const clientId = randomId('cli');

  const store = new AuthStore(c.env.DB);
  const client = await store.registerClient(clientName, redirectUris, clientId);

  return c.json(
    {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      client_id_issued_at: client.createdAt,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Cliente público: la seguridad la aporta PKCE, no un secreto compartido.
      token_endpoint_auth_method: 'none',
    },
    201,
  );
});

// --- Autorización ----------------------------------------------------------

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
  scope: string;
}

/** Lee y valida los parámetros comunes a GET y POST de /oauth/authorize. */
function readAuthorizeParams(source: Record<string, string | undefined>):
  | { ok: true; params: AuthorizeParams }
  | { ok: false; error: string; description: string } {
  const clientId = source['client_id'];
  const redirectUri = source['redirect_uri'];
  const responseType = source['response_type'];
  const codeChallenge = source['code_challenge'];
  const codeChallengeMethod = source['code_challenge_method'];

  if (!clientId) return { ok: false, error: 'invalid_request', description: 'Falta client_id' };
  if (!redirectUri) return { ok: false, error: 'invalid_request', description: 'Falta redirect_uri' };
  if (responseType !== 'code') {
    return { ok: false, error: 'unsupported_response_type', description: 'Solo se admite response_type=code' };
  }
  if (!codeChallenge) {
    return { ok: false, error: 'invalid_request', description: 'PKCE es obligatorio: falta code_challenge' };
  }
  if (codeChallengeMethod !== 'S256') {
    return { ok: false, error: 'invalid_request', description: 'Solo se admite code_challenge_method=S256' };
  }

  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      state: source['state'] ?? null,
      codeChallenge,
      resource: source['resource'] ?? null,
      scope: source['scope'] || SCOPE,
    },
  };
}

oauthRoutes.get('/oauth/authorize', async (c) => {
  const query = c.req.query();
  const parsed = readAuthorizeParams(query);
  if (!parsed.ok) {
    return c.html(renderErrorPage('Solicitud inválida', parsed.description), 400);
  }

  const store = new AuthStore(c.env.DB);
  const client = await store.getClient(parsed.params.clientId);
  if (!client) {
    return c.html(renderErrorPage('Cliente desconocido', 'Ese client_id no está registrado.'), 400);
  }
  if (!client.redirectUris.includes(parsed.params.redirectUri)) {
    // Nunca redirigimos a una URI no registrada: sería un open redirect.
    return c.html(
      renderErrorPage('URL de redirección no autorizada', 'La redirect_uri no coincide con las registradas por el cliente.'),
      400,
    );
  }

  return c.html(
    renderConsentPage({
      clientName: client.clientName,
      redirectUri: parsed.params.redirectUri,
      hidden: buildHiddenFields(query),
    }),
  );
});

oauthRoutes.post('/oauth/authorize', async (c) => {
  const form = await c.req.parseBody();
  const fields: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === 'string') fields[key] = value;
  }

  const parsed = readAuthorizeParams(fields);
  if (!parsed.ok) {
    return c.html(renderErrorPage('Solicitud inválida', parsed.description), 400);
  }
  const { params } = parsed;

  const store = new AuthStore(c.env.DB);
  const client = await store.getClient(params.clientId);
  if (!client || !client.redirectUris.includes(params.redirectUri)) {
    return c.html(renderErrorPage('Cliente o redirección inválidos', 'Vuelve a iniciar el flujo desde la aplicación.'), 400);
  }

  const ip = clientIp(c.req.raw);
  const lockout = await store.lockoutRemaining(ip);
  if (lockout > 0) {
    return c.html(
      renderConsentPage({
        clientName: client.clientName,
        redirectUri: params.redirectUri,
        hidden: buildHiddenFields(fields),
        error: `Demasiados intentos fallidos. Vuelve a intentar en ${Math.ceil(lockout / 60)} minutos.`,
      }),
      429,
    );
  }

  const expected = c.env.MCP_AUTH_PASSWORD;
  if (!expected) {
    return c.html(
      renderErrorPage('Servidor sin configurar', 'Falta el secreto MCP_AUTH_PASSWORD en el Worker.'),
      500,
    );
  }

  const supplied = fields['password'] ?? '';
  if (!(await secureEquals(supplied, expected))) {
    await store.recordLoginFailure(ip);
    return c.html(
      renderConsentPage({
        clientName: client.clientName,
        redirectUri: params.redirectUri,
        hidden: buildHiddenFields(fields),
        error: 'Clave incorrecta.',
      }),
      401,
    );
  }

  await store.clearLoginFailures(ip);

  const code = randomToken();
  await store.saveCode(code, {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    resource: params.resource,
    scope: params.scope,
  });

  const target = new URL(params.redirectUri);
  target.searchParams.set('code', code);
  if (params.state !== null) target.searchParams.set('state', params.state);
  return c.redirect(target.toString(), 302);
});

// --- Emisión de tokens -----------------------------------------------------

oauthRoutes.post('/oauth/token', async (c) => {
  const form = await c.req.parseBody();
  const field = (name: string): string | undefined => {
    const value = form[name];
    return typeof value === 'string' ? value : undefined;
  };

  const store = new AuthStore(c.env.DB);
  const grantType = field('grant_type');

  if (grantType === 'authorization_code') {
    const code = field('code');
    const codeVerifier = field('code_verifier');
    const clientId = field('client_id');
    const redirectUri = field('redirect_uri');

    if (!code || !codeVerifier || !clientId) {
      return tokenError(c, 'invalid_request', 'Faltan code, code_verifier o client_id');
    }

    const data = await store.consumeCode(code);
    if (!data) return tokenError(c, 'invalid_grant', 'El código es inválido, ya fue usado o expiró');
    if (data.clientId !== clientId) return tokenError(c, 'invalid_grant', 'El código pertenece a otro cliente');
    if (redirectUri !== undefined && redirectUri !== data.redirectUri) {
      return tokenError(c, 'invalid_grant', 'La redirect_uri no coincide con la de la autorización');
    }
    if (!(await verifyPkce(codeVerifier, data.codeChallenge))) {
      return tokenError(c, 'invalid_grant', 'El code_verifier no corresponde al code_challenge');
    }

    return c.json(await issueTokens(store, data.clientId, data.resource, data.scope));
  }

  if (grantType === 'refresh_token') {
    const refreshToken = field('refresh_token');
    const clientId = field('client_id');
    if (!refreshToken) return tokenError(c, 'invalid_request', 'Falta refresh_token');

    const data = await store.getToken(refreshToken, 'refresh');
    if (!data) return tokenError(c, 'invalid_grant', 'El refresh_token es inválido o expiró');
    if (clientId !== undefined && data.clientId !== clientId) {
      return tokenError(c, 'invalid_grant', 'El refresh_token pertenece a otro cliente');
    }

    // Rotación: el refresh usado se invalida al emitir el nuevo par.
    await store.deleteToken(refreshToken);
    return c.json(await issueTokens(store, data.clientId, data.resource, data.scope));
  }

  return tokenError(c, 'unsupported_grant_type', 'Se admiten authorization_code y refresh_token');
});

oauthRoutes.post('/oauth/revoke', async (c) => {
  const form = await c.req.parseBody();
  const token = form['token'];
  if (typeof token === 'string') {
    await new AuthStore(c.env.DB).deleteToken(token);
  }
  // RFC 7009: responder 200 aunque el token no exista, para no filtrar su validez.
  return c.body(null, 200);
});

async function issueTokens(
  store: AuthStore,
  clientId: string,
  resource: string | null,
  scope: string,
): Promise<Record<string, unknown>> {
  const accessToken = randomToken();
  const refreshToken = randomToken();

  await store.saveToken(accessToken, { clientId, kind: 'access', resource, scope, ttl: ACCESS_TOKEN_TTL });
  await store.saveToken(refreshToken, { clientId, kind: 'refresh', resource, scope, ttl: REFRESH_TOKEN_TTL });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope,
  };
}

function tokenError(
  c: { json: (body: unknown, status: 400) => Response },
  error: string,
  description: string,
): Response {
  return c.json({ error, error_description: description }, 400);
}

// --- Validación del Bearer en /mcp -----------------------------------------

export interface AuthResult {
  ok: boolean;
  status?: 401 | 403;
  error?: string;
  description?: string;
}

/**
 * Valida el token del header. Además de que exista y no haya expirado, comprueba
 * que haya sido emitido para *este* recurso: sin eso, un token robado por otro
 * servidor MCP podría reutilizarse aquí (confused deputy).
 */
export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) {
    return { ok: false, status: 401, error: 'invalid_request', description: 'Falta el header Authorization: Bearer' };
  }

  const store = new AuthStore(env.DB);
  const token = await store.getToken(match[1], 'access');
  if (!token) {
    return { ok: false, status: 401, error: 'invalid_token', description: 'Token inválido o expirado' };
  }

  if (token.resource !== null && !sameResource(token.resource, resourceUrl(request))) {
    return { ok: false, status: 403, error: 'invalid_token', description: 'El token fue emitido para otro recurso' };
  }

  return { ok: true };
}

/** Compara ignorando la barra final, que los clientes agregan de forma inconsistente. */
function sameResource(a: string, b: string): boolean {
  const strip = (value: string) => value.replace(/\/+$/, '').toLowerCase();
  return strip(a) === strip(b);
}

/** Cabecera que le dice al cliente dónde descubrir el servidor de autorización. */
export function wwwAuthenticateHeader(request: Request, error?: string, description?: string): string {
  const metadata = new URL('/.well-known/oauth-protected-resource', issuerUrl(request)).toString();
  const parts = [`Bearer realm="solotodo-mcp"`, `resource_metadata="${metadata}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(', ');
}

// --- Utilidades ------------------------------------------------------------

/** Solo se aceptan redirecciones a localhost (clientes nativos) o HTTPS. */
function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return true;
  return false;
}

/** Reenvía los parámetros del authorize al POST del formulario, sin la clave. */
function buildHiddenFields(source: Record<string, string | undefined>): Record<string, string> {
  const keep = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'desconocida';
}

export { nowSeconds };
