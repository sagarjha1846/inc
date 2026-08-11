/**
 * Network access for the auditor.
 *
 * Everything an audit fetches is attacker-controlled in the sense that the URL
 * comes from whoever is using the tool, so each request is bounded: a timeout,
 * a byte cap, a redirect budget, and — in the hosted worker — a block on
 * private address space so the public endpoint can't be pointed at internal
 * services.
 */

export const DEFAULT_USER_AGENT =
  'CitableBot/0.1 (+https://github.com/sagarjha1846/inc; AI visibility auditor)';

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /\.local$/i,
  /\.internal$/i,
];

export class FetchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FetchError';
    this.code = code || 'fetch_failed';
  }
}

/** Reject anything that isn't a public http(s) URL. */
export function normalizeUrl(input, { allowPrivate = false } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new FetchError('No URL provided.', 'invalid_url');

  // A bare "example.com" is a convenience we support; anything that already
  // carries a scheme must carry an acceptable one. Prepending https:// to a
  // non-http scheme would otherwise produce a nonsense URL like
  // "https://ftp://example.com" and fail with a confusing network error.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    throw new FetchError(`Unsupported protocol: ${scheme[1]}:`, 'invalid_url');
  }

  let url;
  try {
    url = new URL(scheme ? raw : `https://${raw}`);
  } catch {
    throw new FetchError(`Not a valid URL: ${raw}`, 'invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`Unsupported protocol: ${url.protocol}`, 'invalid_url');
  }
  if (!allowPrivate && PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new FetchError(`Refusing to audit a private or loopback host: ${url.hostname}`, 'private_host');
  }
  url.hash = '';
  return url;
}

/**
 * Fetch with a timeout, a size cap, and a manually walked redirect chain so the
 * report can show where a URL actually ended up.
 */
export async function fetchPage(input, options = {}) {
  const {
    timeoutMs = 15000,
    maxBytes = 3_000_000,
    maxRedirects = 5,
    userAgent = DEFAULT_USER_AGENT,
    allowPrivate = false,
    method = 'GET',
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new FetchError('No fetch implementation available in this runtime.', 'no_fetch');
  }

  let url = normalizeUrl(input, { allowPrivate });
  const redirects = [];
  const startedAt = Date.now();

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new FetchError(
        aborted ? `Timed out after ${timeoutMs}ms fetching ${url}` : `Could not reach ${url}: ${error && error.message}`,
        aborted ? 'timeout' : 'unreachable',
      );
    }
    clearTimeout(timer);

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location && hop < maxRedirects) {
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new FetchError(`Redirect to an unparseable location: ${location}`, 'bad_redirect');
      }
      if (!allowPrivate && PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(next.hostname))) {
        throw new FetchError(`Redirect pointed at a private host: ${next.hostname}`, 'private_host');
      }
      redirects.push({ from: url.toString(), to: next.toString(), status: response.status });
      url = next;
      continue;
    }

    const body = await readCapped(response, maxBytes);
    return {
      url: url.toString(),
      finalUrl: url.toString(),
      status: response.status,
      ok: response.ok,
      headers: headersToObject(response.headers),
      body: body.text,
      truncated: body.truncated,
      bytes: body.bytes,
      redirects,
      elapsedMs: Date.now() - startedAt,
    };
  }

  throw new FetchError(`Too many redirects (>${maxRedirects}) starting at ${input}`, 'redirect_loop');
}

/** Read a response body but stop at `maxBytes` so one page can't blow memory. */
async function readCapped(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    const truncated = text.length > maxBytes;
    return { text: truncated ? text.slice(0, maxBytes) : text, truncated, bytes: text.length };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      chunks.push(decoder.decode(value.slice(0, Math.max(0, value.byteLength - (bytes - maxBytes))), { stream: true }));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      break;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(''), truncated, bytes };
}

function headersToObject(headers) {
  const out = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    out[lower] = lower in out ? `${out[lower]}, ${value}` : value;
  });
  return out;
}

/**
 * Fetch a companion file (robots.txt, llms.txt, sitemap.xml).
 * A miss is an expected outcome, not an error, so this resolves either way.
 */
export async function fetchOptional(baseUrl, path, options = {}) {
  let target;
  try {
    target = new URL(path, baseUrl).toString();
  } catch {
    return { url: null, found: false, status: 0, body: '', error: 'bad_url' };
  }
  try {
    const response = await fetchPage(target, { maxBytes: 512_000, timeoutMs: 10000, ...options });
    return {
      url: response.finalUrl,
      found: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: response.headers,
      body: response.body,
    };
  } catch (error) {
    return { url: target, found: false, status: 0, body: '', error: (error && error.code) || 'fetch_failed' };
  }
}
