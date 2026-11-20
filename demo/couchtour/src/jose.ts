/**
 * The little JOSE the demo needs, on WebCrypto: ES256 signing and verifying, PS384 verifying (Poppy
 * requires Companies to accept both, spec 4.1 and 5.2), RS256 verifying (ChatGPT's client assertions),
 * JWK thumbprints (RFC 7638), and base64url.
 */

export type Jwk = JsonWebKey & { kid?: string };
export type JwtParts = { header: Record<string, any>; payload: Record<string, any>; signingInput: string; signature: Uint8Array };

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const b64json = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

export async function sha256b64(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function randomId(prefix = '', bytes = 16): string {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function decodeJwt(token: string): JwtParts {
  const [h, p, s] = token.split('.');
  if (!h || !p || s === undefined) throw new Error('not a compact JWS');
  return {
    header: JSON.parse(new TextDecoder().decode(unb64url(h))),
    payload: JSON.parse(new TextDecoder().decode(unb64url(p))),
    signingInput: `${h}.${p}`,
    signature: unb64url(s),
  };
}

/** A new ES256 key pair, as JWKs. */
export async function newEs256(): Promise<{ privateJwk: Jwk; publicJwk: Jwk }> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as Jwk;
  const publicJwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as Jwk;
  return { privateJwk, publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y } };
}

export function publicOf(jwk: Jwk): Jwk {
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** RFC 7638 thumbprint of an EC or RSA public key. */
export async function thumbprint(jwk: Jwk): Promise<string> {
  const members = jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return sha256b64(JSON.stringify(members));
}

export async function signEs256(header: Record<string, unknown>, payload: Record<string, unknown>, privateJwk: Jwk): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const input = `${b64json({ ...header, alg: 'ES256' })}.${b64json(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

/** Verifies an ES256, PS384 or RS256 signature with a public JWK. */
export async function verifySig(parts: JwtParts, jwk: Jwk): Promise<boolean> {
  const alg = parts.header.alg;
  const data = enc.encode(parts.signingInput);
  try {
    if (alg === 'ES256' && jwk.kty === 'EC' && jwk.crv === 'P-256') {
      const key = await crypto.subtle.importKey('jwk', publicOf(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, parts.signature, data);
    }
    if (alg === 'PS384' && jwk.kty === 'RSA') {
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, { name: 'RSA-PSS', hash: 'SHA-384' }, false, ['verify']);
      return crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 48 }, key, parts.signature, data);
    }
    if (alg === 'RS256' && jwk.kty === 'RSA') {
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, parts.signature, data);
    }
  } catch {
    return false;
  }
  return false;
}

/** PKCE S256 challenge for a verifier. */
export const pkceChallenge = (verifier: string) => sha256b64(verifier);

/** Shortens a token for display: the first characters, then the last few. */
export function short(token: string, head = 12, tail = 4): string {
  return token.length <= head + tail + 1 ? token : `${token.slice(0, head)}…${token.slice(-tail)}`;
}
