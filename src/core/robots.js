/**
 * robots.txt parsing plus the AI crawler registry the audit scores against.
 *
 * Matching follows the usual robots.txt semantics: a crawler obeys the group
 * whose user-agent token matches it most specifically, wildcard `*` only as a
 * fallback, and within a group the longest matching path rule wins with
 * Allow breaking ties.
 */

/**
 * The crawlers that decide whether an answer engine can see, train on, or cite
 * a page. `purpose` distinguishes the two questions site owners conflate:
 * "will this bot use my page to answer a live question" (citation) versus
 * "will it retain my content for model training".
 */
export const AI_CRAWLERS = [
  {
    token: 'GPTBot',
    vendor: 'OpenAI',
    surface: 'ChatGPT',
    purpose: 'training',
    weight: 2,
    note: 'Builds the corpus behind ChatGPT. Blocking it does not stop live retrieval, but removes you from model knowledge.',
  },
  {
    token: 'OAI-SearchBot',
    vendor: 'OpenAI',
    surface: 'ChatGPT Search',
    purpose: 'citation',
    weight: 5,
    note: 'Indexes pages for ChatGPT search results. Blocking it removes you from ChatGPT citations.',
  },
  {
    token: 'ChatGPT-User',
    vendor: 'OpenAI',
    surface: 'ChatGPT browsing',
    purpose: 'live-fetch',
    weight: 4,
    note: 'Fetches your page when a user asks ChatGPT about it directly.',
  },
  {
    token: 'ClaudeBot',
    vendor: 'Anthropic',
    surface: 'Claude',
    purpose: 'training',
    weight: 2,
    note: 'Anthropic crawler used to build Claude training data.',
  },
  {
    token: 'Claude-SearchBot',
    vendor: 'Anthropic',
    surface: 'Claude search',
    purpose: 'citation',
    weight: 5,
    note: 'Indexes pages so Claude can cite them in search-backed answers.',
  },
  {
    token: 'Claude-User',
    vendor: 'Anthropic',
    surface: 'Claude browsing',
    purpose: 'live-fetch',
    weight: 4,
    note: 'Fetches your page on demand when a Claude user references it.',
  },
  {
    token: 'PerplexityBot',
    vendor: 'Perplexity',
    surface: 'Perplexity',
    purpose: 'citation',
    weight: 5,
    note: 'Perplexity indexes and cites sources inline. Blocking it removes you from its answer citations.',
  },
  {
    token: 'Perplexity-User',
    vendor: 'Perplexity',
    surface: 'Perplexity browsing',
    purpose: 'live-fetch',
    weight: 3,
    note: 'On-demand fetch when a Perplexity user opens or asks about your page.',
  },
  {
    token: 'Google-Extended',
    vendor: 'Google',
    surface: 'Gemini / AI Overviews grounding',
    purpose: 'training',
    weight: 4,
    note: 'Controls whether Google may use your content for Gemini grounding and model training. Does not affect classic Search ranking.',
  },
  {
    token: 'Applebot-Extended',
    vendor: 'Apple',
    surface: 'Apple Intelligence',
    purpose: 'training',
    weight: 1,
    note: 'Opts your content in or out of Apple foundation-model training.',
  },
  {
    token: 'meta-externalagent',
    vendor: 'Meta',
    surface: 'Meta AI',
    purpose: 'training',
    weight: 1,
    note: 'Meta AI crawler for model training and product grounding.',
  },
  {
    token: 'Amazonbot',
    vendor: 'Amazon',
    surface: 'Alexa / Rufus',
    purpose: 'citation',
    weight: 1,
    note: 'Feeds Amazon assistant answers.',
  },
  {
    token: 'CCBot',
    vendor: 'Common Crawl',
    surface: 'open datasets',
    purpose: 'training',
    weight: 1,
    note: 'Common Crawl feeds most open training corpora and many downstream indexes.',
  },
  {
    token: 'Bytespider',
    vendor: 'ByteDance',
    surface: 'Doubao / TikTok search',
    purpose: 'training',
    weight: 1,
    note: 'Aggressive crawler; many sites block it deliberately for bandwidth reasons.',
  },
];

/** Crawlers whose absence directly costs citations in an answer engine. */
export const CITATION_CRAWLERS = AI_CRAWLERS.filter(
  (crawler) => crawler.purpose === 'citation' || crawler.purpose === 'live-fetch',
);

