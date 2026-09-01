/**
 * Pruebas contra la API real de SoloTodo. Se ejecutan solo con `npm run test:live`
 * porque dependen de la red y de datos que cambian a diario.
 *
 * Su objetivo no es fijar valores exactos sino detectar que la API upstream cambió
 * de forma (renombró un campo, movió un endpoint) y el servidor dejó de funcionar.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { makeTestEnv } from './fake-d1.js';
import { completeFlow, ORIGIN } from './oauth-helper.js';

const { env: ENV } = makeTestEnv({ SOLOTODO_TIMEOUT_MS: '30000' });

let callId = 0;
let token = '';

beforeAll(async () => {
  token = (await completeFlow(ENV)).accessToken;
});

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++callId, method: 'tools/call', params: { name, arguments: args } }),
    }),
    ENV,
  );
  const body = await response.json<{ result?: { content: { text: string }[]; isError?: boolean }; error?: unknown }>();
  if (!body.result) throw new Error(`Error de protocolo: ${JSON.stringify(body.error)}`);
  return { text: body.result.content.map((part) => part.text).join('\n'), isError: body.result.isError === true };
}

/** Extrae el primer id de producto de una tabla de resultados de `buscar_productos`. */
function firstProductId(markdown: string): number {
  const match = markdown.match(/^\|\s*(\d{3,})\s*\|/m);
  if (!match?.[1]) throw new Error(`No se encontró un id de producto en:\n${markdown.slice(0, 800)}`);
  return Number(match[1]);
}

describe('integración con la API real de SoloTodo', () => {
  it('listar_categorias devuelve el catálogo de categorías', async () => {
    const { text, isError } = await callTool('listar_categorias', { filtro: 'notebook' });
    expect(isError).toBe(false);
    expect(text).toContain('Notebooks');
  });

  it('filtros_categoria expone los filtros de specs con sus valores', async () => {
    const { text, isError } = await callTool('filtros_categoria', { categoria: 'Notebooks' });
    expect(isError).toBe(false);
    expect(text).toContain('`ram_quantity`');
    expect(text).toContain('`video_cards`');
  });

  it('filtros_categoria detalla los valores de un filtro puntual', async () => {
    const { text } = await callTool('filtros_categoria', { categoria: 'Notebooks', filtro: 'video_cards' });
    expect(text).toMatch(/RTX/);
  });

  let notebookId = 0;

  it('buscar_productos combina texto, precio en CLP y specs', async () => {
    const { text, isError } = await callTool('buscar_productos', {
      categoria: 'Notebooks',
      busqueda: 'RTX',
      precio_max_clp: 1_500_000,
      specs: { ram_quantity: 16 },
      limite: 5,
    });

    expect(isError).toBe(false);
    expect(text).toContain('Filtros aplicados');
    expect(text).toContain('Cantidad mínima >= 16 GB');
    expect(text).toMatch(/\$\d/); // hay precios en pesos
    notebookId = firstProductId(text);
    expect(notebookId).toBeGreaterThan(0);
  });

  it('buscar_productos avisa cuando una spec no existe, sin romper la búsqueda', async () => {
    const { text, isError } = await callTool('buscar_productos', {
      categoria: 'Notebooks',
      specs: { video_cards: 'RTX 9090 Ti Super' },
      limite: 3,
    });
    expect(isError).toBe(false);
    expect(text).toContain('no es una opción válida');
  });

  it('buscar_productos rechaza una categoría inexistente con sugerencias', async () => {
    const { text, isError } = await callTool('buscar_productos', { categoria: 'zzzz-no-existe' });
    expect(isError).toBe(true);
    expect(text).toContain('No encontré la categoría');
  });

  it('detalle_producto trae precios por tienda y specs', async () => {
    const { text, isError } = await callTool('detalle_producto', { producto_id: notebookId });
    expect(isError).toBe(false);
    expect(text).toMatch(/Sin stock|Mejor precio/);
    expect(text).toContain('Especificaciones');
  });

  it('historial_precio analiza el historial y emite una conclusión', async () => {
    const { text, isError } = await callTool('historial_precio', { producto_id: notebookId, dias: 60 });
    expect(isError).toBe(false);
    expect(text).toContain('Historial de precios');
    expect(text).toMatch(/Conclusión|No hay historial/);
  });

  it('comentarios_producto responde con o sin evaluaciones', async () => {
    const { text, isError } = await callTool('comentarios_producto', { producto_id: notebookId, limite: 5 });
    expect(isError).toBe(false);
    expect(text).toMatch(/evaluaciones/i);
  });

  it('comparar_productos arma la tabla lado a lado', async () => {
    const { text: search } = await callTool('buscar_productos', { categoria: 'Notebooks', limite: 3 });
    const ids = [...search.matchAll(/^\|\s*(\d{3,})\s*\|/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThanOrEqual(2);

    const { text, isError } = await callTool('comparar_productos', { producto_ids: ids.slice(0, 3) });
    expect(isError).toBe(false);
    expect(text).toContain('Comparación');
    expect(text).toContain('Mejor precio');
  });

  it('reporta un error legible ante un id de producto inexistente', async () => {
    const { text, isError } = await callTool('detalle_producto', { producto_id: 999_999_999 });
    expect(isError).toBe(true);
    expect(text).toContain('404');
  });
});

describe('contrato de la API upstream', () => {
  it('los filtros de rango siguen exigiendo el id del choice y no el valor', async () => {
    // Si esto empieza a pasar, la API cambió y `resolveSpecs` se puede simplificar.
    const response = await fetch('https://publicapi.solotodo.com/categories/1/browse/?page_size=1&ram_quantity_min=16');
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('el filtro de ratings sigue siendo `products` en plural', async () => {
    const response = await fetch('https://publicapi.solotodo.com/ratings/?products=257897&page_size=1');
    const body = await response.json<{ count: number }>();
    // `product` (singular) se ignora y devolvería el catálogo completo (miles).
    expect(body.count).toBeLessThan(100);
  });
});
