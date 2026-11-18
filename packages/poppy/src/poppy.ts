/** Small helpers for the Poppy side of a request. */

/** The extension names, as listed in `poppy.json` and declared in `Poppy-Extensions`. */
export const APPROVAL_EXTENSION = 'botshield.ai/approval';
export const PRESENCE_EXTENSION = 'botshield.ai/human-presence';

/** Headers the Personal Agent repeats a request with. */
export const APPROVAL_ID_HEADER = 'BotShield-Approval-Id';
export const PRESENCE_ID_HEADER = 'BotShield-Presence-Id';
/** Keys in an MCP tool call's `_meta`. */
export const APPROVAL_ID_META = 'botshield.ai/approval-id';
export const PRESENCE_ID_META = 'botshield.ai/presence-id';

/**
 * The extensions a request declares, from its `Poppy-Extensions` header (an RFC 9651 List of
 * Strings with a `v` parameter, e.g. `"operations";v="3", "botshield.ai/approval";v="1"`).
 * Returns name → version. A header that doesn't parse declares nothing (spec 3.4).
 */
export function declaredExtensions(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  const item = /^\s*"((?:[^"\\]|\\.)*)"((?:\s*;\s*[a-z*][a-z0-9_.*-]*(?:=(?:"(?:[^"\\]|\\.)*"|[^;,\s]+))?)*)\s*$/;
  for (const part of splitTopLevel(header)) {
    const m = item.exec(part);
    if (!m) return new Map(); // malformed → no extensions
    const params = m[2] ?? '';
    const v = /;\s*v=(?:"((?:[^"\\]|\\.)*)"|([^;,\s]+))/.exec(params);
    out.set(m[1].replace(/\\(.)/g, '$1'), v ? (v[1] ?? v[2]) : '');
  }
  return out;
}

export function declares(header: string | null | undefined, name: string, version = '1'): boolean {
  return declaredExtensions(header).get(name) === version;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr && c === '\\') {
      cur += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (c === ',' && !inStr) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** An ID in the characters Poppy uses for its IDs (spec 8.2), with a prefix. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${base64url(bytes)}`;
}

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64url(new Uint8Array(digest));
}
