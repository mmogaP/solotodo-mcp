import type { SolotodoClient } from './client.js';
import type { Category } from './types.js';
import { rankMatches, suggest } from '../lib/text.js';

export async function listCategories(client: SolotodoClient): Promise<Category[]> {
  const raw = await client.get<Category[]>('/categories/');
  return raw
    .map((c) => ({ id: c.id, name: c.name, slug: c.slug }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export type CategoryResolution =
  | { ok: true; category: Category; alternatives: Category[] }
  | { ok: false; suggestions: string[] };

/**
 * Resuelve una categoría desde lo que escriba el agente: id numérico, slug o nombre
 * aproximado ("notebooks", "Notebook", "1"). Devuelve alternativas cuando hay empate,
 * para que la herramienta pueda pedir desambiguación en vez de adivinar.
 */
export async function resolveCategory(client: SolotodoClient, query: string | number): Promise<CategoryResolution> {
  const categories = await listCategories(client);

  if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
    const id = Number(query);
    const found = categories.find((c) => c.id === id);
    if (found) return { ok: true, category: found, alternatives: [] };
    return { ok: false, suggestions: suggest(String(query), categories, (c) => c.name) };
  }

  const text = String(query).trim();
  const ranked = rankMatches(text, categories, (c) => `${c.name} ${c.slug}`);
  const best = ranked[0];
  if (!best) return { ok: false, suggestions: suggest(text, categories, (c) => c.name) };

  // Empate: varios candidatos con el mismo score máximo.
  const tied = ranked.filter((entry) => entry.score === best.score).map((entry) => entry.item);
  return {
    ok: true,
    category: best.item,
    alternatives: tied.length > 1 ? tied.slice(1, 6) : ranked.slice(1, 4).map((entry) => entry.item),
  };
}
