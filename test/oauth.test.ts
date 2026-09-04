import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { makeTestEnv, TEST_PASSWORD, type FakeD1 } from './fake-d1.js';
import {
  authorize,
  completeFlow,
  exchangeCode,
  makeCodeVerifier,
  ORIGIN,
  REDIRECT_URI,
  registerClient,
} from './oauth-helper.js';
import { sha256Base64Url } from '../src/auth/crypto.js';

let env: Env;
let db: FakeD1;

beforeEach(() => {
  ({ env, db } = makeTestEnv());
});

async function get(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

describe('descubrimiento', () => {
  it('publica la metadata del recurso protegido (RFC 9728)', async () => {
    const body = await (await get('/.well-known/oauth-protected-resource')).json<any>();
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.authorization_servers).toEqual([ORIGIN]);
  });

  it('también la sirve en la variante con sufijo de ruta que derivan los clientes', async () => {
    expect((await get('/.well-known/oauth-protected-resource/mcp')).status).toBe(200);
  });

  it('publica la metadata del servidor de autorización (RFC 8414)', async () => {
    const body = await (await get('/.well-known/oauth-authorization-server')).json<any>();
    expect(body.issuer).toBe(ORIGIN);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.grant_types_supported).toContain('refresh_token');
  });
});

describe('registro dinámico de clientes', () => {
  it('registra un cliente público y devuelve client_id', async () => {
    const response = await get('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT_URI] }),
    });
    expect(response.status).toBe(201);
    const body = await response.json<any>();
    expect(body.client_id).toMatch(/^cli_/);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(db.clients).toHaveLength(1);
  });

  it('exige al menos un redirect_uri', async () => {
    const response = await get('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'X', redirect_uris: [] }),
    });
    expect(response.status).toBe(400);
  });

  it('rechaza redirecciones http que no sean a localhost', async () => {
    const response = await get('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'X', redirect_uris: ['http://evil.example.com/cb'] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json<any>()).error).toBe('invalid_redirect_uri');
  });
});

