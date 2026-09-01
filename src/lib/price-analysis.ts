/**
 * Análisis del historial de precios de una entidad (producto en una tienda).
 *
 * El objetivo declarado del proyecto es distinguir una oferta real de una inflada:
 * la maniobra habitual es subir el "precio normal" días antes de un evento para
 * exhibir un descuento grande sobre un precio de referencia que nadie pagó.
 * Comparamos el precio normal actual contra la mediana del período para detectarlo.
 */

export interface PriceSample {
  timestamp: string;
  isAvailable: boolean;
  normalPrice: number;
  offerPrice: number;
}

export type PriceVerdict = 'minimo-historico' | 'buen-precio' | 'precio-habitual' | 'caro' | 'sin-datos';

export interface PriceAnalysis {
  samples: number;
  current: number | null;
  currentNormal: number | null;
  min: number | null;
  max: number | null;
  median: number | null;
  /** Fracción [0,1] de observaciones con precio estrictamente menor al actual. */
  percentile: number | null;
  /** Descuento exhibido hoy: (normal - oferta) / normal, en %. */
  displayedDiscount: number;
  /** Descuento real contra la mediana histórica del precio oferta, en %. */
  realDiscount: number | null;
  /** El precio normal actual está inflado respecto de su mediana histórica. */
  inflatedNormal: boolean;
  verdict: PriceVerdict;
  explanation: string;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const low = sorted[mid - 1];
  const high = sorted[mid];
  return low !== undefined && high !== undefined ? (low + high) / 2 : null;
}

/** Umbral sobre la mediana del precio normal a partir del cual lo consideramos inflado. */
const INFLATION_THRESHOLD = 1.05;
/** Tolerancia para considerar que el precio actual iguala al mínimo del período. */
const HISTORIC_LOW_TOLERANCE = 1.01;

export function analyzePriceHistory(samples: readonly PriceSample[]): PriceAnalysis {
  // Solo las observaciones con stock: un precio publicado sin disponibilidad no es un precio real.
  const available = samples.filter((s) => s.isAvailable && s.offerPrice > 0);

  if (available.length === 0) {
    return {
      samples: 0,
      current: null,
      currentNormal: null,
      min: null,
      max: null,
      median: null,
      percentile: null,
      displayedDiscount: 0,
      realDiscount: null,
      inflatedNormal: false,
      verdict: 'sin-datos',
      explanation: 'Sin observaciones con stock en el período consultado.',
    };
  }

  const offers = available.map((s) => s.offerPrice);
  const normals = available.map((s) => s.normalPrice).filter((n) => n > 0);
  const last = available[available.length - 1];
  const current = last?.offerPrice ?? null;
  const currentNormal = last?.normalPrice ?? null;

  const min = Math.min(...offers);
  const max = Math.max(...offers);
  const medianOffer = median(offers);
  const medianNormal = median(normals);

  const percentile = current === null ? null : offers.filter((price) => price < current).length / offers.length;

  const displayedDiscount =
    currentNormal !== null && current !== null && currentNormal > current
      ? ((currentNormal - current) / currentNormal) * 100
      : 0;

  const realDiscount = medianOffer !== null && current !== null ? ((medianOffer - current) / medianOffer) * 100 : null;

  const inflatedNormal =
    currentNormal !== null &&
    medianNormal !== null &&
    medianNormal > 0 &&
    currentNormal > medianNormal * INFLATION_THRESHOLD &&
    // Solo es engañoso si además el precio que realmente se paga no bajó.
    medianOffer !== null &&
    current !== null &&
    current >= medianOffer;

  const verdict = classify(current, min, percentile);

  return {
    samples: available.length,
    current,
    currentNormal,
    min,
    max,
    median: medianOffer,
    percentile,
    displayedDiscount,
    realDiscount,
    inflatedNormal,
    verdict,
    explanation: explain(verdict, inflatedNormal, displayedDiscount, realDiscount),
  };
}

function classify(current: number | null, min: number, percentile: number | null): PriceVerdict {
  if (current === null || percentile === null) return 'sin-datos';
  if (current <= min * HISTORIC_LOW_TOLERANCE) return 'minimo-historico';
  if (percentile <= 0.25) return 'buen-precio';
  if (percentile <= 0.75) return 'precio-habitual';
  return 'caro';
}

const VERDICT_LABEL: Record<PriceVerdict, string> = {
  'minimo-historico': '🟢 Mínimo del período',
  'buen-precio': '🟢 Buen precio',
  'precio-habitual': '🟡 Precio habitual',
  caro: '🔴 Caro para su historial',
  'sin-datos': '⚪ Sin datos',
};

export function verdictLabel(verdict: PriceVerdict): string {
  return VERDICT_LABEL[verdict];
}

function explain(
  verdict: PriceVerdict,
  inflatedNormal: boolean,
  displayedDiscount: number,
  realDiscount: number | null,
): string {
  const parts: string[] = [];

  switch (verdict) {
    case 'minimo-historico':
      parts.push('Está en el precio más bajo del período analizado.');
      break;
    case 'buen-precio':
      parts.push('Está entre los precios más bajos del período.');
      break;
    case 'precio-habitual':
      parts.push('Es el precio al que se ha vendido habitualmente.');
      break;
    case 'caro':
      parts.push('Está por sobre lo que ha costado la mayor parte del período.');
      break;
    case 'sin-datos':
      return 'Sin observaciones suficientes para evaluar.';
  }

  if (inflatedNormal) {
    parts.push(
      `⚠️ Oferta inflada: el precio normal publicado hoy está muy por sobre su mediana histórica, así que ` +
        `el ${Math.round(displayedDiscount)}% de descuento que exhibe la tienda es sobre una referencia artificial.`,
    );
  } else if (displayedDiscount > 0 && realDiscount !== null) {
    const real = Math.round(realDiscount);
    parts.push(
      real <= 0
        ? `La tienda exhibe ${Math.round(displayedDiscount)}% de descuento, pero contra su historial no hay rebaja real.`
        : `Descuento real contra su precio habitual: ${real}%.`,
    );
  }

  return parts.join(' ');
}
