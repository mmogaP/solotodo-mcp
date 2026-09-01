import type { ToolDefinition } from '../mcp/types.js';
import { buscarProductos } from './buscar-productos.js';
import { comentariosProducto } from './comentarios.js';
import { compararProductos } from './comparar.js';
import { detalleProducto } from './detalle-producto.js';
import { filtrosCategoria, listarCategorias } from './categorias.js';
import { historialPrecio } from './historial-precio.js';

/** Orden intencional: primero descubrimiento, luego búsqueda, luego profundización. */
export const TOOLS: ToolDefinition[] = [
  listarCategorias,
  filtrosCategoria,
  buscarProductos,
  detalleProducto,
  historialPrecio,
  compararProductos,
  comentariosProducto,
];
