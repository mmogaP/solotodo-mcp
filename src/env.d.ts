/**
 * Secretos del Worker: no viven en `wrangler.jsonc`, así que `wrangler types` no
 * los descubre. Se declaran acá y TypeScript los fusiona con la interfaz generada.
 *
 * Definir con:  npx wrangler secret put MCP_AUTH_PASSWORD
 */
interface Env {
  /** Clave maestra del flujo OAuth. Es lo único que prueba que el usuario eres tú. */
  MCP_AUTH_PASSWORD: string;
}
