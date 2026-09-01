import { z } from 'zod';
import { defineTool, text, type ToolResult } from '../mcp/types.js';
import { BROWSE_ORDERINGS, browse, CLP_CURRENCY_ID } from '../solotodo/api.js';
import { getCategoryFilters, resolveSpecs, type SpecValue } from '../solotodo/filters.js';
import type { BrowseProductEntry } from '../solotodo/types.js';
import type { QueryParams } from '../solotodo/client.js';
import { formatCLP, markdownTable } from '../lib/format.js';
import { clpToUsd, productUrl, requireCategory, resolveStores, shortName } from './shared.js';

const specValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
  z.object({ min: z.union([z.number(), z.string()]).optional(), max: z.union([z.number(), z.string()]).optional() }),
]);

export const buscarProductos = defineTool({
  name: 'buscar_productos',
  title: 'Buscar productos en SoloTodo',
  description:
    'Busca productos en SoloTodo combinando categoría, texto libre, rango de precio en pesos chilenos y filtros ' +
    'de especificaciones técnicas (procesador, RAM, tarjeta de video, almacenamiento, etc.). Devuelve el mejor ' +
    'precio vigente de cada producto entre todas las tiendas. Si no conoces los nombres de los filtros de `specs` ' +
    'para la categoría, llama primero a `filtros_categoria`.',
  inputSchema: z.object({
    categoria: z
      .union([z.string(), z.number()])
      .describe('Nombre, slug o id de la categoría. Obligatorio: los filtros de specs dependen de ella.'),
    busqueda: z
      .string()
      .optional()
      .describe('Texto libre que debe aparecer en el nombre del producto, ej. "RTX 4050" o "MacBook Air".'),
    precio_max_clp: z.number().positive().optional().describe('Precio máximo en pesos chilenos (precio oferta).'),
    precio_min_clp: z.number().positive().optional().describe('Precio mínimo en pesos chilenos (precio oferta).'),
    specs: z
      .record(z.string(), specValue)
      .optional()
      .describe(
        'Filtros de specs de la categoría. Claves según `filtros_categoria`. ' +
          'Ej.: { "ram_quantity": 16, "storage_capacity": 512, "video_cards": ["RTX 4050", "RTX 4060"] }.',
      ),
    tiendas: z
      .array(z.string())
      .optional()
      .describe('Limitar a estas tiendas por nombre, ej. ["PC Factory", "Falabella"]. Por defecto busca en todas.'),
    excluir_reacondicionados: z
      .boolean()
      .default(true)
      .describe('Excluir productos reacondicionados/usados. Por defecto true.'),
    ordenar_por: z
      .enum(BROWSE_ORDERINGS)
      .default('offer_price_usd')
      .describe(
        'offer_price_usd = más barato primero; discount = mayor descuento; relevance = relevancia; leads = más visitados.',
      ),
    limite: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(15)
      .describe(
        'Cantidad de productos a devolver (1-50). Es aproximado: SoloTodo agrupa las variantes de un mismo ' +
          'modelo, así que un resultado puede traer más de una configuración.',
      ),
    pagina: z.number().int().min(1).default(1).describe('Página de resultados, para paginar más allá del límite.'),
  }),

  async handler(args, ctx): Promise<ToolResult> {
    const resolvedCategory = await requireCategory(ctx.client, args.categoria);
    if ('error' in resolvedCategory) return resolvedCategory.error;
    const { category, note } = resolvedCategory;

    const params: QueryParams = {
      page_size: args.limite,
      page: args.pagina,
      ordering: args.ordenar_por,
    };
    const applied: string[] = [];
    const warnings: string[] = [];

    if (args.busqueda) {
      params['search'] = args.busqueda;
      applied.push(`texto: "${args.busqueda}"`);
    }

    // Los filtros de precio de la API son en USD; convertimos desde CLP con el
    // tipo de cambio que publica SoloTodo para que el usuario razone en pesos.
    if (args.precio_max_clp !== undefined) {
      params['offer_price_usd_max'] = (await clpToUsd(ctx.client, args.precio_max_clp)).toFixed(2);
      applied.push(`precio <= ${formatCLP(args.precio_max_clp)}`);
    }
    if (args.precio_min_clp !== undefined) {
      params['offer_price_usd_min'] = (await clpToUsd(ctx.client, args.precio_min_clp)).toFixed(2);
      applied.push(`precio >= ${formatCLP(args.precio_min_clp)}`);
    }

    if (args.excluir_reacondicionados) params['exclude_refurbished'] = true;

    if (args.tiendas && args.tiendas.length > 0) {
      const stores = await resolveStores(ctx.client, args.tiendas);
      if (stores.ids.length > 0) {
        params['stores'] = stores.ids;
        applied.push(`tiendas: ${stores.matched.join(', ')}`);
      }
      for (const miss of stores.unmatched) {
        warnings.push(
          `No encontré la tienda "${miss.value}"${miss.suggestions.length > 0 ? `. ¿Quisiste decir: ${miss.suggestions.join(', ')}?` : '.'}`,
        );
      }
    }

    if (args.specs && Object.keys(args.specs).length > 0) {
      const filters = await getCategoryFilters(ctx.client, category.id);
      const resolution = resolveSpecs(filters, args.specs as Record<string, SpecValue>);
      Object.assign(params, resolution.params);
      applied.push(...resolution.resolved.map((r) => r.applied));
      for (const problem of resolution.problems) {
        warnings.push(
          `Filtro \`${problem.filter}\` con valor "${problem.value}": ${problem.reason}` +
            (problem.suggestions.length > 0 ? ` Opciones cercanas: ${problem.suggestions.join(', ')}.` : ''),
        );
      }
    }

    const response = await browse(ctx.client, category.id, params);
    const entries = response.results.flatMap((bucket) => bucket.product_entries);

    const sections: string[] = [];
    if (note) sections.push(note);
    sections.push(`## ${response.count} productos en **${category.name}**`);
    if (applied.length > 0) sections.push(`**Filtros aplicados:** ${applied.join(' · ')}`);
    if (warnings.length > 0) sections.push(`> ⚠️ ${warnings.join('\n> ')}`);

    if (entries.length === 0) {
      sections.push(
        'Sin resultados. Prueba a relajar el precio máximo, quitar algún filtro de specs o ampliar la búsqueda de texto.',
      );
      return text(sections.join('\n\n'));
    }

    const rows = entries.map((entry) => {
      const offer = clpPrice(entry, 'offer_price');
      const normal = clpPrice(entry, 'normal_price');
      const discount = normal !== null && offer !== null && normal > offer ? Math.round((1 - offer / normal) * 100) : 0;
      return [
        String(entry.product.id),
        shortName(entry.product),
        formatCLP(offer),
        discount > 0 ? `${formatCLP(normal)} (-${discount}%)` : '—',
      ];
    });

    sections.push(
      markdownTable(['id', 'Producto', 'Mejor precio', 'Precio normal'], rows),
      `Mostrando ${entries.length} de ${response.count} (página ${args.pagina}, orden: ${args.ordenar_por}). ` +
        'Usa `detalle_producto` para ver precios por tienda y `historial_precio` para verificar si la oferta es real.',
    );

    if (entries.length > 0) {
      const first = entries[0];
      if (first) sections.push(`Ficha del primero: ${productUrl(first.product)}`);
    }

    return text(sections.join('\n\n'));
  },
});

/** El precio en CLP viene en `prices_per_currency`; `*_usd` es solo para ordenar/filtrar. */
function clpPrice(entry: BrowseProductEntry, field: 'offer_price' | 'normal_price'): number | null {
  const price = entry.metadata.prices_per_currency.find((p) => p.currency_id === CLP_CURRENCY_ID);
  if (!price) return null;
  const value = Number(price[field]);
  return Number.isFinite(value) ? value : null;
}
