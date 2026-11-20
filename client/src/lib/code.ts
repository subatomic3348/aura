/**
 * Session codes: 8 characters of Crockford base32 (no I, L, O, U), shown as
 * XXXX-XXXX. Crockford's alphabet is chosen because codes are read aloud and
 * typed on phones; ambiguous letters are mapped to their digit lookalikes.
 */

export const CODE_LENGTH = 8;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Uppercases, strips separators and maps ambiguous characters (O→0, I/L→1). */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
    .slice(0, CODE_LENGTH);
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/** "K7QXM2PA" → "K7QX-M2PA". Partial input is formatted as typed. */
export function formatCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
