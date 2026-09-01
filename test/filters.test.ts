import { describe, expect, it } from 'vitest';
import { describeFilters, resolveSpecs } from '../src/solotodo/filters.js';
import { NOTEBOOK_FILTERS } from './fixtures.js';

describe('resolveSpecs', () => {
  it('traduce un umbral gte al id del choice, no al valor', () => {
    const { params, resolved, problems } = resolveSpecs(NOTEBOOK_FILTERS, { ram_quantity: 16 });
    expect(params).toEqual({ ram_quantity_min: 103202 });
    expect(problems).toHaveLength(0);
    expect(resolved[0]?.applied).toBe('Cantidad mínima >= 16 GB');
  });

  it('redondea hacia arriba cuando el valor pedido no existe, para no violar el mínimo', () => {
    // Pedir 12 GB no debe devolver equipos de 8 GB: se sube al choice de 16 GB.
    const { params, resolved } = resolveSpecs(NOTEBOOK_FILTERS, { ram_quantity: 12 });
    expect(params).toEqual({ ram_quantity_min: 103202 });
    expect(resolved[0]?.applied).toBe('Cantidad mínima >= 16 GB');
  });

  it('acepta valores con unidad escrita', () => {
    const { params } = resolveSpecs(NOTEBOOK_FILTERS, { ram_quantity: '16 GB' });
    expect(params).toEqual({ ram_quantity_min: 103202 });
  });

  it('maneja rangos con min y max, eligiendo el borde que no viola la restricción', () => {
    const { params } = resolveSpecs(NOTEBOOK_FILTERS, { screen_size: { min: 14, max: 16 } });
    // max 16 debe caer en 15.6" (el mayor <= 16), no en 17".
    expect(params).toEqual({ screen_size_min: 103975, screen_size_max: 103978 });
  });

  it('pasa números crudos en rangos continuos sin choices', () => {
    const { params } = resolveSpecs(NOTEBOOK_FILTERS, { weight: { max: 1800 } });
    expect(params).toEqual({ weight_max: 1800 });
  });

  it('resuelve filtros categóricos por nombre aproximado y combina varios con OR', () => {
    const { params, resolved } = resolveSpecs(NOTEBOOK_FILTERS, { video_cards: ['RTX 4050', 'rtx 4060'] });
    expect(params).toEqual({ video_cards: [2000001, 2000002] });
    expect(resolved[0]?.applied).toContain('RTX 4050 (6 GB) o NVIDIA GeForce RTX 4060 (8 GB)');
  });

  it('codifica booleanos como enteros, que es lo que valida la API', () => {
    expect(resolveSpecs(NOTEBOOK_FILTERS, { screen_touch: true }).params).toEqual({ screen_touch: 1 });
    expect(resolveSpecs(NOTEBOOK_FILTERS, { screen_touch: false }).params).toEqual({ screen_touch: 0 });
  });

  it('reporta valores desconocidos con sugerencias en vez de fallar', () => {
    const { params, problems } = resolveSpecs(NOTEBOOK_FILTERS, { video_cards: 'RTX 9090' });
    expect(params).toEqual({});
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain('no es una opción válida');
  });

  it('reporta filtros inexistentes sugiriendo nombres reales', () => {
    const { problems } = resolveSpecs(NOTEBOOK_FILTERS, { memoria_ram: 16 });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.filter).toBe('memoria_ram');
  });

  it('acepta ids de choice directamente', () => {
    const { params } = resolveSpecs(NOTEBOOK_FILTERS, { brands: [103588] });
    expect(params).toEqual({ brands: [103588] });
  });

  it('ignora valores vacíos', () => {
    const { params, problems } = resolveSpecs(NOTEBOOK_FILTERS, { brands: '', ram_quantity: '' });
    expect(params).toEqual({});
    expect(problems).toHaveLength(0);
  });
});

describe('describeFilters', () => {
  it('agrupa por fieldset e indica el tipo de cada filtro', () => {
    const description = describeFilters(NOTEBOOK_FILTERS);
    expect(description).toContain('### RAM');
    expect(description).toContain('`ram_quantity` (Cantidad mínima, mínimo)');
    expect(description).toContain('`screen_touch` (¿Táctil?, booleano (true/false))');
    expect(description).toContain('`weight` (Peso, rango { min, max }) — numérico en g.');
  });
});
