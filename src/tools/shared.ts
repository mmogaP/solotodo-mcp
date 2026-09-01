/** Helpers compartidos por las herramientas: resolución de categorías/tiendas y armado de specs. */
import type { SolotodoClient } from '../solotodo/client.js';
import { resolveCategory } from '../solotodo/categories.js';
import { getClpPerUsd, listStores } from '../solotodo/api.js';
import type { Category, Product, ProductSpecs } from '../solotodo/types.js';
import { rankMatches, suggest } from '../lib/text.js';
import { errorText, type ToolResult } from '../mcp/types.js';

/** Resuelve la categoría o devuelve un ToolResult de error listo para retornar. */
export async function requireCategory(
  client: SolotodoClient,
  query: string | number,
): Promise<{ category: Category; note: string } | { error: ToolResult }> {
  const resolution = await resolveCategory(client, query);
  if (!resolution.ok) {
    const hint =
      resolution.suggestions.length > 0
        ? ` ¿Quisiste decir: ${resolution.suggestions.join(', ')}?`
        : ' Usa `listar_categorias` para ver las categorías disponibles.';
    return { error: errorText(`No encontré la categoría "${query}".${hint}`) };
  }

  const note =
    resolution.alternatives.length > 0
      ? `Interpreté "${query}" como **${resolution.category.name}**. Otras opciones parecidas: ${resolution.alternatives
          .map((c) => c.name)
          .join(', ')}.`
      : '';
  return { category: resolution.category, note };
}

export interface StoreResolution {
  ids: number[];
  matched: string[];
  unmatched: { value: string; suggestions: string[] }[];
}

/** Traduce nombres de tienda ("PC Factory", "falabella") a ids. */
export async function resolveStores(client: SolotodoClient, names: readonly string[]): Promise<StoreResolution> {
  if (names.length === 0) return { ids: [], matched: [], unmatched: [] };
  const stores = await listStores(client);

  const ids: number[] = [];
  const matched: string[] = [];
  const unmatched: { value: string; suggestions: string[] }[] = [];

  for (const name of names) {
    if (/^\d+$/.test(name.trim())) {
      const id = Number(name.trim());
      const byId = stores.find((s) => s.id === id);
      if (byId) {
        ids.push(byId.id);
        matched.push(byId.name);
        continue;
      }
    }
    const best = rankMatches(name, stores, (s) => s.name)[0]?.item;
    if (!best) {
      unmatched.push({ value: name, suggestions: suggest(name, stores, (s) => s.name, 5) });
      continue;
    }
    ids.push(best.id);
    matched.push(best.name);
  }
  return { ids, matched, unmatched };
}

/** Mapa id -> nombre de tienda, para etiquetar precios por tienda. */
export async function storeNames(client: SolotodoClient): Promise<Map<number, string>> {
  const stores = await listStores(client);
  return new Map(stores.map((s) => [s.id, s.name]));
}

/** Convierte un monto en CLP al valor en USD que esperan los filtros de `browse`. */
export async function clpToUsd(client: SolotodoClient, clp: number): Promise<number> {
  const rate = await getClpPerUsd(client);
  return clp / rate;
}

/** Campos de `specs` que son ruido de implementación y nunca interesan al usuario. */
const SPEC_NOISE = /(^id$|_id$|_ids$|^unicode$|_unicode_|^instance_model)/;

/**
 * Aplana `specs` a pares legibles. La API entrega cada atributo varias veces
 * (`processor_id`, `processor_unicode`, `processor_name`...); nos quedamos con la
 * variante `_unicode`, que es la que muestra el sitio, y descartamos los ids.
 */
export function readableSpecs(specs: ProductSpecs | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!specs) return out;

  for (const [key, value] of Object.entries(specs)) {
    if (SPEC_NOISE.test(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;

    const label = key.endsWith('_unicode') ? key.slice(0, -'_unicode'.length) : key;
    // `_unicode` gana sobre `_name`/`_value` para la misma raíz.
    if (key.endsWith('_unicode') || !out.has(label)) {
      out.set(label, formatSpecValue(value));
    }
  }
  return out;
}

function formatSpecValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return String(value);
}

/** Nombre corto para tablas: quita el part number entre corchetes. */
export function shortName(product: Pick<Product, 'name'>): string {
  return product.name.replace(/\s*\[[^\]]+\]\s*$/, '').trim() || product.name;
}

export function productUrl(product: Pick<Product, 'id' | 'slug'>): string {
  return product.slug
    ? `https://www.solotodo.cl/products/${product.id}-${product.slug}`
    : `https://www.solotodo.cl/products/${product.id}`;
}
