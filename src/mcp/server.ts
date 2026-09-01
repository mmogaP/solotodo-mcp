/**
 * Dispatcher MCP sin estado sobre JSON-RPC 2.0.
 *
 * El transporte es streamable HTTP en su modo más simple: cada POST /mcp trae uno
 * o más mensajes y se responde con JSON. No abrimos stream SSE ni emitimos
 * Mcp-Session-Id porque ninguna herramienta necesita estado entre llamadas — eso
 * mantiene el Worker stateless y sin Durable Objects.
 */
import { z } from 'zod';
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from './types.js';
import { SolotodoApiError } from '../solotodo/client.js';

/** Versiones del protocolo que sabemos hablar, de la más nueva a la más vieja. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface ServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

export class McpServer {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly info: ServerInfo,
    tools: readonly ToolDefinition[],
  ) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Herramienta duplicada: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Procesa un mensaje JSON-RPC. Devuelve `null` para notificaciones
   * (mensajes sin `id`), que por spec no llevan respuesta.
   */
  async handleMessage(message: unknown, ctx: ToolContext): Promise<JsonRpcResponse | null> {
    if (typeof message !== 'object' || message === null) {
      return errorResponse(null, RPC_INVALID_REQUEST, 'El mensaje debe ser un objeto JSON-RPC');
    }

    const request = message as JsonRpcRequest;
    const id = request.id ?? null;
    const isNotification = request.id === undefined || request.id === null;

    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return isNotification ? null : errorResponse(id, RPC_INVALID_REQUEST, 'Falta "jsonrpc": "2.0" o "method"');
    }

    try {
      const result = await this.dispatch(request.method, request.params, ctx);
      if (result === SKIP) return null;
      return isNotification ? null : { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (isNotification) return null;
      if (error instanceof RpcError) return errorResponse(id, error.code, error.message, error.data);
      const detail = error instanceof Error ? error.message : String(error);
      return errorResponse(id, RPC_INTERNAL_ERROR, `Error interno del servidor: ${detail}`);
    }
  }

  private async dispatch(method: string, params: unknown, ctx: ToolContext): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params);

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: this.listTools() };

      case 'tools/call':
        return this.callTool(params, ctx);

      // Notificaciones del cliente: se aceptan y se ignoran.
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
      case 'notifications/roots/list_changed':
        return SKIP;

      default:
        throw new RpcError(RPC_METHOD_NOT_FOUND, `Método no soportado: ${method}`);
    }
  }

  private initialize(params: unknown): unknown {
    const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
    // Si el cliente pide una versión que conocemos la respetamos; si no, ofrecemos la nuestra.
    const protocolVersion =
      requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;

    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.info.name, version: this.info.version },
      ...(this.info.instructions ? { instructions: this.info.instructions } : {}),
    };
  }

  listTools(): unknown[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toJsonSchema(tool.inputSchema),
      annotations: { title: tool.title, readOnlyHint: true, openWorldHint: true, ...tool.annotations },
    }));
  }

  private async callTool(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof name !== 'string') {
      throw new RpcError(RPC_INVALID_PARAMS, 'Falta el parámetro "name" en tools/call');
    }

    const tool = this.tools.get(name);
    if (!tool) {
      const available = [...this.tools.keys()].join(', ');
      throw new RpcError(RPC_INVALID_PARAMS, `Herramienta desconocida: ${name}. Disponibles: ${available}`);
    }

    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      // Argumentos inválidos se devuelven como resultado de error, no como error de
      // protocolo: así el agente ve el detalle y puede corregir la llamada.
      return {
        content: [{ type: 'text', text: `Argumentos inválidos para \`${name}\`:\n${formatZodError(parsed.error)}` }],
        isError: true,
      };
    }

    try {
      return await tool.handler(parsed.data, ctx);
    } catch (error) {
      return { content: [{ type: 'text', text: describeToolError(name, error) }], isError: true };
    }
  }
}

/** Marca interna: método manejado que no produce respuesta. */
const SKIP = Symbol('skip') as unknown as never;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function errorResponse(id: JsonRpcResponse['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete generated['$schema'];
  // Los clientes MCP esperan siempre un objeto en inputSchema.
  if (generated['type'] !== 'object') return { type: 'object', properties: {} };
  return generated;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(raíz)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
}

/** Mensajes de error accionables: distinguimos fallas del upstream de bugs nuestros. */
function describeToolError(toolName: string, error: unknown): string {
  if (error instanceof SolotodoApiError) {
    if (error.status === 0) {
      return `No se pudo contactar la API de SoloTodo al ejecutar \`${toolName}\`. ${error.message} Reintenta en unos segundos.`;
    }
    if (error.status === 404) {
      return `La API de SoloTodo no encontró el recurso solicitado por \`${toolName}\` (404). Verifica los ids.`;
    }
    if (error.status === 429) {
      return `La API de SoloTodo está limitando las consultas (429). Espera unos segundos antes de reintentar \`${toolName}\`.`;
    }
    const body = error.body ? `\nDetalle: ${stripHtml(error.body)}` : '';
    return `La API de SoloTodo devolvió un error ${error.status} en \`${toolName}\`.${body}`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `\`${toolName}\` falló: ${detail}`;
}

/** Los errores de validación de SoloTodo vienen como HTML de Django. */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}
