/**
 * The demo agent and the demo Couch Tour are one Worker on one host. A request from one to the other
 * goes through the `SELF` service binding: a separate invocation of this Worker, with a real
 * Request and Response, exactly as it would arrive from outside. (A Worker can't reach its own
 * custom domain with a plain `fetch`.) Requests to any other host use `fetch`.
 */
export interface NetEnv {
  DEMO_HOST: string;
  SELF?: Fetcher;
}

type Handler = (req: Request) => Promise<Response>;
let local: Handler | null = null;
/** Without the binding (local checks), the Worker's own handler is called directly. */
export function setLocalHandler(h: Handler) {
  local = h;
}

export async function net(env: NetEnv, input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.protocol !== 'https:') throw new Error('Only HTTPS URLs (spec 3).');
  const req = new Request(url, init);
  if (url.host === env.DEMO_HOST) {
    if (env.SELF) return env.SELF.fetch(req);
    if (local) return local(req);
  }
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname)) throw new Error('Refusing a private address (spec 3).');
  return fetch(req);
}

/** GET a small JSON document, without following redirects (CIMD §5, spec 5.3). */
export async function getJson<T = any>(env: NetEnv, url: string): Promise<T> {
  const ctl = AbortSignal.timeout(5000);
  const res = await net(env, url, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: ctl });
  if (res.status !== 200) throw new Error(`${url} answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 64_000) throw new Error(`${url} is too large`);
  return JSON.parse(text) as T;
}
