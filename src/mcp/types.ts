/** Tipos JSON-RPC 2.0 y del protocolo MCP usados por el transporte streamable HTTP. */
import type { z } from 'zod';
import type { SolotodoClient } from '../solotodo/client.js';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

/** Códigos estándar JSON-RPC 2.0. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  /** true marca un error *de la herramienta* (el agente lo ve y puede reintentar). */
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ToolContext {
  client: SolotodoClient;
}

/** Pistas de comportamiento para el cliente MCP. Todo aquí es de solo lectura. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  handler: (args: z.output<Schema>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Helper para preservar la inferencia del schema al declarar una herramienta. */
export function defineTool<Schema extends z.ZodType>(definition: ToolDefinition<Schema>): ToolDefinition<z.ZodType> {
  return definition as unknown as ToolDefinition<z.ZodType>;
}

export function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

export function errorText(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }], isError: true };
}
