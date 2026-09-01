/**
 * Traducción de specs en lenguaje humano a query params de `/categories/{id}/browse/`.
 *
 * El detalle clave de la API: los filtros de rango y `gte` NO aceptan el valor
 * ("16" para 16 GB de RAM) sino el **id del choice** que representa ese valor
 * (`ram_quantity_min=103202`). Los choices vienen por categoría en
 * `/category_specs_form_layouts/`. Sin esta traducción ningún agente puede
 * construir una búsqueda por specs, así que es el corazón del servidor.
 */
import type { SolotodoClient, QueryParams } from './client.js';
import type { SpecFilter, SpecFilterChoice, SpecsFormLayout } from './types.js';
import { normalize, rankMatches, suggest } from '../lib/text.js';

/** Website 1 = solotodo.cl; los layouts se definen por sitio. */
const SOLOTODO_WEBSITE_ID = 1;

export interface CategoryFilter extends SpecFilter {
  /** Grupo al que pertenece en la UI ("Procesador", "RAM"...). Útil para explicarlo. */
  fieldset: string;
}

export async function getCategoryFilters(client: SolotodoClient, categoryId: number): Promise<CategoryFilter[]> {
  const layouts = await client.get<SpecsFormLayout[]>('/category_specs_form_layouts/', {
    category: categoryId,
    website: SOLOTODO_WEBSITE_ID,
  });
  const layout = layouts[0];
  if (!layout) return [];

  const filters: CategoryFilter[] = [];
  for (const fieldset of layout.fieldsets ?? []) {
    for (const filter of fieldset.filters ?? []) {
      filters.push({ ...filter, fieldset: fieldset.label });
    }
  }
  return filters;
}

/** Valor que un agente puede pasar en `specs`. */
export type SpecValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number>
  | { min?: number | string; max?: number | string };

export interface ResolvedSpec {
  filter: string;
  /** Descripción de lo que efectivamente se aplicó, para reportarlo en la respuesta. */
  applied: string;
}

export interface SpecProblem {
  filter: string;
  value: string;
  reason: string;
  suggestions: string[];
}

export interface SpecResolution {
  params: QueryParams;
  resolved: ResolvedSpec[];
  problems: SpecProblem[];
}

function choiceNumber(choice: SpecFilterChoice): number | null {
  if (choice.value === null) return null;
  const n = Number(choice.value);
  return Number.isFinite(n) ? n : null;
}

/** Busca un choice por nombre (exacto o aproximado). */
function findChoiceByName(choices: readonly SpecFilterChoice[], value: string): SpecFilterChoice | undefined {
  return rankMatches(value, choices, (c) => c.name)[0]?.item;
}

/**
 * Umbral para "al menos X": el choice más chico cuyo valor sea >= X.
 * Elegir hacia arriba nunca devuelve productos por debajo de lo pedido.
 */
function choiceAtLeast(choices: readonly SpecFilterChoice[], target: number): SpecFilterChoice | undefined {
  return choices
    .filter((c) => (choiceNumber(c) ?? -Infinity) >= target)
    .sort((a, b) => (choiceNumber(a) ?? 0) - (choiceNumber(b) ?? 0))[0];
}

