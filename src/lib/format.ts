/** Formateo de precios y tablas markdown para las respuestas de las herramientas. */

/** Formatea un monto en pesos chilenos: 455890 -> "$455.890". */
export function formatCLP(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return '$' + Math.round(n).toLocaleString('es-CL');
}

/** Fecha ISO -> "2026-09-01" (fecha local de Chile no aplica: la API entrega UTC). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function percent(value: number): string {
  return `${value >= 0 ? '' : ''}${Math.round(value)}%`;
}

/**
 * Tabla markdown. Las celdas se escapan para no romper el pipe delimitador.
 * Devuelve cadena vacía si no hay filas.
 */
export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const esc = (cell: string) => cell.replace(/\|/g, '\|').replace(/\n/g, ' ');
  const lines = [
    `| ${headers.map(esc).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => esc(cell ?? '')).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Recorta texto largo (descripciones de tienda, comentarios) preservando palabras. */
export function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
