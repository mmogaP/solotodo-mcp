import { describe, expect, it } from 'vitest';
import { analyzePriceHistory, type PriceSample } from '../src/lib/price-analysis.js';

function sample(offer: number, normal = offer, isAvailable = true): PriceSample {
  return { timestamp: '2026-08-01T00:00:00Z', isAvailable, normalPrice: normal, offerPrice: offer };
}

describe('analyzePriceHistory', () => {
  it('devuelve sin-datos cuando no hubo stock en el período', () => {
    const analysis = analyzePriceHistory([sample(500_000, 500_000, false)]);
    expect(analysis.verdict).toBe('sin-datos');
    expect(analysis.samples).toBe(0);
    expect(analysis.current).toBeNull();
  });

  it('ignora observaciones sin stock al calcular estadísticas', () => {
    const analysis = analyzePriceHistory([
      sample(100_000),
      sample(1, 1, false), // precio fantasma sin stock
      sample(120_000),
    ]);
    expect(analysis.samples).toBe(2);
    expect(analysis.min).toBe(100_000);
  });

  it('marca mínimo histórico cuando el precio actual iguala al más bajo', () => {
    const analysis = analyzePriceHistory([sample(600_000), sample(550_000), sample(500_000)]);
    expect(analysis.verdict).toBe('minimo-historico');
    expect(analysis.current).toBe(500_000);
    expect(analysis.explanation).toContain('precio más bajo');
  });

  it('marca caro cuando el precio actual está sobre el percentil 75', () => {
    const analysis = analyzePriceHistory([
      sample(400_000),
      sample(410_000),
      sample(420_000),
      sample(430_000),
      sample(500_000),
    ]);
    expect(analysis.verdict).toBe('caro');
  });

  it('detecta oferta inflada: suben el precio normal y el que se paga no baja', () => {
    const history = [
      ...Array.from({ length: 10 }, () => sample(500_000, 550_000)),
      // El precio normal salta a 900k pero el precio que se paga sigue igual.
      sample(500_000, 900_000),
    ];
    const analysis = analyzePriceHistory(history);
    expect(analysis.inflatedNormal).toBe(true);
    expect(Math.round(analysis.displayedDiscount)).toBe(44);
    expect(analysis.explanation).toContain('Oferta inflada');
  });

  it('no marca como inflada una rebaja real, aunque el precio normal sea alto', () => {
    const history = [
      ...Array.from({ length: 10 }, () => sample(500_000, 550_000)),
      sample(380_000, 550_000), // baja de verdad lo que se paga
    ];
    const analysis = analyzePriceHistory(history);
    expect(analysis.inflatedNormal).toBe(false);
    expect(analysis.verdict).toBe('minimo-historico');
    expect(Math.round(analysis.realDiscount ?? 0)).toBe(24);
  });

  it('advierte cuando el descuento exhibido no representa rebaja real', () => {
    // Precio normal estable en 500k (no inflado), pero hoy se paga MÁS que lo habitual.
    const history = [sample(400_000, 500_000), sample(400_000, 500_000), sample(450_000, 500_000)];
    const analysis = analyzePriceHistory(history);
    expect(analysis.inflatedNormal).toBe(false);
    expect(analysis.displayedDiscount).toBeCloseTo(10, 1);
    expect(analysis.realDiscount).toBeLessThan(0);
    expect(analysis.explanation).toContain('no hay rebaja real');
  });

  it('la advertencia de oferta inflada tiene prioridad sobre el descuento real', () => {
    const history = [sample(400_000, 400_000), sample(400_000, 400_000), sample(450_000, 500_000)];
    const analysis = analyzePriceHistory(history);
    expect(analysis.inflatedNormal).toBe(true);
    expect(analysis.explanation).toContain('Oferta inflada');
  });
});
