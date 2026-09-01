import { z } from 'zod';
import { defineTool, text, type ToolResult } from '../mcp/types.js';
import { getProduct, getRatings } from '../solotodo/api.js';
import type { Rating } from '../solotodo/types.js';
import { formatDate, markdownTable, truncate } from '../lib/format.js';
import { storeNames } from './shared.js';

export const comentariosProducto = defineTool({
  name: 'comentarios_producto',
  title: 'Ver evaluaciones y comentarios de compradores',
  description:
    'Devuelve las evaluaciones que dejaron compradores reales sobre un producto en SoloTodo: nota promedio del ' +
    'producto, nota promedio de la experiencia de compra por tienda y los comentarios escritos. Útil para ' +
    'detectar fallas recurrentes o tiendas con mal servicio antes de comprar.',
  inputSchema: z.object({
    producto_id: z.number().int().positive().describe('Id del producto en SoloTodo.'),
    limite: z.number().int().min(1).max(50).default(15).describe('Máximo de comentarios a devolver (1-50).'),
    solo_con_texto: z
      .boolean()
      .default(false)
      .describe('Devolver solo evaluaciones que incluyan un comentario escrito.'),
  }),

  async handler(args, ctx): Promise<ToolResult> {
    const [product, ratings, stores] = await Promise.all([
      getProduct(ctx.client, args.producto_id),
      getRatings(ctx.client, args.producto_id, { pageSize: Math.max(args.limite, 20) }),
      storeNames(ctx.client),
    ]);

    const all = ratings.results;
    const sections: string[] = [`# Evaluaciones — ${product.name}`];

    if (all.length === 0) {
      sections.push(
        'Este producto todavía no tiene evaluaciones en SoloTodo. Los productos de nicho o recién listados ' +
          'suelen no tener; considera revisar el historial de precios y las specs para decidir.',
      );
      return text(sections.join('\n\n'));
    }

    sections.push(
      `**${ratings.count} evaluaciones** · Nota del producto: **${average(all, (r) => r.product_rating)}/5** · ` +
        `Nota de las tiendas: **${average(all, (r) => r.store_rating)}/5**`,
    );

    const byStore = groupByStore(all);
    if (byStore.length > 1) {
      sections.push(
        '## Por tienda',
        markdownTable(
          ['Tienda', 'Evaluaciones', 'Nota producto', 'Nota tienda'],
          byStore.map((group) => [
            stores.get(group.storeId) ?? `tienda ${group.storeId}`,
            String(group.ratings.length),
            `${average(group.ratings, (r) => r.product_rating)}/5`,
            `${average(group.ratings, (r) => r.store_rating)}/5`,
          ]),
        ),
      );
    }

    const withText = all.filter((r) => r.product_comments.trim() !== '' || r.store_comments.trim() !== '');
    const selected = (args.solo_con_texto ? withText : all).slice(0, args.limite);

    if (selected.length === 0) {
      sections.push('Hay evaluaciones con nota, pero ninguna incluye comentario escrito.');
      return text(sections.join('\n\n'));
    }

    const comments = selected
      .map((rating) => {
        const store = stores.get(rating.store_id) ?? `tienda ${rating.store_id}`;
        const head = `- **${formatDate(rating.creation_date)}** · ${store} · producto ${rating.product_rating}/5 · tienda ${rating.store_rating}/5`;
        const body: string[] = [];
        if (rating.product_comments.trim()) body.push(`  - Producto: ${truncate(rating.product_comments, 400)}`);
        if (rating.store_comments.trim()) body.push(`  - Compra: ${truncate(rating.store_comments, 400)}`);
        return [head, ...body].join('\n');
      })
      .join('\n');

    sections.push(`## Comentarios (${selected.length} de ${ratings.count})`, comments);
    return text(sections.join('\n\n'));
  },
});

function average(ratings: readonly Rating[], pick: (rating: Rating) => number): string {
  const values = ratings.map(pick).filter((value) => Number.isFinite(value));
  if (values.length === 0) return '—';
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return mean.toFixed(1);
}

function groupByStore(ratings: readonly Rating[]): { storeId: number; ratings: Rating[] }[] {
  const map = new Map<number, Rating[]>();
  for (const rating of ratings) {
    const list = map.get(rating.store_id) ?? [];
    list.push(rating);
    map.set(rating.store_id, list);
  }
  return [...map.entries()]
    .map(([storeId, group]) => ({ storeId, ratings: group }))
    .sort((a, b) => b.ratings.length - a.ratings.length);
}
