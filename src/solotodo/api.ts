/** Acceso tipado a los endpoints de SoloTodo que consumen las herramientas MCP. */
import type { SolotodoClient, QueryParams } from './client.js';
import type {
  AvailableEntitiesResult,
  BrowseResponse,
  Currency,
  Paginated,
  PricingHistoryGroup,
  Product,
  Rating,
  Store,
} from './types.js';

/** Id de la moneda chilena en la API. Los precios de las tiendas CL vienen en CLP. */
export const CLP_CURRENCY_ID = 1;

/** Orderings aceptados por `/categories/{id}/browse/` que exponemos al agente. */
export const BROWSE_ORDERINGS = ['offer_price_usd', 'normal_price_usd', 'relevance', 'discount', 'leads'] as const;
export type BrowseOrdering = (typeof BROWSE_ORDERINGS)[number];

export function browse(client: SolotodoClient, categoryId: number, params: QueryParams): Promise<BrowseResponse> {
  return client.get<BrowseResponse>(`/categories/${categoryId}/browse/`, params);
}

export function getProduct(client: SolotodoClient, productId: number): Promise<Product> {
  return client.get<Product>(`/products/${productId}/`);
}

/** Ofertas vigentes por tienda. Acepta varios productos en una sola llamada. */
export async function getAvailableEntities(
  client: SolotodoClient,
  productIds: readonly number[],
): Promise<AvailableEntitiesResult[]> {
  if (productIds.length === 0) return [];
  const response = await client.get<Paginated<AvailableEntitiesResult>>('/products/available_entities/', {
    ids: [...productIds],
    page_size: Math.max(productIds.length, 10),
  });
  return response.results;
}

/** Historial de precios agrupado por entidad (producto + tienda). */
export function getPricingHistory(
  client: SolotodoClient,
  productId: number,
  since: Date,
): Promise<PricingHistoryGroup[]> {
  return client.get<PricingHistoryGroup[]>(`/products/${productId}/pricing_history/`, {
    timestamp_after: since.toISOString(),
  });
}

/**
 * Evaluaciones de compradores. Ojo: el filtro es `products` (plural);
 * `product` se ignora silenciosamente y devuelve el catálogo completo.
 */
export function getRatings(
  client: SolotodoClient,
  productId: number,
  options: { pageSize?: number } = {},
): Promise<Paginated<Rating>> {
  return client.get<Paginated<Rating>>('/ratings/', {
    products: productId,
    page_size: options.pageSize ?? 20,
  });
}

export async function listStores(client: SolotodoClient): Promise<Store[]> {
  return client.get<Store[]>('/stores/');
}

/** Tipo de cambio CLP por dólar, para traducir precios en pesos a los filtros en USD. */
export async function getClpPerUsd(client: SolotodoClient): Promise<number> {
  const currencies = await client.get<Currency[]>('/currencies/');
  const clp = currencies.find((c) => c.id === CLP_CURRENCY_ID || c.iso_code === 'CLP');
  const rate = clp ? Number(clp.exchange_rate) : NaN;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('No se pudo obtener el tipo de cambio CLP de la API de SoloTodo');
  }
  return rate;
}
