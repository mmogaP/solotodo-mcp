/** Utilidades de normalización y matching difuso de texto en español. */

/** Minúsculas, sin acentos y con espacios colapsados. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normaliza y además elimina todo lo que no sea alfanumérico ("RTX-4050" -> "rtx4050"). */
export function squash(value: string): string {
  return normalize(value).replace(/[^a-z0-9]/g, '');
}

export interface ScoredMatch<T> {
  item: T;
  score: number;
}

/**
 * Puntúa un candidato contra una consulta. Mayor es mejor; 0 significa "no coincide".
 *
 * Escala: 100 exacto, 90 exacto sin puntuación, 70 prefijo, 50 substring,
 * 10..40 según proporción de tokens de la consulta presentes en el candidato.
 */
export function matchScore(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (squash(q) === squash(c)) return 90;
  if (c.startsWith(q)) return 70;
  if (c.includes(q)) return 50;
  if (squash(c).includes(squash(q))) return 45;

  const qTokens = q.split(' ').filter(Boolean);
  if (qTokens.length < 2) return 0;
  const matched = qTokens.filter((token) => c.includes(token)).length;
  if (matched === 0) return 0;
  // Solo consideramos coincidencia parcial si aparece la mayoría de los tokens.
  const ratio = matched / qTokens.length;
  return ratio >= 0.6 ? Math.round(10 + ratio * 30) : 0;
}

/** Ordena candidatos por afinidad con la consulta, descartando los que no coinciden. */
export function rankMatches<T>(query: string, items: readonly T[], toText: (item: T) => string): ScoredMatch<T>[] {
  return items
    .map((item) => ({ item, score: matchScore(query, toText(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Sugerencias por similitud laxa, para mensajes de error accionables. */
export function suggest<T>(query: string, items: readonly T[], toText: (item: T) => string, limit = 5): string[] {
  const q = squash(query);
  const scored = items
    .map((item) => {
      const text = toText(item);
      const s = squash(text);
      let score = matchScore(query, text);
      if (score === 0 && q.length >= 3) {
        // Prefijo compartido: "ryzen 9" sugiere "AMD Ryzen 9".
        if (s.includes(q.slice(0, Math.max(3, Math.floor(q.length * 0.6))))) score = 5;
      }
      return { text, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of scored) {
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    out.push(entry.text);
    if (out.length >= limit) break;
  }
  return out;
}
