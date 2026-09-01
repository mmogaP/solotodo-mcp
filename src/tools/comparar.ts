import { z } from 'zod';
import { defineTool, text, type ToolResult } from '../mcp/types.js';
import { getAvailableEntities, getProduct } from '../solotodo/api.js';
import type { Entity, Product } from '../solotodo/types.js';
import { formatCLP, markdownTable, truncate } from '../lib/format.js';
import { readableSpecs, shortName, storeNames } from './shared.js';

export const compararProductos = defineTool({
  name: 'comparar_productos',
  title: 'Comparar productos lado a lado',
  description:
    'Compara entre 2 y 6 productos en una tabla: mejor precio vigente, tienda más barata y especificaciones ' +
    'técnicas. Por defecto muestra solo las specs en que los productos difieren, que es lo que decide una compra.',
  inputSchema: z.object({
    producto_ids: z
      .array(z.number().int().positive())
      .min(2)
      .max(6)
      .describe('Ids de los productos a comparar (entre 2 y 6).'),
    solo_diferencias: z
      .boolean()
      .default(true)
      .describe('Mostrar solo las specs en que los productos difieren. false muestra todas.'),
    max_specs: z.number().int().min(5).max(80).default(30).describe('Máximo de filas de specs en la tabla.'),
  }),

  async handler(args, ctx): Promise<ToolResult> {
    const ids = [...new Set(args.producto_ids)];
    if (ids.length < 2) {
      return text('Se necesitan al menos 2 productos distintos para comparar.');
    }

    const [products, availability, stores] = await Promise.all([
      Promise.all(ids.map((id) => getProduct(ctx.client, id))),
      getAvailableEntities(ctx.client, ids),
      storeNames(ctx.client),
    ]);

    const bestByProduct = new Map<number, { price: number; entity: Entity } | null>();
    for (const id of ids) {
      const entities = availability.find((row) => row.product.id === id)?.entities ?? [];
      const offers = entities
        .filter((entity) => entity.active_registry?.is_available)
        .map((entity) => ({ entity, price: Number(entity.active_registry?.offer_price ?? NaN) }))
        .filter((row) => Number.isFinite(row.price))
        .sort((a, b) => a.price - b.price);
      bestByProduct.set(id, offers[0] ?? null);
    }

    const columns = products.map((product) => shortName(product));
    const sections: string[] = ['# Comparación'];

    sections.push(
      markdownTable(
        ['', ...columns],
        [
          ['id', ...products.map((p) => String(p.id))],
          [
            'Mejor precio',
            ...products.map((p) => {
              const best = bestByProduct.get(p.id);
              return best ? formatCLP(best.price) : 'Sin stock';
            }),
          ],
          [
            'Tienda',
            ...products.map((p) => {
              const best = bestByProduct.get(p.id);
              return best ? (stores.get(best.entity.store_id) ?? `tienda ${best.entity.store_id}`) : '—';
            }),
          ],
        ],
      ),
    );

    const cheapest = products
      .map((p) => ({ product: p, best: bestByProduct.get(p.id) }))
      .filter((row): row is { product: Product; best: { price: number; entity: Entity } } => row.best != null)
      .sort((a, b) => a.best.price - b.best.price)[0];
    if (cheapest) {
      sections.push(`**Más barato ahora:** ${shortName(cheapest.product)} a ${formatCLP(cheapest.best.price)}.`);
    }

    const specTable = buildSpecTable(products, args.solo_diferencias, args.max_specs);
    if (specTable.rows.length > 0) {
      sections.push(
        `## Especificaciones${args.solo_diferencias ? ' (solo diferencias)' : ''}`,
        markdownTable(['Spec', ...columns], specTable.rows),
      );
      if (specTable.omitted > 0) {
        sections.push(`Se omitieron ${specTable.omitted} specs por el límite \`max_specs\`.`);
      }
    } else {
      sections.push(
        args.solo_diferencias
          ? 'Los productos no presentan diferencias en las specs comparables.'
          : 'No hay specs comparables entre estos productos.',
      );
    }

    return text(sections.join('\n\n'));
  },
});

interface SpecTable {
  rows: string[][];
  omitted: number;
}

/**
 * Cruza las specs de todos los productos. Solo tienen sentido las claves presentes
 * en al menos uno; las ausentes se marcan como "—" en vez de omitir la fila entera,
 * porque "este modelo no trae lector de huella" también es una diferencia relevante.
 */
function buildSpecTable(products: readonly Product[], onlyDifferences: boolean, maxSpecs: number): SpecTable {
  const perProduct = products.map((product) => readableSpecs(product.specs));

  const keys = new Set<string>();
  for (const specs of perProduct) for (const key of specs.keys()) keys.add(key);

  const rows: string[][] = [];
  let omitted = 0;

  for (const key of [...keys].sort()) {
    const values = perProduct.map((specs) => specs.get(key) ?? '—');
    if (onlyDifferences && new Set(values).size === 1) continue;
    if (rows.length >= maxSpecs) {
      omitted += 1;
      continue;
    }
    rows.push([key, ...values.map((value) => truncate(value, 90))]);
  }

  return { rows, omitted };
}
