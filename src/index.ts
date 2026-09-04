/**
 * Worker de Cloudflare que expone SoloTodo.cl como servidor MCP.
 *
 * Endpoints:
 *   POST /mcp     — transporte MCP streamable HTTP (JSON-RPC 2.0)
 *   GET  /health  — sonda de estado
 *   GET  /        — descripción legible por humanos
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { McpServer } from './mcp/server.js';
import { RPC_PARSE_ERROR, type JsonRpcResponse } from './mcp/types.js';
import { SolotodoClient } from './solotodo/client.js';
import { TOOLS } from './tools/index.js';
import { authenticate, oauthRoutes, wwwAuthenticateHeader } from './auth/oauth.js';

const SERVER_NAME = 'solotodo-mcp';
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'Servidor MCP sobre los datos públicos de SoloTodo.cl (comparador de precios chileno).',
  '',
  'Flujo recomendado:',
  '1. `listar_categorias` si no conoces el nombre exacto de la categoría.',
  '2. `filtros_categoria` para descubrir qué specs se pueden filtrar y con qué valores.',
  '3. `buscar_productos` con categoría + precio en CLP + specs para obtener candidatos.',
  '4. `historial_precio` antes de recomendar una compra: distingue una oferta real de una inflada.',
  '5. `detalle_producto`, `comparar_productos` y `comentarios_producto` para cerrar la decisión.',
  '',
  'Los precios están en pesos chilenos y corresponden a tiendas que operan en Chile.',
].join('\n');

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION, instructions: INSTRUCTIONS },
  TOOLS,
);

const app = new Hono<{ Bindings: Env }>();

const mcpCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Authorization'],
  exposeHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
  maxAge: 86400,
});

app.use('/mcp', mcpCors);

/**
 * Los endpoints de descubrimiento y de token también necesitan CORS: algunos
 * clientes (claude.ai entre ellos) resuelven la metadata desde el navegador, y sin
 * estas cabeceras el flujo falla en silencio antes de llegar al login.
 *
 * Abrirlos no debilita nada: la metadata es pública por diseño y el canje de token
 * exige el código más el `code_verifier` de PKCE, que el navegador ajeno no tiene.
 */
app.use('/.well-known/*', mcpCors);
app.use('/oauth/*', mcpCors);

// Endpoints de descubrimiento OAuth y del servidor de autorización.
// Van antes que /mcp para que el 401 pueda apuntar a metadata que sí es pública.
app.route('/', oauthRoutes);

/**
 * Todo POST a /mcp exige un Bearer válido. El 401 incluye `WWW-Authenticate` con
 * la URL de la metadata, que es la pista con la que el cliente MCP arranca solo
 * el flujo de autorización.
 */
app.use('/mcp', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();

  const result = await authenticate(c.req.raw, c.env);
  if (result.ok) return next();

  return c.json(
    { error: result.error, error_description: result.description },
    result.status ?? 401,
    { 'WWW-Authenticate': wwwAuthenticateHeader(c.req.raw, result.error, result.description) },
  );
});

app.get('/', (c) =>
  c.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: 'Servidor MCP de SoloTodo.cl: búsqueda de productos, precios, historial y evaluaciones.',
    transport: { type: 'streamable-http', endpoint: '/mcp' },
    authorization: {
      type: 'oauth2',
      metadata: '/.well-known/oauth-protected-resource',
      note: 'POST /mcp requiere un token Bearer emitido por este servidor.',
    },
    tools: TOOLS.map((tool) => tool.name),
    source: 'https://publicapi.solotodo.com',
  }),
);

app.get('/health', (c) => c.json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION }));

app.post('/mcp', async (c) => {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(rpcError(RPC_PARSE_ERROR, 'El cuerpo de la solicitud no es JSON válido'), 400);
  }

  const client = new SolotodoClient({
    baseUrl: c.env.SOLOTODO_API_BASE,
    cacheTtl: intFromEnv(c.env.SOLOTODO_CACHE_TTL, 900),
    timeoutMs: intFromEnv(c.env.SOLOTODO_TIMEOUT_MS, 20_000),
  });
  const ctx = { client };

  // El transporte permite enviar un batch de mensajes en un array.
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return c.json(rpcError(RPC_PARSE_ERROR, 'El batch JSON-RPC no puede estar vacío'), 400);
    }
    const responses = (await Promise.all(payload.map((message) => server.handleMessage(message, ctx)))).filter(
      (response): response is JsonRpcResponse => response !== null,
    );
    // Un batch compuesto solo de notificaciones no lleva cuerpo de respuesta.
    return responses.length === 0 ? c.body(null, 202) : c.json(responses);
  }

  const response = await server.handleMessage(payload, ctx);
  return response === null ? c.body(null, 202) : c.json(response);
});

// Este servidor es stateless: no hay stream servidor->cliente que abrir ni sesión que cerrar.
app.get('/mcp', (c) => c.json(rpcError(-32000, 'Este servidor no soporta SSE; usa POST /mcp'), 405));
app.delete('/mcp', (c) => c.body(null, 405));

app.notFound((c) => c.json({ error: 'No encontrado', endpoints: ['/', '/health', 'POST /mcp'] }, 404));

app.onError((error, c) => {
  console.error('Error no controlado:', error);
  return c.json(rpcError(-32603, 'Error interno del servidor'), 500);
});

function rpcError(code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export default app;
export { app };