describe('autorización', () => {
  it('muestra el consentimiento con el nombre del cliente y la URL de destino', async () => {
    const clientId = await registerClient(env, 'Claude Code');
    const verifier = makeCodeVerifier();
    const url = `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&code_challenge=${await sha256Base64Url(verifier)}&code_challenge_method=S256`;

    const html = await (await get(url)).text();
    expect(html).toContain('Claude Code');
    expect(html).toContain(REDIRECT_URI);
    expect(html).toContain('type="password"');
  });

  it('exige PKCE con S256', async () => {
    const clientId = await registerClient(env);
    const sinPkce = await get(
      `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`,
    );
    expect(sinPkce.status).toBe(400);

    const conPlain = await get(
      `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&code_challenge=abc&code_challenge_method=plain`,
    );
    expect(conPlain.status).toBe(400);
  });

  it('no redirige a una URI no registrada, para no ser un open redirect', async () => {
    const clientId = await registerClient(env);
    const verifier = makeCodeVerifier();
    const response = await get(
      `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}&response_type=code&code_challenge=${await sha256Base64Url(verifier)}&code_challenge_method=S256`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('no autorizada');
  });

  it('emite el código y conserva el state cuando la clave es correcta', async () => {
    const clientId = await registerClient(env);
    const result = await authorize(env, clientId, makeCodeVerifier(), { state: 'xyz-123' });
    expect(result.status).toBe(302);
    expect(result.code).toBeTruthy();
    expect(result.state).toBe('xyz-123');
  });

  it('rechaza la clave incorrecta sin emitir código', async () => {
    const clientId = await registerClient(env);
    const result = await authorize(env, clientId, makeCodeVerifier(), { password: 'incorrecta' });
    expect(result.status).toBe(401);
    expect(result.code).toBeNull();
    expect(db.codes).toHaveLength(0);
  });

  it('bloquea la IP tras varios intentos fallidos', async () => {
    const clientId = await registerClient(env);
    for (let i = 0; i < 5; i += 1) {
      await authorize(env, clientId, makeCodeVerifier(), { password: 'mala' });
    }
    // Sexto intento: bloqueado incluso con la clave correcta.
    const result = await authorize(env, clientId, makeCodeVerifier(), { password: TEST_PASSWORD });
    expect(result.status).toBe(429);
    expect(result.code).toBeNull();
  });
});

describe('canje de tokens', () => {
  it('entrega access y refresh token con un code_verifier correcto', async () => {
    const clientId = await registerClient(env);
    const verifier = makeCodeVerifier();
    const { code } = await authorize(env, clientId, verifier);

    const { status, body } = await exchangeCode(env, { clientId, code: code!, codeVerifier: verifier });
    expect(status).toBe(200);
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.expires_in).toBe(3600);
  });

  it('rechaza un code_verifier que no corresponde al challenge', async () => {
    const clientId = await registerClient(env);
    const { code } = await authorize(env, clientId, makeCodeVerifier());

    const { status, body } = await exchangeCode(env, {
      clientId,
      code: code!,
      codeVerifier: makeCodeVerifier(), // verifier distinto
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('no permite reutilizar un código: el segundo canje falla', async () => {
    const clientId = await registerClient(env);
    const verifier = makeCodeVerifier();
    const { code } = await authorize(env, clientId, verifier);

    expect((await exchangeCode(env, { clientId, code: code!, codeVerifier: verifier })).status).toBe(200);
    const segundo = await exchangeCode(env, { clientId, code: code!, codeVerifier: verifier });
    expect(segundo.status).toBe(400);
    expect(segundo.body.error).toBe('invalid_grant');
  });

  it('rechaza un código emitido para otro cliente', async () => {
    const clientA = await registerClient(env, 'A');
    const clientB = await registerClient(env, 'B');
    const verifier = makeCodeVerifier();
    const { code } = await authorize(env, clientA, verifier);

    const result = await exchangeCode(env, { clientId: clientB, code: code!, codeVerifier: verifier });
    expect(result.status).toBe(400);
  });

  it('rota el refresh token: el usado deja de servir', async () => {
    const session = await completeFlow(env);
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    const renovar = () =>
      app.fetch(
        new Request(`${ORIGIN}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        }),
        env,
      );

    const primera = await renovar();
    expect(primera.status).toBe(200);
    const nuevos = await primera.json<any>();
    expect(nuevos.access_token).not.toBe(session.accessToken);

    // El refresh anterior ya fue rotado.
    expect((await renovar()).status).toBe(400);
  });

  it('rechaza grant types no soportados', async () => {
    const response = await get('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    expect(response.status).toBe(400);
    expect((await response.json<any>()).error).toBe('unsupported_grant_type');
  });
});

describe('protección de /mcp', () => {
  const listTools = (headers: Record<string, string> = {}) =>
    get('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('responde 401 con WWW-Authenticate apuntando a la metadata', async () => {
    const response = await listTools();
    expect(response.status).toBe(401);
    const header = response.headers.get('WWW-Authenticate') ?? '';
    expect(header).toContain('Bearer');
    expect(header).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  });

  it('rechaza un token inventado', async () => {
    expect((await listTools({ Authorization: 'Bearer no-existe' })).status).toBe(401);
  });

  it('acepta un token obtenido por el flujo completo', async () => {
    const session = await completeFlow(env);
    const response = await listTools({ Authorization: `Bearer ${session.accessToken}` });
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.result.tools).toHaveLength(7);
  });

  it('no acepta el refresh token como si fuera de acceso', async () => {
    const session = await completeFlow(env);
    expect((await listTools({ Authorization: `Bearer ${session.refreshToken}` })).status).toBe(401);
  });

  it('rechaza un token emitido para otro recurso (confused deputy)', async () => {
    const session = await completeFlow(env, { resource: 'https://otro-servidor.example.com/mcp' });
    const response = await listTools({ Authorization: `Bearer ${session.accessToken}` });
    expect(response.status).toBe(403);
  });

  it('acepta el token cuando el resource sí corresponde a este servidor', async () => {
    const session = await completeFlow(env, { resource: `${ORIGIN}/mcp` });
    expect((await listTools({ Authorization: `Bearer ${session.accessToken}` })).status).toBe(200);
  });

  it('la revocación invalida el token de inmediato', async () => {
    const session = await completeFlow(env);
    expect((await listTools({ Authorization: `Bearer ${session.accessToken}` })).status).toBe(200);

    await get('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: session.accessToken }).toString(),
    });

    expect((await listTools({ Authorization: `Bearer ${session.accessToken}` })).status).toBe(401);
  });

  it('deja pasar los endpoints públicos sin token', async () => {
    expect((await get('/health')).status).toBe(200);
    expect((await get('/')).status).toBe(200);
    expect((await get('/.well-known/oauth-protected-resource')).status).toBe(200);
  });
});

describe('compatibilidad con clientes de navegador (claude.ai)', () => {
  const withOrigin = (path: string) => get(path, { headers: { Origin: 'https://claude.ai' } });

  it('los endpoints de descubrimiento responden con CORS', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
      const response = await withOrigin(path);
      expect(response.headers.get('Access-Control-Allow-Origin'), path).toBe('*');
    }
  });

  it('el preflight de /oauth/token y /oauth/register pasa', async () => {
    for (const path of ['/oauth/token', '/oauth/register']) {
      const response = await get(path, {
        method: 'OPTIONS',
        headers: { Origin: 'https://claude.ai', 'Access-Control-Request-Method': 'POST' },
      });
      expect(response.headers.get('Access-Control-Allow-Origin'), path).toBe('*');
    }
  });

  it('expone WWW-Authenticate al navegador para que pueda arrancar el flujo', async () => {
    const response = await get('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://claude.ai' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');
  });

  it('acepta el redirect_uri de claude.ai en el registro dinámico', async () => {
    const response = await get('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
    });
    expect(response.status).toBe(201);
    // Sin client_name, se usa un nombre por defecto en vez de fallar.
    expect((await response.json<any>()).client_name).toBeTruthy();
  });
});
