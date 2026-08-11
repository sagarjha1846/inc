/**
 * Audit orchestration.
 *
 * One page audit is four fetches (page, robots.txt, llms.txt, sitemap.xml),
 * one pass of checks, and a score. The tier split happens here rather than in
 * the UI so every surface — worker, CLI, CI action — enforces it identically.
 */

import { fetchOptional, fetchPage, normalizeUrl } from './fetch.js';
import { runChecks, SEVERITY_ORDER } from './checks.js';
import { prioritize, scoreFindings } from './score.js';
import { generateAll } from './generate.js';

export const FREE_ISSUE_LIMIT = 3;

/**
 * Audit a single URL.
 * `tier: 'pro'` unlocks the full finding list and the generated fix files.
 */
export async function auditUrl(input, options = {}) {
  const { tier = 'free', fetchOptions = {}, includeGenerators = true } = options;
  const url = normalizeUrl(input, { allowPrivate: fetchOptions.allowPrivate });
  const startedAt = Date.now();

  const page = await fetchPage(url.toString(), fetchOptions);

  const [robots, llms, sitemapXml] = await Promise.all([
    fetchOptional(page.finalUrl, '/robots.txt', fetchOptions),
    fetchOptional(page.finalUrl, '/llms.txt', fetchOptions),
    fetchOptional(page.finalUrl, '/sitemap.xml', fetchOptions),
  ]);

  // robots.txt often 200s with an HTML error page; treat that as absent.
  const robotsUsable = robots.found && !/^\s*<(!doctype|html)/i.test(robots.body);
  const sitemapUsable = sitemapXml.found && /<(urlset|sitemapindex)\b/i.test(sitemapXml.body);
  const llmsUsable = llms.found && !/^\s*<(!doctype|html)/i.test(llms.body);

  const { findings, ctx } = runChecks({
    url: page.finalUrl,
    page,
    robots: { ...robots, found: robotsUsable },
    llms: { ...llms, found: llmsUsable },
    sitemap: { ...sitemapXml, found: sitemapUsable },
  });

  const scored = scoreFindings(findings);
  const ranked = prioritize(findings);
  const isPro = tier === 'pro';

  const result = {
    tier: isPro ? 'pro' : 'free',
    url: page.finalUrl,
    requestedUrl: url.toString(),
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    http: {
      status: page.status,
      responseMs: page.elapsedMs,
      bytes: page.bytes,
      redirects: page.redirects,
      server: page.headers.server || null,
    },
    score: scored.score,
    grade: scored.grade,
    verdict: scored.verdict,
    categories: scored.categories,
    counts: scored.counts,
    stats: {
      words: ctx.words ?? 0,
      headings: (ctx.headings || []).length,
      scriptShare: Math.round((ctx.scriptRatio || 0) * 100),
      schemaTypes: [...(ctx.schemaTypes || [])],
    },
    crawlers: (ctx.matrix || []).map((crawler) => ({
      token: crawler.token,
      vendor: crawler.vendor,
      surface: crawler.surface,
      purpose: crawler.purpose,
      allowed: crawler.allowed,
      explicit: crawler.explicit,
      rule: crawler.rule,
    })),
    issues: isPro ? ranked : ranked.slice(0, FREE_ISSUE_LIMIT),
    issuesTotal: ranked.length,
    issuesWithheld: isPro ? 0 : Math.max(0, ranked.length - FREE_ISSUE_LIMIT),
    passes: isPro ? findings.filter((item) => item.severity === 'pass') : [],
  };

  if (isPro && includeGenerators) {
    result.generated = generateAll(ctx);
  } else if (!isPro) {
    result.upgrade = {
      message: `Pro unlocks all ${ranked.length} findings plus generated robots.txt, llms.txt, JSON-LD and FAQ schema for this page.`,
    };
  }

  return result;
}

/**
 * Audit several pages of one site and roll the scores up.
 * Sequential by default — this hits someone else's server, and a polite
 * crawler is the difference between a useful tool and an abusive one.
 */
