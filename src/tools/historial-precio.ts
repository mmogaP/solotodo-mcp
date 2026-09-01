import { z } from 'zod';
import { defineTool, text, type ToolResult } from '../mcp/types.js';
import { getPricingHistory, getProduct } from '../solotodo/api.js';
import type { PricingHistoryGroup } from '../solotodo/types.js';
import { analyzePriceHistory, verdictLabel, type PriceAnalysis, type PriceSample } from '../lib/price-analysis.js';
import { formatCLP, formatDate, markdownTable } from '../lib/format.js';
import { resolveStores, storeNames } from './shared.js';

export const historialPrecio = defineTool({
  name: 'historial_precio',
  title: 'Historial de precios y detección de ofertas infladas',
  description:
    'Analiza el historial de precios de un producto por tienda para responder si conviene comprar ahora. ' +
    'Entrega mínimo, máximo y precio habitual del período, y detecta ofertas infladas (cuando la tienda sube ' +
    'el precio normal para exhibir un descuento mayor sobre una referencia artificial).',
  inputSchema: z.object({
    producto_id: z.number().int().positive().describe('Id del producto en SoloTodo.'),
    dias: z.number().int().min(7).max(365).default(90).describe('Ventana de análisis en días (7-365).'),
    tiendas: z
      .array(z.string())
      .optional()
      .describe('Limitar el análisis a estas tiendas por nombre. Por defecto analiza todas.'),
    limite_tiendas: z.number().int().min(1).max(20).default(8).describe('Máximo de tiendas a mostrar.'),
  }),

  async handler(args, ctx): Promise<ToolResult> {
    const since = new Date(Date.now() - args.dias * 24 * 60 * 60 * 1000);

    const [product, history, stores] = await Promise.all([
      getProduct(ctx.client, args.producto_id),
      getPricingHistory(ctx.client, args.producto_id, since),
      storeNames(ctx.client),
    ]);

    let groups = history;
    const notes: string[] = [];

    if (args.tiendas && args.tiendas.length > 0) {
      const resolved = await resolveStores(ctx.client, args.tiendas);
      if (resolved.ids.length > 0) {
        const wanted = new Set(resolved.ids);
        groups = groups.filter((group) => wanted.has(group.entity.store_id));
        notes.push(`Limitado a: ${resolved.matched.join(', ')}.`);
      }
      for (const miss of resolved.unmatched) {
        notes.push(
          `No encontré la tienda "${miss.value}"${miss.suggestions.length > 0 ? ` (¿${miss.suggestions.join(', ')}?)` : ''}.`,
        );
      }
    }

    const analyses = groups
      .map((group) => ({ group, analysis: analyzePriceHistory(toSamples(group)) }))
      .filter((row) => row.analysis.samples > 0)
      .sort((a, b) => (a.analysis.current ?? Infinity) - (b.analysis.current ?? Infinity));

    const sections: string[] = [
      `# Historial de precios — ${product.name}`,
      `Período analizado: últimos ${args.dias} días (desde ${formatDate(since.toISOString())}).`,
    ];
    if (notes.length > 0) sections.push(`> ${notes.join(' ')}`);

    if (analyses.length === 0) {
      sections.push('No hay historial de precios con stock para este producto en el período consultado.');
      return text(sections.join('\n\n'));
    }

    const shown = analyses.slice(0, args.limite_tiendas);
    sections.push(overallSummary(analyses.map((row) => row.analysis)));

    sections.push(
      markdownTable(
        ['Tienda', 'Precio hoy', 'Mín. período', 'Máx. período', 'Habitual', 'Veredicto'],
        shown.map(({ group, analysis }) => [
          stores.get(group.entity.store_id) ?? `tienda ${group.entity.store_id}`,
          formatCLP(analysis.current),
          formatCLP(analysis.min),
          formatCLP(analysis.max),
          formatCLP(analysis.median),
          verdictLabel(analysis.verdict),
        ]),
      ),
    );

    const details = shown
      .map(({ group, analysis }) => {
        const store = stores.get(group.entity.store_id) ?? `tienda ${group.entity.store_id}`;
        return `- **${store}**: ${analysis.explanation} (${analysis.samples} observaciones)`;
      })
      .join('\n');
    sections.push('## Lectura por tienda', details);

    const inflated = shown.filter((row) => row.analysis.inflatedNormal);
    if (inflated.length > 0) {
      const names = inflated
        .map(({ group }) => stores.get(group.entity.store_id) ?? `tienda ${group.entity.store_id}`)
        .join(', ');
      sections.push(`> ⚠️ **Ofertas infladas detectadas en:** ${names}.`);
    }

    if (analyses.length > shown.length) {
      sections.push(`Se omitieron ${analyses.length - shown.length} tiendas; sube \`limite_tiendas\` para verlas.`);
    }

    return text(sections.join('\n\n'));
  },
});

function toSamples(group: PricingHistoryGroup): PriceSample[] {
  return group.pricing_history.map((registry) => ({
    timestamp: registry.timestamp,
    isAvailable: registry.is_available,
    normalPrice: Number(registry.normal_price),
    offerPrice: Number(registry.offer_price),
  }));
}

/** Conclusión transversal: el mejor precio de hoy contra el mínimo global del período. */
function overallSummary(analyses: readonly PriceAnalysis[]): string {
  const currents = analyses.map((a) => a.current).filter((v): v is number => v !== null);
  const mins = analyses.map((a) => a.min).filter((v): v is number => v !== null);
  if (currents.length === 0 || mins.length === 0) return '';

  const bestNow = Math.min(...currents);
  const bestEver = Math.min(...mins);
  const gap = bestEver > 0 ? Math.round((bestNow / bestEver - 1) * 100) : 0;

  if (gap <= 1) {
    return `**Conclusión:** hoy se consigue a ${formatCLP(bestNow)}, que es el mínimo del período. Buen momento para comprar.`;
  }
  return (
    `**Conclusión:** hoy el mejor precio es ${formatCLP(bestNow)}, un ${gap}% sobre el mínimo del período ` +
    `(${formatCLP(bestEver)}). Si no es urgente, conviene esperar.`
  );
}
