/** Ejecuta el flujo OAuth completo contra la app, tal como lo haría un cliente MCP. */
import app from '../src/index.js';
import { base64UrlEncode, sha256Base64Url } from '../src/auth/crypto.js';
import { TEST_PASSWORD } from './fake-d1.js';

export const ORIGIN = 'https://solotodo-mcp.test';
export const REDIRECT_URI = 'http://localhost:41234/callback';

export interface OAuthSession {
  clientId: string;
  accessToken: string;
  refreshToken: string;
}

/** code_verifier válido según RFC 7636 (43-128 chars del alfabeto unreserved). */
export function makeCodeVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function registerClient(env: Env, clientName = 'Cliente de prueba'): Promise<string> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT_URI] }),
    }),
    env,
  );
  const body = await response.json<{ client_id: string }>();
  return body.client_id;
}

/** Hace login y devuelve el `code` extraído de la redirección. */
export async function authorize(
  env: Env,
  clientId: string,
  codeVerifier: string,
  options: { password?: string; state?: string; resource?: string; redirectUri?: string } = {},
): Promise<{ status: number; code: string | null; state: string | null; location: string | null }> {
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: options.redirectUri ?? REDIRECT_URI,
    response_type: 'code',
    code_challenge: await sha256Base64Url(codeVerifier),
    code_challenge_method: 'S256',
    password: options.password ?? TEST_PASSWORD,
  });
  if (options.state) form.set('state', options.state);
  if (options.resource) form.set('resource', options.resource);

  const response = await app.fetch(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9' },
      body: form.toString(),
      redirect: 'manual',
    }),
    env,
  );

  const location = response.headers.get('Location');
  if (!location) return { status: response.status, code: null, state: null, location: null };
  const url = new URL(location);
  return {
    status: response.status,
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    location,
  };
}

export async function exchangeCode(
  env: Env,
  params: { clientId: string; code: string; codeVerifier: string; redirectUri?: string },
): Promise<{ status: number; body: any }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.codeVerifier,
    client_id: params.clientId,
  });
  if (params.redirectUri !== undefined) form.set('redirect_uri', params.redirectUri);

  const response = await app.fetch(
    new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }),
    env,
  );
  return { status: response.status, body: await response.json() };
}

/** Atajo: registro + autorización + canje, devolviendo tokens listos para usar. */
export async function completeFlow(env: Env, options: { resource?: string } = {}): Promise<OAuthSession> {
  const clientId = await registerClient(env);
  const codeVerifier = makeCodeVerifier();
  const { code } = await authorize(env, clientId, codeVerifier, options);
  if (!code) throw new Error('El flujo de autorización no devolvió un código');
  const { body } = await exchangeCode(env, { clientId, code, codeVerifier });
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
}
