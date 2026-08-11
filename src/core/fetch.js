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

/**
 * Names that always mean "this machine" or "this network", however they
 * resolve. A single trailing dot is stripped before matching: `localhost.` is
 * a fully-qualified spelling of `localhost` that resolves identically, and
 * matching on `^localhost$` alone lets it straight through.
 */
const PRIVATE_HOST_NAMES = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.home\.arpa$/i,
];

const IPV6_PRIVATE_PATTERNS = [
  /^::1$/,
  /^::$/,
  /^f[cd][0-9a-f]{2}:/i, // fc00::/7 unique local
  /^fe[89ab][0-9a-f]:/i, // fe80::/10 link local
];

/**
 * Is this dotted-quad inside a range that never belongs to a public website?
 *
 * Checked numerically rather than by string prefix. A prefix test like `/^10\./`
 * also matches the hostname `10.example.com`, which is an ordinary public
 * domain, so the auditor would refuse to look at a site that is perfectly fine.
 */
function isPrivateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return false;

  const [a, b] = octets;
  return (
    a === 0 || // "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // RFC6598 carrier-grade NAT
    (a === 169 && b === 254) || // link local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // RFC1918
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** Expand an IPv6 address into its eight 16-bit groups, or null if malformed. */
function expandIpv6(text) {
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const filled = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (filled < 0 || (halves.length === 1 && head.length !== 8)) return null;

  const groups = [...head, ...Array(filled).fill('0'), ...tail].map((group) => Number.parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isFinite(group) || group < 0 || group > 0xffff)) {
    return null;
  }
  return groups;
}

/**
 * The IPv4 address an IPv6 host actually routes to, when it carries one.
 *
 * Only the prefixes that genuinely embed a routable IPv4 address count:
 * `::ffff:0:0/96` (IPv4-mapped), `::/96` (IPv4-compatible) and `64:ff9b::/96`
 * (NAT64). Reading the low 32 bits of *any* IPv6 address as IPv4 would block
 * legitimate global addresses whose tail happens to look private.
 *
 * Without this, `http://[::ffff:169.254.169.254]/` slips past the dotted-quad
 * patterns and reaches the cloud metadata endpoint.
 */
function embeddedIpv4(hostname) {
  const inner = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.includes(':')) return null;

  const groups = expandIpv6(inner);
  if (!groups) return null;

  const zeroThroughFive = groups.slice(0, 6).every((group) => group === 0);
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (!zeroThroughFive && !isMapped && !isNat64) return null;

  const high = groups[6];
  const low = groups[7];
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
}

/**
 * Is this hostname a private, loopback or link-local target?
 *
 * IP literals and DNS names are judged by different rules, because the two
 * cannot be told apart by pattern alone: the address range tests belong only to
 * something that is actually an address.
 *
 * This is a URL-layer guard, not a resolution-layer one. A public name that
 * resolves to a private address still gets through, which no amount of string
 * inspection can prevent — stopping that needs the resolved IP, which the
 * Workers runtime does not expose. The guard therefore raises the cost of
 * pointing the hosted endpoint at internal services without claiming to make
 * it impossible.
 */
export function isPrivateHost(hostname) {
  // A single trailing dot is the fully-qualified spelling of the same name and
  // resolves identically, so it must not survive into the comparison.
  const host = String(hostname || '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) return true;

  const inner = host.replace(/^\[/, '').replace(/\]$/, '');

  if (inner.includes(':')) {
    if (IPV6_PRIVATE_PATTERNS.some((pattern) => pattern.test(inner))) return true;
    const mapped = embeddedIpv4(inner);
    return mapped !== null && isPrivateIpv4(mapped);
  }

  // The WHATWG URL parser canonicalises hex, octal, decimal and short-form
  // IPv4 literals to dotted quads before this is reached, so only the dotted
  // form needs handling here.
  if (/^\d/.test(inner) && isPrivateIpv4(inner)) return true;

  return PRIVATE_HOST_NAMES.some((pattern) => pattern.test(inner));
}

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
  if (!allowPrivate && isPrivateHost(url.hostname)) {
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

  // `timeoutMs` is the budget for the whole operation, not for each hop. A
  // per-hop timer lets a chain of slow redirects run for maxRedirects × the
  // timeout, and a server that stalls after sending headers runs forever.
  const deadline = startedAt + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new FetchError(`Timed out after ${timeoutMs}ms fetching ${url}`, 'timeout');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
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
        throw asFetchError(error, url, timeoutMs);
      }

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location && hop < maxRedirects) {
        let next;
        try {
          next = new URL(location, url);
        } catch {
          throw new FetchError(`Redirect to an unparseable location: ${location}`, 'bad_redirect');
        }
        if (!allowPrivate && isPrivateHost(next.hostname)) {
          throw new FetchError(`Redirect pointed at a private host: ${next.hostname}`, 'private_host');
        }
        redirects.push({ from: url.toString(), to: next.toString(), status: response.status });
        url = next;
        continue;
      }

      // The abort timer stays armed across this read. Undici and workerd both
      // tie the body stream to the request signal, so a server that trickles
      // bytes forever is cut off at the deadline instead of pinning the worker.
      let body;
      try {
        body = await readCapped(response, maxBytes);
      } catch (error) {
        throw asFetchError(error, url, timeoutMs);
      }

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
    } finally {
      clearTimeout(timer);
    }
  }

  throw new FetchError(`Too many redirects (>${maxRedirects}) starting at ${input}`, 'redirect_loop');
}

/** Preserve our own errors; classify anything the runtime threw. */
function asFetchError(error, url, timeoutMs) {
  if (error instanceof FetchError) return error;
  const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
  return new FetchError(
    aborted ? `Timed out after ${timeoutMs}ms fetching ${url}` : `Could not reach ${url}: ${error && error.message}`,
    aborted ? 'timeout' : 'unreachable',
  );
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
