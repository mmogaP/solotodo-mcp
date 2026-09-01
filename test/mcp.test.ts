import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { TOOLS } from '../src/tools/index.js';
import { makeTestEnv } from './fake-d1.js';
import { completeFlow, ORIGIN } from './oauth-helper.js';

// /mcp exige OAuth, así que estas pruebas corren con un token real obtenido
// mediante el flujo completo. La autorización en sí se cubre en oauth.test.ts.
const { env: ENV } = makeTestEnv();
let TOKEN = '';

beforeAll(async () => {
  TOKEN = (await completeFlow(ENV)).accessToken;
});

async function rpc(body: unknown): Promise<{ status: number; json: any }> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
    ENV,
  );
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

describe('transporte MCP', () => {
  it('responde initialize con capacidades y versión de protocolo', async () => {
    const { status, json } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });

    expect(status).toBe(200);
    expect(json.result.protocolVersion).toBe('2025-06-18');
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.serverInfo.name).toBe('solotodo-mcp');
    expect(json.result.instructions).toContain('SoloTodo');
  });

  it('negocia a su versión más nueva si el cliente pide una desconocida', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(json.result.protocolVersion).toBe('2025-06-18');
  });

  it('lista todas las herramientas con un inputSchema de tipo objeto', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = json.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toEqual(TOOLS.map((tool) => tool.name));
    for (const tool of json.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.$schema).toBeUndefined();
    }
  });

  it('expone en el schema los filtros que documenta la descripción', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const buscar = json.result.tools.find((tool: { name: string }) => tool.name === 'buscar_productos');
    expect(Object.keys(buscar.inputSchema.properties)).toEqual(
      expect.arrayContaining(['categoria', 'busqueda', 'precio_max_clp', 'specs', 'tiendas', 'ordenar_por']),
    );
    expect(buscar.inputSchema.required).toEqual(['categoria']);
  });

  it('responde ping', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 4, method: 'ping' });
    expect(json.result).toEqual({});
  });

  it('devuelve 202 sin cuerpo para notificaciones', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(status).toBe(202);
    expect(json).toBeNull();
  });

  it('responde method not found con el código JSON-RPC correcto', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    expect(json.error.code).toBe(-32601);
  });

  it('rechaza mensajes sin jsonrpc 2.0', async () => {
    const { json } = await rpc({ id: 6, method: 'ping' });
    expect(json.error.code).toBe(-32600);
  });

  it('procesa batches y omite las notificaciones de la respuesta', async () => {
    const { json } = await rpc([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
    ]);
    expect(Array.isArray(json)).toBe(true);
    expect(json.map((entry: { id: string }) => entry.id)).toEqual(['a', 'b']);
  });

  it('devuelve parse error ante un cuerpo no JSON', async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: 'no soy json',
      }),
      ENV,
    );
    expect(response.status).toBe(400);
    expect((await response.json<{ error: { code: number } }>()).error.code).toBe(-32700);
  });

  it('reporta argumentos inválidos como isError, no como error de protocolo', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'detalle_producto', arguments: { producto_id: 'no-es-un-numero' } },
    });
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain('producto_id');
  });

  it('informa las herramientas disponibles cuando se llama a una inexistente', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'no_existe', arguments: {} },
    });
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain('buscar_productos');
  });
});

describe('endpoints HTTP', () => {
  it('/health responde ok', async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/health`), ENV);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', server: 'solotodo-mcp' });
  });

  it('/ describe el transporte y las herramientas', async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/`), ENV);
    const body = await response.json<{ transport: { endpoint: string }; tools: string[] }>();
    expect(body.transport.endpoint).toBe('/mcp');
    expect(body.tools).toContain('historial_precio');
  });

  it('GET /mcp exige token igual que POST', async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/mcp`), ENV);
    expect(response.status).toBe(401);
  });

  it('GET /mcp autenticado responde 405 porque el servidor es stateless', async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      ENV,
    );
    expect(response.status).toBe(405);
  });

  it('responde el preflight CORS', async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://claude.ai', 'Access-Control-Request-Method': 'POST' },
      }),
      ENV,
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
