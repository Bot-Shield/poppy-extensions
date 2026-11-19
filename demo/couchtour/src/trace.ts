/**
 * What the inspector shows: rows for each request and response, recorded as they happen. Every
 * recorded body goes through `scrub` first: no full phone numbers, no account references, no
 * secrets, and tokens shortened.
 */
import { decodeJwt, short } from './jose.ts';
import type { DemoStub } from './state.ts';

export type Tag = { s: string; ext?: 'approval' | 'presence' };
export type Http = { method?: string; url?: string; status?: number; headers?: Record<string, string>; body?: unknown; jwts?: Record<string, unknown> };

export type Row = {
  kind: 'row';
  /** poppy: agent ⇄ Couch Tour. botshield: Couch Tour ⇄ BotShield. phone: the BotShield app. browser: the user's browser. */
  lane: 'poppy' | 'botshield' | 'phone' | 'browser' | 'company';
  title: string;
  result: string;
  tags?: Tag[];
  /** Section tags for the response side, Atlas-style. */
  rtags?: Tag[];
  agentNotes?: string[];
  companyNotes?: string[];
  req?: Http;
  res?: Http;
  /** Consecutive rows with the same key fold into one, with a count. */
  fold?: string;
  error?: boolean;
  /** Mark the poppy.json row so the page can highlight the BotShield extensions. */
  special?: 'poppy.json';
  simulated?: boolean;
};
export type Group = { kind: 'group'; title: string };
export type Say = { kind: 'say'; role: 'user' | 'agent' | 'system'; text: string; action?: { type: 'signin'; url: string } | { type: 'presence'; url: string } };
export type State = { kind: 'state'; signedIn: boolean; scopes?: string; mode: 'live' | 'simulated'; working: boolean; pending?: string | null; turnsLeft?: number };
export type Event = Row | Group | Say | State;

/** What a Couch Tour request did on the Company's side: its reasoning and its calls to BotShield. */
export class Collector {
  notes: string[] = [];
  calls: Row[] = [];
  /** Which BotShield extension the current action uses, for the rows' section tags. */
  ext: 'approval' | 'presence' = 'approval';
  note(s: string) {
    this.notes.push(s);
  }
}

const SECRET_KEYS = /^(authorization|x-demo-key|cookie|set-cookie|x-demo-trace)$/i;

/** Masks a phone number to its last two digits. */
export function maskPhone(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length >= 2 ? `••${d.slice(-2)}` : '••';
}

/** Removes personal data and secrets from anything the inspector records. */
export function scrub(v: unknown, key = ''): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (/phone/i.test(key)) return maskPhone(v);
    if (/^(partner_user_ref|partner_user_id|account_ref)$/.test(key)) return 'acct_•••• (Couch Tour\'s own reference)';
    if (/^(token|verification_token|signed_token|access_token|refresh_token|code|code_verifier|client_assertion|anchor_grant_token|session_token)$/.test(key)) return short(v, 10, 4);
    // Any long run of digits that could be a phone number.
    return v.replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => maskPhone(m));
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrub(x, k);
    return out;
  }
  return v;
}

/** Headers for display: secrets dropped, JWTs shortened (and decoded alongside). */
export function showHeaders(h: Headers | Record<string, string>): { headers: Record<string, string>; jwts: Record<string, unknown> } {
  const headers: Record<string, string> = {};
  const jwts: Record<string, unknown> = {};
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h);
  for (const [k, v] of entries) {
    if (/^x-demo-key$|^x-demo-trace$|^cookie$/i.test(k)) continue;
    if (/^authorization$/i.test(k)) {
      const [scheme, tok] = v.split(' ');
      headers[canon(k)] = `${scheme} ${short(tok ?? '', 10, 4)}`;
      continue;
    }
    if (/^poppy-session$/i.test(k)) {
      headers[canon(k)] = short(v, 14, 4);
      try {
        const d = decodeJwt(v);
        jwts[canon(k)] = { header: { ...d.header, poppy_dlg: d.header.poppy_dlg ? short(d.header.poppy_dlg, 14, 4) : undefined }, payload: d.payload, delegation: d.header.poppy_dlg ? decodeJwt(d.header.poppy_dlg).payload : undefined };
      } catch { /* not a JWT */ }
      continue;
    }
    if (SECRET_KEYS.test(k)) continue;
    headers[canon(k)] = v;
  }
  return { headers, jwts };
}

const canon = (k: string) => k.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** Form bodies (OAuth) for display, with the client assertion decoded. */
export function showForm(body: string): { body: Record<string, string>; jwts: Record<string, unknown> } {
  const p = new URLSearchParams(body);
  const out: Record<string, string> = {};
  const jwts: Record<string, unknown> = {};
  for (const [k, v] of p) {
    out[k] = (scrub(v, k) as string) ?? '';
    if (k === 'client_assertion') {
      try {
        const d = decodeJwt(v);
        jwts.client_assertion = { header: d.header, payload: d.payload };
      } catch { /* ignore */ }
    }
  }
  return { body: out, jwts };
}

/** Appends events to a chat's list in the Durable Object. */
export function sink(stub: DemoStub, chatId: string) {
  return async (e: Event) => {
    await stub.append(`ev:${chatId}`, e as unknown as Record<string, unknown>);
  };
}
