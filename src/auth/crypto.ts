/** Primitivas criptográficas del flujo OAuth, sobre WebCrypto. */

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Token opaco aleatorio en base64url. 32 bytes = 256 bits de entropía. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

/** Identificador legible pero impredecible, para client_id. */
export function randomId(prefix: string, bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let out = '';
  for (const byte of buffer) out += BASE64URL_ALPHABET[byte % 64];
  return `${prefix}_${out}`;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 en hexadecimal. Lo usamos para no guardar códigos ni tokens en claro. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 en base64url, que es el formato que PKCE S256 exige para el challenge. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Comparación en tiempo constante. Se comparan los digests y no los valores
 * originales: así el tiempo de ejecución tampoco depende del largo de la entrada.
 */
export async function secureEquals(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  if (digestA.length !== digestB.length) return false;
  let diff = 0;
  for (let i = 0; i < digestA.length; i += 1) {
    diff |= digestA.charCodeAt(i) ^ digestB.charCodeAt(i);
  }
  return diff === 0;
}

/** Verifica un code_verifier de PKCE contra el challenge guardado (solo S256). */
export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  // El RFC exige entre 43 y 128 caracteres del alfabeto unreserved.
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) return false;
  return secureEquals(await sha256Base64Url(codeVerifier), codeChallenge);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