/** Umbral para "a lo más X": el choice más grande cuyo valor sea <= X. */
function choiceAtMost(choices: readonly SpecFilterChoice[], target: number): SpecFilterChoice | undefined {
  return choices
    .filter((c) => (choiceNumber(c) ?? Infinity) <= target)
    .sort((a, b) => (choiceNumber(b) ?? 0) - (choiceNumber(a) ?? 0))[0];
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    // "16 GB" -> 16, '15.6"' -> 15.6
    const match = value.replace(',', '.').match(/-?\d+(\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}

function findFilter(filters: readonly CategoryFilter[], key: string): CategoryFilter | undefined {
  const target = normalize(key);
  return (
    filters.find((f) => normalize(f.name) === target) ??
    filters.find((f) => normalize(f.label) === target) ??
    rankMatches(key, filters, (f) => `${f.name} ${f.label}`)[0]?.item
  );
}

function isRangeObject(value: SpecValue): value is { min?: number | string; max?: number | string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && ('min' in value || 'max' in value);
}

/**
 * Convierte `{ ram_quantity: "16 GB", video_cards: ["RTX 4050"] }` en query params.
 * Nunca lanza: los valores irresolubles se reportan en `problems` con sugerencias,
 * de modo que el agente pueda corregir en el siguiente turno.
 */
export function resolveSpecs(filters: readonly CategoryFilter[], specs: Record<string, SpecValue>): SpecResolution {
  const params: QueryParams = {};
  const resolved: ResolvedSpec[] = [];
  const problems: SpecProblem[] = [];

  for (const [key, rawValue] of Object.entries(specs)) {
    if (rawValue === null || rawValue === undefined || rawValue === '') continue;

    const filter = findFilter(filters, key);
    if (!filter) {
      problems.push({
        filter: key,
        value: JSON.stringify(rawValue),
        reason: 'No existe un filtro con ese nombre en esta categoría.',
        suggestions: suggest(key, filters, (f) => f.name, 6),
      });
      continue;
    }

    const choices = filter.choices ?? null;
    const isRanged = filter.type === 'gte' || filter.type === 'lte' || filter.type === 'range';

    // --- Rangos y umbrales -------------------------------------------------
    if (isRanged || isRangeObject(rawValue)) {
      const bounds = isRangeObject(rawValue)
        ? { min: rawValue.min, max: rawValue.max }
        : filter.type === 'lte'
          ? { min: undefined, max: rawValue as number | string }
          : { min: rawValue as number | string, max: undefined };

      for (const [bound, value] of [
        ['min', bounds.min],
        ['max', bounds.max],
      ] as const) {
        if (value === undefined || value === null || value === '') continue;

        const target = asNumber(value);
        if (target === null) {
          problems.push({
            filter: filter.name,
            value: String(value),
            reason: `El filtro "${filter.label}" es numérico y no se pudo interpretar el valor.`,
            suggestions: (choices ?? []).slice(0, 6).map((c) => c.name),
          });
          continue;
        }

        if (!choices) {
          // Rango continuo (ej. peso): la API acepta el número directamente.
          const unit = filter.continuous_range_unit ? ` ${filter.continuous_range_unit}` : '';
          params[`${filter.name}_${bound}`] = target;
          resolved.push({
            filter: filter.name,
            applied: `${filter.label} ${bound === 'min' ? '>=' : '<='} ${target}${unit}`,
          });
          continue;
        }

        const choice = bound === 'min' ? choiceAtLeast(choices, target) : choiceAtMost(choices, target);
        if (!choice) {
          problems.push({
            filter: filter.name,
            value: String(value),
            reason: `Ningún valor disponible de "${filter.label}" satisface ${bound === 'min' ? '>=' : '<='} ${target}.`,
            suggestions: choices.slice(0, 8).map((c) => c.name),
          });
          continue;
        }

        params[`${filter.name}_${bound}`] = choice.id;
        resolved.push({
          filter: filter.name,
          applied: `${filter.label} ${bound === 'min' ? '>=' : '<='} ${choice.name}`,
        });
      }
      continue;
    }

    // --- Booleanos (filtros `exact` sin choices) ---------------------------
    if (!choices) {
      const text = normalize(String(rawValue));
      const truthy = rawValue === true || rawValue === 1 || text === 'true' || text === 'si';
      const falsy = rawValue === false || rawValue === 0 || text === 'false' || text === 'no';
      if (!truthy && !falsy) {
        problems.push({
          filter: filter.name,
          value: String(rawValue),
          reason: `El filtro "${filter.label}" es booleano; usa true o false.`,
          suggestions: ['true', 'false'],
        });
        continue;
      }
      // La API valida este campo como entero, no como booleano.
      params[filter.name] = truthy ? 1 : 0;
      resolved.push({ filter: filter.name, applied: `${filter.label}: ${truthy ? 'sí' : 'no'}` });
      continue;
    }

    // --- Categóricos (`exact` con choices): OR entre los valores dados -----
    const wanted = Array.isArray(rawValue) ? rawValue : [rawValue as string | number];
    const ids: number[] = [];
    const names: string[] = [];
    for (const value of wanted) {
      const byId = typeof value === 'number' ? choices.find((c) => c.id === value) : undefined;
      const choice = byId ?? findChoiceByName(choices, String(value));
      if (!choice) {
        problems.push({
          filter: filter.name,
          value: String(value),
          reason: `"${value}" no es una opción válida de "${filter.label}".`,
          suggestions: suggest(String(value), choices, (c) => c.name, 8),
        });
        continue;
      }
      ids.push(choice.id);
      names.push(choice.name);
    }
    if (ids.length > 0) {
      params[filter.name] = ids;
      resolved.push({ filter: filter.name, applied: `${filter.label}: ${names.join(' o ')}` });
    }
  }

  return { params, resolved, problems };
}

/** Resumen compacto de los filtros de una categoría, pensado para que lo lea un agente. */
export function describeFilters(filters: readonly CategoryFilter[], maxChoices = 12): string {
  const byFieldset = new Map<string, CategoryFilter[]>();
  for (const filter of filters) {
    const list = byFieldset.get(filter.fieldset) ?? [];
    list.push(filter);
    byFieldset.set(filter.fieldset, list);
  }

  const lines: string[] = [];
  for (const [fieldset, group] of byFieldset) {
    lines.push(`### ${fieldset}`);
    for (const filter of group) {
      const kind = describeFilterKind(filter);

      let detail = '';
      if (filter.choices && filter.choices.length > 0) {
        const shown = filter.choices.slice(0, maxChoices).map((c) => c.name);
        const rest = filter.choices.length - shown.length;
        detail = ` — ej.: ${shown.join(', ')}${rest > 0 ? ` … (+${rest} más)` : ''}`;
      } else if (filter.continuous_range_unit) {
        detail = ` — numérico en ${filter.continuous_range_unit}`;
      }
      lines.push(`- \`${filter.name}\` (${filter.label}, ${kind})${detail}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function describeFilterKind(filter: CategoryFilter): string {
  if (filter.type === 'exact') return filter.choices ? 'opciones (una o varias)' : 'booleano (true/false)';
  if (filter.type === 'gte') return 'mínimo';
  if (filter.type === 'lte') return 'máximo';
  return 'rango { min, max }';
}
