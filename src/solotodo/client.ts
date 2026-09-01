/**
 * Cliente HTTP para la API pública de SoloTodo.
 *
 * Dos capas de caché, porque la API es de un tercero sin garantías de estabilidad
 * y conviene golpearla lo menos posible (ver "Riesgo a vigilar" en el README):
 *  - memo por request: dedup dentro de una misma llamada a herramienta
 *    (el layout de filtros se consulta varias veces al resolver specs).
 *  - Cache API de Cloudflare: comparte respuestas entre requests del Worker.
 */

/** Valores admitidos en un query param. Los arrays se repiten: `stores=9&stores=18`. */
export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;
export type QueryParams = Record<string, QueryValue>;

export interface SolotodoClientOptions {
  baseUrl?: string;
  /** TTL de la Cache API en segundos. 0 desactiva la caché compartida. */
  cacheTtl?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Error de la API upstream, con status y cuerpo para poder explicárselo al agente. */
export class SolotodoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'SolotodoApiError';
  }
}

const DEFAULT_BASE_URL = 'https://publicapi.solotodo.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_TTL = 900;

export class SolotodoClient {
  readonly baseUrl: string;
  private readonly cacheTtl: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(options: SolotodoClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.cacheTtl = options.cacheTtl ?? DEFAULT_CACHE_TTL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // `bind` es obligatorio: en workerd, invocar el fetch global guardado como
    // propiedad de otro objeto lanza "Illegal invocation" por perder su receiver.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Construye la URL absoluta de un endpoint, expandiendo arrays en params repetidos. */
  buildUrl(path: string, params: QueryParams = {}): string {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === null || item === undefined || item === '') continue;
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    // Orden estable: la URL es la clave de caché y no queremos duplicados por orden.
    url.searchParams.sort();
    return url.toString();
  }

  /** GET con caché. Lanza `SolotodoApiError` si el upstream responde != 2xx. */
  async get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const url = this.buildUrl(path, params);
    const pending = this.memo.get(url);
    if (pending) return pending as Promise<T>;

    const promise = this.fetchJson<T>(url).catch((error: unknown) => {
      // No memoizamos fallos: un error transitorio no debe envenenar el resto del request.
      this.memo.delete(url);
      throw error;
    });
    this.memo.set(url, promise);
    return promise;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const request = new Request(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'solotodo-mcp (+https://github.com/rootspa/solotodo-mcp)' },
    });

    const cache = this.cacheTtl > 0 ? getEdgeCache() : undefined;
    if (cache) {
      const hit = await cache.match(request).catch(() => undefined);
      if (hit) return (await hit.json()) as T;
    }

    const response = await this.fetchImpl(request, { signal: AbortSignal.timeout(this.timeoutMs) }).catch(
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        throw new SolotodoApiError(`No se pudo contactar la API de SoloTodo: ${reason}`, 0, url);
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SolotodoApiError(
        `La API de SoloTodo respondió ${response.status} para ${url}`,
        response.status,
        url,
        body.slice(0, 600),
      );
    }

    const text = await response.text();
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new SolotodoApiError('La API de SoloTodo devolvió una respuesta no-JSON', response.status, url, text.slice(0, 300));
    }

    if (cache) {
      const cacheable = new Response(text, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${this.cacheTtl}` },
      });
      // No bloqueamos la respuesta por escribir en caché.
      void cache.put(request, cacheable).catch(() => undefined);
    }

    return parsed;
  }
}

/** `caches.default` solo existe en el runtime de Workers; en tests/Node no está. */
function getEdgeCache(): Cache | undefined {
  const globalCaches = (globalThis as { caches?: { default?: Cache } }).caches;
  return globalCaches?.default;
}
