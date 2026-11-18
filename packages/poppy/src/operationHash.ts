/**
 * The shared operation hash proposed in Personal Agent Protocol issues #71 and #74, so an approval
 * names the same operation data whoever computes it:
 *
 * - The input is the RFC 8785 (JCS) encoding of `operation_id`, `revision`, `summary` and `terms`
 *   when present, and `expires_at`.
 * - `expires_at` is first converted to UTC, RFC 3339, ending in `Z`, whole seconds. A zero fraction
 *   (`.000`) is accepted; a non-zero fraction is refused rather than truncated, so two different
 *   expiry times never share a hash.
 * - `terms`, when present, must be an object.
 * - SHA-256, base64url without padding.
 *
 * A matching hash shows two records name the same operation data. It doesn't show that a signature
 * is valid or that the Company accepted an approval.
 */
import { base64url } from './poppy.ts';

export interface OperationLike {
  operation_id: string;
  revision: string;
  summary?: string;
  terms?: Record<string, unknown>;
  expires_at: string;
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** `expires_at` in UTC, `Z`, whole seconds. Throws on a non-zero fraction or a malformed time. */
export function normalizeExpiresAt(value: string): string {
  const m = RFC3339.exec(value);
  if (!m) throw new Error('expires_at is not an RFC 3339 date-time');
  if (m[3] && Number(m[3].slice(1)) !== 0) throw new Error('expires_at has non-zero fractional seconds');
  const offset = /[Zz]/.test(m[4]) ? 'Z' : m[4];
  const d = new Date(`${m[1]}T${m[2]}${offset}`);
  if (Number.isNaN(d.getTime())) throw new Error('expires_at is not a valid time');
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The exact bytes that are hashed, as a string. */
export function operationHashInput(op: OperationLike): string {
  if ('terms' in op && op.terms !== undefined && (op.terms === null || typeof op.terms !== 'object' || Array.isArray(op.terms))) {
    throw new Error('terms must be an object when present');
  }
  const o: Record<string, unknown> = { operation_id: op.operation_id, revision: op.revision, expires_at: normalizeExpiresAt(op.expires_at) };
  if (op.summary !== undefined) o.summary = op.summary;
  if (op.terms !== undefined) o.terms = op.terms;
  return jcs(o);
}

export async function operationHash(op: OperationLike): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationHashInput(op)));
  return base64url(new Uint8Array(digest));
}

/**
 * RFC 8785 JSON Canonicalization. Strings and numbers serialize as ECMAScript's JSON.stringify does,
 * which is what RFC 8785 specifies; object keys are sorted by UTF-16 code units, which is
 * JavaScript's default string order.
 */
export function jcs(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('JCS: numbers must be finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(',')}}`;
  }
  throw new Error(`JCS: cannot encode ${typeof v}`);
}