/**
 * Parse robots.txt into user-agent groups.
 * Consecutive `User-agent` lines share the following rule block.
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let expectingAgents = false;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!expectingAgents || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }

    if (!current) continue;
    expectingAgents = false;

    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ type: field, path: value });
    } else if (field === 'crawl-delay') {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay)) current.crawlDelay = delay;
    }
  }

  return { groups, sitemaps };
}

/**
 * Does a robots.txt path pattern (with `*` and `$`) match this path?
 *
 * A pattern always anchors at the start of the path. Without a trailing `$` it
 * only has to match a *prefix*; with one it must consume the whole path.
 *
 * This is a two-pointer wildcard match rather than a regex, for two reasons.
 * It backtracks correctly — a naive left-to-right scan that commits to the
 * first occurrence of each literal reports `/*b$` as not matching `/abcb`,
 * which wrongly says "allowed" for a page the site actually blocks. And it
 * runs in O(pattern × path) with no catastrophic backtracking, which matters
 * because robots.txt is fetched from arbitrary sites: a translated-to-regex
 * pattern like `/*a*a*a*a*$` would otherwise be a denial-of-service vector
 * against the hosted worker.
 */
function pathMatches(pattern, path) {
  if (pattern === '') return false;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;

  for (;;) {
    if (p === body.length) {
      // Pattern exhausted: a prefix pattern is satisfied, an anchored one
      // still needs the path to be exhausted too.
      if (!anchored || t === path.length) return true;
    } else if (body[p] === '*') {
      starP = p;
      starT = t;
      p += 1;
      continue;
    } else if (t < path.length && body[p] === path[t]) {
      p += 1;
      t += 1;
      continue;
    }

    // Mismatch, or an anchored pattern with path left over. Give the most
    // recent `*` one more character and retry from there.
    if (starP !== -1 && starT < path.length) {
      starT += 1;
      t = starT;
      p = starP + 1;
      continue;
    }
    return false;
  }
}

/**
 * The most specific group applying to a user-agent token.
 *
 * Matching is a case-insensitive *prefix* match on the product token, which is
 * what real crawlers do: `ClaudeBot` obeys a `User-agent: Claude` group, but
 * nothing obeys a `User-agent: bot` group, because no product token begins
 * with "bot". Substring matching would wrongly hand `bot` every crawler whose
 * name merely contains it — GPTBot, CCBot, Amazonbot — and report a site as
 * blocking eight answer engines when it blocks none of them.
 */
function groupFor(parsed, userAgent) {
  const needle = String(userAgent || '').toLowerCase();
  let best = null;
  let bestLength = -1;
  let wildcard = null;

  for (const group of parsed.groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        wildcard = wildcard || group;
        continue;
      }
      // Longest matching prefix wins, so a group naming `Claude-SearchBot`
      // beats a broader `Claude` group for that one crawler.
      if (needle.startsWith(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }
  return best || wildcard || null;
}

/**
 * Decide whether `userAgent` may fetch `path`.
 * Returns the winning rule so the report can quote the exact line at fault.
 */
export function isAllowed(parsed, userAgent, path = '/') {
  const group = groupFor(parsed, userAgent);
  if (!group) return { allowed: true, rule: null, source: 'no-matching-group' };

  let winner = null;
  for (const rule of group.rules) {
    if (!pathMatches(rule.path, path)) continue;
    if (
      !winner ||
      rule.path.length > winner.path.length ||
      (rule.path.length === winner.path.length && rule.type === 'allow')
    ) {
      winner = rule;
    }
  }

  if (!winner) {
    const blanketDisallow = group.rules.some((rule) => rule.type === 'disallow' && rule.path === '/');
    return { allowed: !blanketDisallow, rule: null, source: 'group-default', agents: group.agents };
  }
  return { allowed: winner.type === 'allow', rule: winner, source: 'rule', agents: group.agents };
}

/**
 * Access matrix for every AI crawler at a given path.
 * `explicit` marks crawlers named directly rather than caught by `*`, which is
 * the difference between a deliberate policy and an accident.
 */
export function crawlerMatrix(robotsText, path = '/') {
  const parsed = parseRobots(robotsText);
  const namedAgents = new Set();
  for (const group of parsed.groups) for (const agent of group.agents) namedAgents.add(agent);

  return AI_CRAWLERS.map((crawler) => {
    const verdict = isAllowed(parsed, crawler.token, path);
    return {
      ...crawler,
      allowed: verdict.allowed,
      explicit: namedAgents.has(crawler.token.toLowerCase()),
      rule: verdict.rule ? `${verdict.rule.type === 'allow' ? 'Allow' : 'Disallow'}: ${verdict.rule.path}` : null,
      matchedAgents: verdict.agents || [],
    };
  });
}