export async function auditSite(urls, options = {}) {
  const { concurrency = 1, delayMs = 400, onProgress, tier = 'free' } = options;
  const targets = [...new Set(urls)];
  const pages = [];

  // Every page is audited in full, whatever tier the caller is on, because the
  // site-level analysis is only meaningful over complete findings: an issue
  // that ranks top-three on one page and fourth on another would otherwise be
  // counted as affecting one page rather than two, and the report would state
  // that wrong number as fact. The tier is applied once, below, to what is
  // *shown* — which is where it belongs.
  const pageOptions = { ...options, tier: 'pro' };

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(async (target) => {
        try {
          return await auditUrl(target, pageOptions);
        } catch (error) {
          return { url: target, error: (error && error.message) || 'audit failed', code: (error && error.code) || 'error', score: null };
        }
      }),
    );
    for (const item of settled) {
      pages.push(item);
      if (onProgress) onProgress(item, pages.length, targets.length);
    }
    if (delayMs && i + concurrency < targets.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const scoredPages = pages.filter((page) => typeof page.score === 'number');
  const average = scoredPages.length
    ? Math.round(scoredPages.reduce((sum, page) => sum + page.score, 0) / scoredPages.length)
    : 0;

  // Issues that recur across pages are template problems — the highest-leverage
  // fixes on the whole site, so they get counted and surfaced separately.
  const recurrence = new Map();
  for (const page of scoredPages) {
    for (const issue of page.issues || []) {
      const entry = recurrence.get(issue.id) || { id: issue.id, title: issue.title, severity: issue.severity, pages: 0, fix: issue.fix };
      entry.pages += 1;
      recurrence.set(issue.id, entry);
    }
  }

  const ranked = [...recurrence.values()].sort((a, b) => {
    const bySpread = b.pages - a.pages;
    return bySpread !== 0 ? bySpread : SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  });

  // Now apply the tier, to the presentation only. Counts on everything shown
  // are computed from the complete findings above, so they are correct; what
  // the free tier changes is how many of them are listed.
  const isPro = tier === 'pro';
  if (!isPro) {
    for (const page of scoredPages) {
      page.tier = 'free';
      page.issues = page.issues.slice(0, FREE_ISSUE_LIMIT);
      page.issuesWithheld = Math.max(0, page.issuesTotal - FREE_ISSUE_LIMIT);
      page.passes = [];
      delete page.generated;
    }
  }

  return {
    tier: isPro ? 'pro' : 'free',
    pagesAudited: scoredPages.length,
    pagesFailed: pages.length - scoredPages.length,
    averageScore: average,
    worst: scoredPages.slice().sort((a, b) => a.score - b.score)[0] || null,
    best: scoredPages.slice().sort((a, b) => b.score - a.score)[0] || null,
    sitewideIssues: isPro ? ranked : ranked.slice(0, FREE_ISSUE_LIMIT),
    sitewideIssuesTotal: ranked.length,
    sitewideIssuesWithheld: isPro ? 0 : Math.max(0, ranked.length - FREE_ISSUE_LIMIT),
    pages,
  };
}

/**
 * Pull candidate URLs out of a sitemap, including one level of sitemap-index
 * expansion.
 */
export async function urlsFromSitemap(siteUrl, options = {}) {
  const { limit = 20, fetchOptions = {} } = options;
  const root = normalizeUrl(siteUrl, { allowPrivate: fetchOptions.allowPrivate });
  const seen = [];

  const collect = async (target, depth) => {
    if (seen.length >= limit || depth > 1) return;
    const response = await fetchOptional(target, '', fetchOptions);
    if (!response.found) return;
    const isIndex = /<sitemapindex\b/i.test(response.body);
    const locs = [...response.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]);
    if (isIndex) {
      for (const loc of locs.slice(0, 3)) {
        await collect(loc, depth + 1);
        if (seen.length >= limit) return;
      }
      return;
    }
    for (const loc of locs) {
      if (seen.length >= limit) return;
      if (!seen.includes(loc)) seen.push(loc);
    }
  };

  await collect(new URL('/sitemap.xml', root).toString(), 0);
  if (!seen.length) seen.push(root.toString());
  return seen.slice(0, limit);
}
