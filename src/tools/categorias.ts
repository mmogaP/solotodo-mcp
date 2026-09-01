import { z } from 'zod';
import { defineTool, text, type ToolResult } from '../mcp/types.js';
import { listCategories } from '../solotodo/categories.js';
import { describeFilters, getCategoryFilters } from '../solotodo/filters.js';
import { markdownTable } from '../lib/format.js';
import { rankMatches } from '../lib/text.js';
import { requireCategory } from './shared.js';

export const listarCategorias = defineTool({
  name: 'listar_categorias',
  title: 'Listar categorías de SoloTodo',
  description:
    'Lista las categorías de productos disponibles en SoloTodo (Notebooks, Celulares, Televisores, etc.). ' +
    'Úsala cuando no sepas el nombre exacto de una categoría antes de llamar a `buscar_productos`.',
  inputSchema: z.object({
    filtro: z
      .string()
      .optional()
      .describe('Texto opcional para filtrar las categorías por nombre, ej. "note" o "tarjeta".'),
  }),
  async handler(args, ctx): Promise<ToolResult> {
    const categories = await listCategories(ctx.client);
    const filtered = args.filtro
      ? rankMatches(args.filtro, categories, (c) => `${c.name} ${c.slug}`).map((entry) => entry.item)
      : categories;

    if (filtered.length === 0) {
      return text(`No hay categorías que coincidan con "${args.filtro}". Total de categorías: ${categories.length}.`);
    }

    const table = markdownTable(
      ['id', 'Categoría', 'slug'],
      filtered.map((c) => [String(c.id), c.name, c.slug]),
    );
    return text(`**${filtered.length} categorías**\n\n${table}`);
  },
});

export const filtrosCategoria = defineTool({
  name: 'filtros_categoria',
  title: 'Ver filtros de specs de una categoría',
  description:
    'Muestra los filtros de especificaciones disponibles para una categoría y los valores que acepta cada uno ' +
    '(marcas, procesadores, RAM, tarjeta de video, etc.). Llama a esta herramienta antes de usar el parámetro ' +
    '`specs` de `buscar_productos` si no estás seguro de qué filtros existen o cómo se llaman los valores.',
  inputSchema: z.object({
    categoria: z
      .union([z.string(), z.number()])
      .describe('Nombre, slug o id de la categoría, ej. "Notebooks", "notebooks" o 1.'),
    filtro: z
      .string()
      .optional()
      .describe('Nombre de un filtro específico para ver TODOS sus valores posibles, ej. "video_cards".'),
  }),
  async handler(args, ctx): Promise<ToolResult> {
    const resolved = await requireCategory(ctx.client, args.categoria);
    if ('error' in resolved) return resolved.error;
    const { category, note } = resolved;

    const filters = await getCategoryFilters(ctx.client, category.id);
    if (filters.length === 0) {
      return text(`La categoría **${category.name}** (id ${category.id}) no expone filtros de specs.`);
    }

    const header = [note, `## Filtros de specs para **${category.name}** (id ${category.id})`].filter(Boolean).join('\n\n');

    if (args.filtro) {
      const target = rankMatches(args.filtro, filters, (f) => `${f.name} ${f.label}`)[0]?.item;
      if (!target) {
        const names = filters.map((f) => f.name).join(', ');
        return text(`${header}\n\nNo existe el filtro "${args.filtro}". Filtros disponibles: ${names}`);
      }
      const choices = target.choices ?? [];
      const body =
        choices.length > 0
          ? markdownTable(
              ['Valor'],
              choices.map((c) => [c.value ? `${c.name} (${c.value})` : c.name]),
            )
          : `Filtro numérico o booleano, sin lista de valores.${target.continuous_range_unit ? ` Unidad: ${target.continuous_range_unit}.` : ''}`;
      return text(
        `${header}\n\n### \`${target.name}\` — ${target.label} (${target.type})\n\n${choices.length} valores posibles.\n\n${body}`,
      );
    }

    const usage =
      'Uso en `buscar_productos`: `specs: { "ram_quantity": 16, "video_cards": ["RTX 4050"] }`. ' +
      'Los filtros de tipo "mínimo" aceptan un número; los de "rango" aceptan `{ "min": x, "max": y }`; ' +
      'los de "opciones" aceptan un valor o una lista (se combinan con OR).';

    return text(`${header}\n\n${usage}\n\n${describeFilters(filters)}`);
  },
});
