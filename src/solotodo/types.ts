/**
 * Tipos de la API pública de SoloTodo (https://publicapi.solotodo.com).
 *
 * Modelan solo los campos que este servidor consume; la API devuelve bastantes
 * más (plantillas de render, permisos, etc.) que se ignoran deliberadamente.
 */

export interface Category {
  id: number;
  name: string;
  slug: string;
}

export interface Store {
  id: number;
  name: string;
  country: number;
  logo?: string | null;
}

export interface Currency {
  id: number;
  name: string;
  iso_code: string;
  decimal_places: number;
  prefix: string;
  exchange_rate: string;
}

/** Specs de producto: forma libre y dependiente de la categoría. */
export type ProductSpecs = Record<string, unknown>;

export interface Product {
  id: number;
  name: string;
  slug?: string;
  category_id?: number;
  brand_id?: number;
  part_number?: string | null;
  picture_url?: string | null;
  description?: string | null;
  creation_date?: string;
  last_updated?: string;
  specs?: ProductSpecs;
}

export interface PriceEntry {
  currency_id: number;
  normal_price: string;
  offer_price: string;
}

export interface BrowseMetadata {
  score?: number;
  prices_per_currency: PriceEntry[];
  normal_price_usd: string;
  offer_price_usd: string;
}

export interface BrowseProductEntry {
  product: Product;
  metadata: BrowseMetadata;
}

export interface BrowseBucket {
  bucket: string;
  product_entries: BrowseProductEntry[];
}

export interface PriceRange {
  min: number;
  max: number;
  '80th': number;
  avg: number;
}

export interface BrowseResponse {
  count: number;
  results: BrowseBucket[];
  price_ranges?: {
    normal_price_usd?: PriceRange;
    offer_price_usd?: PriceRange;
  } | null;
  aggs?: Record<string, unknown>;
}

export interface EntityRegistry {
  id: number;
  entity: number;
  timestamp: string;
  is_available: boolean;
  normal_price: string;
  offer_price: string;
  cell_monthly_payment: string | null;
}

export interface Entity {
  id: number;
  name: string;
  store_id: number;
  category_id?: number;
  sku: string | null;
  external_url: string;
  condition: string;
  part_number: string | null;
  is_visible: boolean;
  active_registry: EntityRegistry | null;
  currency_id: number;
  seller?: string | null;
  last_pricing_update?: string;
  review_count?: number | null;
  review_avg_score?: number | null;
  product?: { id: number; name: string };
}

export interface AvailableEntitiesResult {
  product: Product;
  entities: Entity[];
}

export interface PricingHistoryGroup {
  entity: Entity;
  pricing_history: EntityRegistry[];
}

export interface Rating {
  id: number;
  product: { id: number; name: string };
  product_rating: number;
  product_comments: string;
  store_id: number;
  store_rating: number;
  store_comments: string;
  creation_date: string;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** Tipos de filtro expuestos por `category_specs_form_layouts`. */
export type SpecFilterType = 'exact' | 'gte' | 'lte' | 'range';

export interface SpecFilterChoice {
  id: number;
  name: string;
  /** Valor numérico como string; null en filtros puramente categóricos. */
  value: string | null;
}

export interface SpecFilter {
  id: number;
  label: string;
  /** Nombre del query param base (ej. `ram_quantity` -> `ram_quantity_min`). */
  name: string;
  type: SpecFilterType;
  continuous_range_step: string | null;
  continuous_range_unit: string | null;
  choices: SpecFilterChoice[] | null;
}

export interface SpecFieldset {
  label: string;
  filters: SpecFilter[];
}

export interface SpecsFormLayout {
  id: number;
  category: number;
  name: string;
  fieldsets: SpecFieldset[];
}
