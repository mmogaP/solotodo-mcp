import { z } from 'zod';
import { defineTool, text, type ToolResult } from '../mcp/types.js';
import { getAvailableEntities, getProduct } from '../solotodo/api.js';
import type { Entity } from '../solotodo/types.js';
import { formatCLP, markdownTable, truncate } from '../lib/format.js';
import { productUrl, readableSpecs, storeNames } from './shared.js';

export const detalleProducto = defineTool({
  name: 'detalle_producto',
  title: 'Ver ficha completa de un producto',
  description:
    'Devuelve la ficha completa de un producto de SoloTodo: especificaciones técnicas y el precio vigente en ' +
    'cada tienda que lo tiene disponible, con el enlace directo a comprar. El id se obtiene de `buscar_productos`.',
  inputSchema: z.object({
    producto_id: z.number().int().positive().describe('Id del producto en SoloTodo.'),
    incluir_specs: z.boolean().default(true).describe('Incluir la tabla completa de especificaciones técnicas.'),
  }),

  async handler(args, ctx): Promise<ToolResult> {
    const [product, availability, stores] = await Promise.all([
      getProduct(ctx.client, args.producto_id),
      getAvailableEntities(ctx.client, [args.producto_id]),
      storeNames(ctx.client),
    ]);

    const entities = availability[0]?.entities ?? [];
    const offers = entities
      .filter((entity) => entity.active_registry?.is_available)
      .map((entity) => ({ entity, price: offerPrice(entity) }))
      .filter((row): row is { entity: Entity; price: number } => row.price !== null)
      .sort((a, b) => a.price - b.price);

    const sections: string[] = [`# ${product.name}`, `Ficha en SoloTodo: ${productUrl(product)}`];

    if (offers.length === 0) {
      sections.push('**Sin stock**: ningún comercio tiene este producto disponible en este momento.');
    } else {
      const best = offers[0];
      const worst = offers[offers.length - 1];
      const spread = best && worst && best.price > 0 ? Math.round((worst.price / best.price - 1) * 100) : 0;
      sections.push(
        `**Mejor precio: ${formatCLP(best?.price)}** en ${storeName(stores, best?.entity)} · ` +
          `${offers.length} tienda${offers.length === 1 ? '' : 's'} con stock` +
          (spread > 0 ? ` · diferencia de ${spread}% entre la más barata y la más cara` : ''),
      );

      sections.push(
        markdownTable(
          ['Tienda', 'Precio oferta', 'Precio normal', 'Enlace'],
          offers.map(({ entity, price }) => {
            const normal = Number(entity.active_registry?.normal_price ?? NaN);
            const showsNormal = Number.isFinite(normal) && normal > price;
            return [
              storeName(stores, entity),
              formatCLP(price),
              showsNormal ? formatCLP(normal) : '—',
              entity.external_url,
            ];
          }),
        ),
      );
      sections.push(
        'El precio oferta suele requerir un medio de pago específico de la tienda. ' +
          'Usa `historial_precio` para verificar si el descuento es real o el precio normal fue inflado.',
      );
    }

    if (args.incluir_specs) {
      const specs = readableSpecs(product.specs);
      if (specs.size > 0) {
        sections.push(
          '## Especificaciones',
          markdownTable(
            ['Spec', 'Valor'],
            [...specs.entries()].map(([key, value]) => [key, truncate(value, 160)]),
          ),
        );
      }
    }

    if (product.description) {
      sections.push('## Descripción', truncate(product.description.replace(/[#*]/g, ''), 900));
    }

    return text(sections.join('\n\n'));
  },
});

function offerPrice(entity: Entity): number | null {
  const value = Number(entity.active_registry?.offer_price ?? NaN);
  return Number.isFinite(value) ? value : null;
}

function storeName(stores: Map<number, string>, entity: Entity | undefined): string {
  if (!entity) return '—';
  return stores.get(entity.store_id) ?? `tienda ${entity.store_id}`;
}

