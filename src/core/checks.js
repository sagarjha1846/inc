/**
 * The audit rules.
 *
 * Each check returns findings shaped for both the scorer and the report, so a
 * finding carries three things at once: what was observed (with evidence a
 * skeptical developer can verify by hand), what it costs in AI visibility, and
 * the exact change that fixes it. A check that passes still emits a finding —
 * a clean bill of health is part of what an audit is for.
 */

import {
  countTag,
  findTags,
  flattenJsonLd,
  headings as extractHeadings,
  htmlLang,
  jsonLdBlocks,
  jsonLdTypes,
  linkRel,
  mainContent,
  links as extractLinks,
  meta,
  metaTags,
  strandedProse,
  title as extractTitle,
  visibleText,
  wordCount,
} from './html.js';
import { CITATION_CRAWLERS, crawlerMatrix } from './robots.js';
import { registrableDomain } from './fetch.js';
import { LLMS_PLACEHOLDER_MARKER } from './generate.js';

/** Category weights sum to 100 — the headline score is a straight percentage. */
export const CATEGORIES = {
  access: { label: 'Crawler access', weight: 30, blurb: 'Whether AI crawlers are permitted to fetch the page at all.' },
  content: { label: 'Readable content', weight: 25, blurb: 'Whether the answer text exists in the HTML without running JavaScript.' },
  structure: { label: 'Answer structure', weight: 15, blurb: 'Whether the page is shaped so a model can lift a clean answer from it.' },
  schema: { label: 'Structured data', weight: 15, blurb: 'Machine-readable facts that let an engine attribute and trust the page.' },
  metadata: { label: 'Metadata', weight: 10, blurb: 'The title, description and canonical signals used in citations.' },
  authority: { label: 'Authority signals', weight: 5, blurb: 'Authorship, freshness and sourcing that raise citation confidence.' },
};

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'pass'];

function finding(input) {
  return {
    id: input.id,
    category: input.category,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    evidence: input.evidence ?? null,
    impact: input.impact ?? null,
    fix: input.fix ?? null,
    earned: input.earned,
    max: input.max,
  };
}

/* ------------------------------------------------------------------ access */

/**
 * Meta names that address one crawler rather than all of them. Anything else
 * named in a `<meta>` is not a robots directive at all, so it must not be read
 * as one — `<meta name="description" content="how to use noindex">` is prose.
 */
const KNOWN_BOT_META = new Set([
  'googlebot',
  'googlebot-news',
  'google-extended',
  'bingbot',
  'msnbot',
  'slurp',
  'duckduckbot',
  'baiduspider',
  'yandex',
  'applebot',
]);

/**
 * Split an `X-Robots-Tag` header into its scopes.
 *
 * The header may carry bare directives, or prefix them with a crawler name:
 * `X-Robots-Tag: googlebot: noindex, nosnippet`. A bare list binds everyone; a
 * prefixed one binds only that crawler, and the prefix governs the directives
 * that follow it until another prefix appears.
 */
function parseXRobotsTag(value) {
  const out = [];
  let scope = '';
  let buffer = [];

  const flush = () => {
    if (buffer.length) {
      out.push({
        scope,
        source: scope ? `X-Robots-Tag (${scope})` : 'X-Robots-Tag',
        text: buffer.join(',').toLowerCase(),
      });
    }
    buffer = [];
  };

  for (const segment of String(value || '').split(',')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // `max-snippet: 0` is a directive with a colon, not a crawler prefix, so a
    // prefix only counts when the name before the colon is a known crawler.
    const match = /^([a-z0-9][a-z0-9._-]*)\s*:\s*(.*)$/i.exec(trimmed);
    if (match && KNOWN_BOT_META.has(match[1].toLowerCase())) {
      flush();
      scope = match[1].toLowerCase();
      if (match[2]) buffer.push(match[2]);
      continue;
    }
    buffer.push(trimmed);
  }
  flush();
  return out;
}

function checkAccess(ctx) {
  const out = [];
  const { page, robots, url } = ctx;
  const path = new URL(url).pathname || '/';

  // 1. The page has to respond at all.
  if (page.status >= 400 || !page.ok) {
    out.push(
      finding({
        id: 'http-status',
        category: 'access',
        severity: 'critical',
        title: `Page returns HTTP ${page.status}`,
        detail: `A crawler asking for this URL gets ${page.status}, so there is nothing to index or cite.`,
        evidence: `HTTP ${page.status} from ${page.finalUrl}`,
        impact: 'Every answer engine. A non-200 page cannot be cited.',
        fix: 'Fix the status code before anything else in this report matters.',
        earned: 0,
        max: 8,
      }),
    );
  } else {
    out.push(
      finding({
        id: 'http-status',
        category: 'access',
        severity: 'pass',
        title: `Page responds ${page.status}`,
        detail: `Served in ${page.elapsedMs}ms${page.redirects.length ? ` after ${page.redirects.length} redirect(s)` : ''}.`,
        evidence: page.redirects.length ? page.redirects.map((hop) => `${hop.status} ${hop.from} → ${hop.to}`).join('\n') : `HTTP ${page.status}`,
        earned: 8,
        max: 8,
      }),
    );
  }

  // 2. robots.txt policy per AI crawler — the single biggest lever.
  //
  // "We asked and there is none" and "we could not ask" are different facts,
  // and only the first supports a conclusion. Reporting a failed fetch as an
  // absent file told a client "you are not blocked" about a site that might be
  // blocking every crawler this product exists to check — and the crawler
  // matrix, the headline table, came back empty with no explanation. A DNS
  // blip, a timeout or a WAF is enough to produce it.
  const robotsUnreachable = !robots.found && !robots.status;
  if (robotsUnreachable) {
    ctx.robotsUnreachable = true;
    out.push(
      finding({
        id: 'robots-unreachable',
        category: 'access',
        severity: 'medium',
        title: 'robots.txt could not be fetched, so crawler access is unverified',
        detail:
          'The request for robots.txt failed rather than returning "not found", so this report cannot say which AI crawlers are allowed — the single thing it weighs most heavily. Treat the crawler section as missing, not as clear.',
        evidence: `${robots.url || '/robots.txt'} → ${robots.error || 'no response'}`,
        impact: 'Unknown. If the file exists and disallows the citation crawlers, this page is invisible to those engines and nothing here would show it.',
        fix: 'Re-run the audit. If it keeps failing, fetch the file yourself — a firewall or bot rule that blocks this check may be blocking answer-engine crawlers too.',
        // Scored as the absent case rather than as a failure: the site should
        // not lose points for our network, and must not gain a clean bill for
        // it either, which is why this is a finding and not a pass.
        earned: 8,
        max: 10,
      }),
    );
  } else if (!robots.found) {
    out.push(
      finding({
        id: 'robots-missing',
        category: 'access',
        severity: 'low',
        title: 'No robots.txt found',
        detail:
          'Missing robots.txt means crawlers assume everything is permitted, so you are not blocked — but you also have no explicit invitation for AI crawlers, and no place to declare a sitemap.',
        evidence: `${robots.url || '/robots.txt'} → ${robots.status || 'no response'}`,
        impact: 'Nothing is blocked today, but the policy is accidental rather than chosen.',
        fix: 'Publish a robots.txt that explicitly allows the answer-engine crawlers you want citations from, and declares your sitemap.',
        earned: 8,
        max: 10,
      }),
    );
  } else {
    const matrix = crawlerMatrix(robots.body, path);
    ctx.matrix = matrix;
    const blocked = matrix.filter((crawler) => !crawler.allowed);
    const blockedCitation = blocked.filter(
      (crawler) => crawler.purpose === 'citation' || crawler.purpose === 'live-fetch',
    );

    const citationWeight = CITATION_CRAWLERS.reduce((sum, crawler) => sum + crawler.weight, 0);
    const lostWeight = blockedCitation.reduce((sum, crawler) => sum + crawler.weight, 0);
    const earned = Math.round(10 * (1 - lostWeight / citationWeight));

    if (blockedCitation.length) {
      // Severity follows what is actually lost, not a share of total weight.
      // If a vendor's indexing crawler is blocked, the site is absent from
      // that engine's answers entirely — losing one whole answer engine is a
      // blocker regardless of how many other crawlers are still allowed.
      const lostEngines = [
        ...new Set(
          blockedCitation
            .filter((crawler) => crawler.purpose === 'citation' && crawler.weight >= 3)
            .map((crawler) => crawler.surface),
        ),
      ];

      out.push(
        finding({
          id: 'ai-crawlers-blocked',
          category: 'access',
          severity: lostEngines.length ? 'critical' : 'high',
          title: lostEngines.length
            ? `Invisible to ${lostEngines.join(' and ')} — blocked by robots.txt`
            : `${blockedCitation.length} answer-engine crawler(s) blocked by robots.txt`,
          detail:
            'These crawlers are the ones that fetch pages in order to answer live questions. While they are disallowed, this page cannot appear as a citation in the surfaces listed below, no matter how good the content is.',
          evidence: blockedCitation
            .map((crawler) => `${crawler.token} (${crawler.surface}) — blocked by "${crawler.rule || 'group default'}"${crawler.explicit ? '' : ' via the wildcard User-agent: * group'}`)
            .join('\n'),
          impact: blockedCitation.map((crawler) => crawler.surface).join(', '),
          fix: 'Add explicit Allow rules for these user-agents (see the generated robots.txt patch in this report).',
          earned: Math.max(0, earned),
          max: 10,
        }),
      );
    } else {
      out.push(
        finding({
          id: 'ai-crawlers-blocked',
          category: 'access',
          severity: 'pass',
          title: 'All answer-engine crawlers are allowed',
          detail: 'Every crawler that fetches pages to answer live questions can reach this URL.',
          evidence: CITATION_CRAWLERS.map((crawler) => `${crawler.token} → allowed`).join('\n'),
          earned: 10,
          max: 10,
        }),
      );
    }

    const blockedTraining = blocked.filter((crawler) => crawler.purpose === 'training');
    if (blockedTraining.length) {
      out.push(
        finding({
          id: 'training-crawlers-blocked',
          category: 'access',
          severity: 'low',
          title: `${blockedTraining.length} training crawler(s) blocked`,
          detail:
            'This may well be deliberate — blocking training crawlers protects your content from being absorbed into model weights. It does cost you baseline brand recall inside the models themselves. Flagged so the trade-off is a decision, not an accident.',
          evidence: blockedTraining.map((crawler) => `${crawler.token} (${crawler.vendor}) — ${crawler.rule || 'group default'}`).join('\n'),
          impact: 'Lower unprompted brand recall when users ask models without live search.',
          fix: 'No action needed if this is intentional policy.',
          earned: 2,
          max: 2,
        }),
      );
    } else {
      out.push(
        finding({
          id: 'training-crawlers-blocked',
          category: 'access',
          severity: 'pass',
          title: 'Training crawlers are allowed',
          detail: 'Your content can be absorbed into model knowledge, which supports unprompted brand recall.',
          earned: 2,
          max: 2,
        }),
      );
    }
  }

  // 3. Snippet-suppressing directives, in meta and in headers.
  //
  // Scope is the whole point here. A directive addressed to one crawler binds
  // only that crawler: `<meta name="googlebot" content="noindex">` keeps a page
  // out of Google, and does nothing at all to ChatGPT or Perplexity. Matching
  // the word "noindex" anywhere and calling the page suppressed reports a site
  // as invisible to every answer engine when it deliberately opted out of one.
  const allMeta = metaTags(ctx.html);
  const scopes = [
    { scope: '', source: 'meta robots', text: (allMeta.get('robots') || []).join(',').toLowerCase() },
    ...[...allMeta.keys()]
      .filter((name) => name !== 'robots' && KNOWN_BOT_META.has(name))
      .map((name) => ({ scope: name, source: `meta ${name}`, text: (allMeta.get(name) || []).join(',').toLowerCase() })),
    ...parseXRobotsTag(String(page.headers['x-robots-tag'] || '')),
  ].filter((entry) => entry.text);

  const suppressing = [];
  for (const entry of scopes) {
    const found = [];
    if (/\bnoindex\b/.test(entry.text)) found.push('noindex');
    if (/\bnosnippet\b/.test(entry.text)) found.push('nosnippet');
    if (/\bnoarchive\b/.test(entry.text)) found.push('noarchive');
    if (/max-snippet\s*:\s*0\b/.test(entry.text)) found.push('max-snippet:0');
    if (/\bnoai\b/.test(entry.text)) found.push('noai');
    if (found.length) suppressing.push({ ...entry, found });
  }

  const global = suppressing.filter((entry) => !entry.scope);
  const scoped = suppressing.filter((entry) => entry.scope);

  if (global.length) {
    const blockers = [...new Set(global.flatMap((entry) => entry.found))];
    out.push(
      finding({
        id: 'snippet-directives',
        category: 'access',
        severity: blockers.includes('noindex') ? 'critical' : 'high',
        title: `Robots directives suppress this page: ${blockers.join(', ')}`,
        detail:
          'Even with crawling allowed, these directives tell engines not to index the page or not to quote from it. They are addressed to every crawler, so AI Overviews and search-backed assistants fetch the page and then discard it.',
        evidence: suppressing.map((entry) => `${entry.source}: ${entry.text}`).join('\n'),
        impact: 'Google AI Overviews, Bing/Copilot, and any engine that respects snippet controls.',
        fix: 'Remove the offending directives, or set `max-snippet:-1` if you had capped snippet length.',
        earned: 0,
        max: 6,
      }),
    );
  } else if (scoped.length) {
    const names = [...new Set(scoped.map((entry) => entry.scope))];
    out.push(
      finding({
        id: 'snippet-directives',
        category: 'access',
        severity: 'medium',
        title: `Suppressed for ${names.join(', ')} only`,
        detail:
          'These directives name a specific crawler, so they bind that crawler alone. Other answer engines may still index and quote this page. Flagged because opting out of one search surface is usually deliberate, and worth confirming it was.',
        evidence: scoped.map((entry) => `${entry.source}: ${entry.text}`).join('\n'),
        impact: names.some((name) => name.includes('google'))
          ? 'Google AI Overviews only. ChatGPT, Claude and Perplexity are unaffected.'
          : 'Limited to the named crawler.',
        fix: 'No action needed if this opt-out is intentional.',
        earned: 4,
        max: 6,
      }),
    );
  } else {
    out.push(
      finding({
        id: 'snippet-directives',
        category: 'access',
        severity: 'pass',
        title: 'No snippet-suppressing robots directives',
        detail: 'Nothing in the page or headers tells engines to withhold this content from answers.',
        earned: 6,
        max: 6,
      }),
    );
  }

  // 4. HTTPS.
  const isHttps = new URL(page.finalUrl).protocol === 'https:';
  out.push(
    finding({
      id: 'https',
      category: 'access',
      severity: isHttps ? 'pass' : 'medium',
      title: isHttps ? 'Served over HTTPS' : 'Not served over HTTPS',
      detail: isHttps
        ? 'Transport is secure, which every crawler expects by default.'
        : 'Plain HTTP is downranked or refused by several crawlers and looks untrustworthy as a citation source.',
      fix: isHttps ? null : 'Issue a certificate (free via Let’s Encrypt) and redirect HTTP to HTTPS.',
      earned: isHttps ? 2 : 0,
      max: 2,
    }),
  );

  // 5. llms.txt — the emerging convention for handing models a curated map.
  if (ctx.llms.found && ctx.llms.body.trim().length > 40) {
    const hasHeading = /^\s*#\s+\S/m.test(ctx.llms.body);
    const linkLines = (ctx.llms.body.match(/^\s*-\s*\[[^\]]+\]\([^)]+\)/gm) || []).length;

    // The generated starter file ships placeholder links — /about, /docs,
    // /changelog — and says so in a line the author is meant to delete along
    // with them. Published unedited it satisfies every shape test above while
    // pointing a model at pages that mostly 404, and the audit would confirm
    // it as well-formed: the tool blessing a state it caused.
    const unedited = ctx.llms.body.includes(LLMS_PLACEHOLDER_MARKER);
    const wellFormed = hasHeading && linkLines >= 3 && !unedited;

    out.push(
      finding({
        id: 'llms-txt',
        category: 'access',
        severity: wellFormed ? 'pass' : 'low',
        title: wellFormed
          ? 'llms.txt is published and well-formed'
          : unedited
            ? 'llms.txt is still the unedited starter file'
            : 'llms.txt exists but is thin',
        detail: wellFormed
          ? `Found ${linkLines} curated link(s) under a top-level heading — this is what a model reads to orient itself on your site.`
          : unedited
            ? 'The file still contains the generated instructions and their placeholder links, which point at pages most sites do not have. A model following them reaches 404s, which is worse than publishing nothing.'
            : 'The file is present but does not follow the expected shape: an H1 with your site name, a blockquote summary, then linked sections.',
        evidence: ctx.llms.body.slice(0, 400),
        fix: wellFormed
          ? null
          : unedited
            ? 'Replace the placeholder links with your real pages and delete the instruction paragraph above them.'
            : 'Use the generated llms.txt in this report as a starting point.',
        earned: wellFormed ? 2 : 1,
        max: 2,
      }),
    );
  } else {
    out.push(
      finding({
        id: 'llms-txt',
        category: 'access',
        severity: 'low',
        title: 'No llms.txt published',
        detail:
          'llms.txt is a plain-Markdown index at your site root that tells models what your site is and which pages matter. Adoption is early, the cost is one file, and it is one of the few levers with no downside.',
        evidence: `${ctx.llms.url || '/llms.txt'} → ${ctx.llms.status || 'not found'}`,
        impact: 'Missed orientation for agents that look for it before crawling.',
        fix: 'Publish the generated llms.txt included in this report at https://yourdomain/llms.txt.',
        earned: 0,
        max: 2,
      }),
    );
  }

  // 6. Sitemap discoverability.
  const sitemapDeclared = robots.found && /^\s*sitemap\s*:/im.test(robots.body);
  const sitemapFound = ctx.sitemap.found;
  out.push(
    finding({
      id: 'sitemap',
      // Present but undeclared is a real gap, not a clean pass. Reporting it as
      // a pass while still withholding points would leave the user with every
      // check green and a score under 100, and nothing explaining the
      // difference.
      severity: sitemapFound ? (sitemapDeclared ? 'pass' : 'low') : 'medium',
      category: 'access',
      title: sitemapFound ? `Sitemap available${sitemapDeclared ? ' and declared in robots.txt' : ' but not declared in robots.txt'}` : 'No sitemap found',
      detail: sitemapFound
        ? `Crawlers can enumerate your pages from ${ctx.sitemap.url}.${sitemapDeclared ? '' : ' It is not declared in robots.txt, so discovery depends on the conventional path.'}`
        : 'Without a sitemap, crawlers discover pages only by following links, which leaves deep or newly published pages unindexed for longer.',
      fix: sitemapFound && sitemapDeclared ? null : 'Publish /sitemap.xml and add a `Sitemap:` line to robots.txt.',
      earned: sitemapFound ? (sitemapDeclared ? 2 : 1.5) : 0,
      max: 2,
    }),
  );

  return out;
}

/* ----------------------------------------------------------------- content */

function checkContent(ctx) {
  const out = [];
  const { html, text } = ctx;
  const words = wordCount(text);
  ctx.words = words;

  // JS dependence: the defining failure mode for SPA marketing sites.
  // Measured by subtraction so an unclosed <script> — which a parser treats as
  // running to the end of the document — is counted rather than reported as
  // 0% script in the evidence shown to the user.
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*$/i, '');
  const scriptBytes = html.length - withoutScripts.length;
  const scriptRatio = html.length ? scriptBytes / html.length : 0;
  const mountShell = /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html);
  ctx.scriptRatio = scriptRatio;

  // A high script ratio is *not* evidence of client rendering. It only says
  // there is little text relative to script bytes, which is equally true of a
  // short but perfectly server-rendered page carrying an ordinary analytics
  // snippet — and calling that "rendered by JavaScript" sends someone to
  // re-architect a site that has no such problem.
  //
  // What distinguishes a shell is that the content-bearing markup is *absent*:
  // an empty mount element, or a body with no prose elements at all. A short
  // page that has headings, paragraphs or list items was server-rendered; it is
  // thin, which is a different finding with a different fix.
  const proseElements =
    countTag(html, 'p') + countTag(html, 'li') + countTag(html, 'td') + extractHeadings(html).length;
  const looksLikeShell = mountShell || (proseElements === 0 && words < 25);

  if (words < 120 && looksLikeShell) {
    out.push(
      finding({
        id: 'js-rendered',
        category: 'content',
        severity: 'critical',
        title: 'Content is rendered by JavaScript, not present in the HTML',
        detail: `Only ${words} words survive in the raw HTML. Most AI crawlers do not execute JavaScript — they read exactly what the server sent, which here is an empty shell. To those engines this page is blank.`,
        evidence: `${words} words in raw HTML · ${Math.round(scriptRatio * 100)}% of the document is <script>${mountShell ? ' · empty mount element detected' : ''}`,
        impact: 'GPTBot, ClaudeBot, PerplexityBot and most non-Google crawlers see nothing to cite.',
        fix: 'Server-render or statically pre-render the page. Every major framework supports this (Next.js SSG/SSR, Nuxt, Astro, or a prerender service in front of the app).',
        earned: 0,
        max: 14,
      }),
    );
  } else if (words < 300) {
    out.push(
      finding({
        id: 'js-rendered',
        category: 'content',
        severity: words < 150 ? 'high' : 'medium',
        title: 'Thin server-rendered content',
        detail: `${words} words are present without JavaScript. That is enough to prove the page is not an empty shell, but thin for a page you want quoted as an authority.`,
        evidence: `${words} words · ${Math.round(scriptRatio * 100)}% script`,
        impact: 'Engines prefer sources with enough substance to answer follow-up questions.',
        fix: 'Aim for 600+ words of substantive, server-rendered prose on pages you want cited.',
        earned: words < 150 ? 5 : 9,
        max: 14,
      }),
    );
  } else {
    out.push(
      finding({
        id: 'js-rendered',
        category: 'content',
        severity: 'pass',
        title: 'Content is server-rendered and readable without JavaScript',
        detail: `${words} words are present in the raw HTML, so a non-JS crawler sees the full page.`,
        evidence: `${words} words · ${Math.round(scriptRatio * 100)}% script`,
        earned: 14,
        max: 14,
      }),
    );
  }

  // Depth relative to what gets cited in practice, measured on the page's own
  // content. Nav and footer links appear on every page of a site, so counting
  // them reports a thin page as a deep one.
  const contentHtml = mainContent(html);
  const contentText = visibleText(contentHtml);
  const contentWords = wordCount(contentText);
  ctx.contentHtml = contentHtml;
  ctx.contentText = contentText;
  ctx.contentWords = contentWords;

  // Deliberately not the document-wide `words` above: that one answers "what
  // does a crawler receive", which is the right question for client rendering.
  // This one answers "how much of it is this page's own substance".
  const depthScore =
    contentWords >= 900 ? 6 : contentWords >= 500 ? 5 : contentWords >= 300 ? 3.5 : contentWords >= 150 ? 2 : 0;
  const chromeWords = words - contentWords;

  // A low count has two causes that call for opposite fixes, and the number
  // alone cannot tell them apart. Either the page really is thin, or it has the
  // prose and put it somewhere extractors discard — a hero paragraph inside
  // `<header>`, a summary in an `<aside>`. Telling the second author to "expand
  // the page" is worse than useless: they write more copy into the same
  // excluded element, nothing changes, and the tool looks broken.
  //
  // Paragraphs outside the content region are the evidence for the second case.
  // They are counted rather than inferred from the chrome total, because most
  // excluded words on a normal page are navigation, which nobody should move.
  const strandedWords = strandedProse(html, contentHtml);
  const misplaced = contentWords < 500 && strandedWords >= 80;
  // Whether moving it is enough on its own, or only the first of two steps.
  const enoughOnceMoved = contentWords + strandedWords >= 500;

  out.push(
    finding({
      id: 'content-depth',
      category: 'content',
      severity: contentWords >= 500 ? 'pass' : contentWords >= 300 ? 'low' : 'medium',
      title: misplaced
        ? `${contentWords} words of readable content, with ${strandedWords} more outside it`
        : `${contentWords} words of readable content`,
      detail:
        contentWords >= 500
          ? 'Enough depth for an engine to extract a specific answer rather than a vague summary.'
          : misplaced
            ? `The prose exists — ${strandedWords} words of it sit in a <header> or <aside>, which extractors treat as site furniture and discard. Only the ${contentWords} words inside the content region are read as this page's answer.`
            : 'Pages cited by answer engines skew long because depth gives the model more extractable claims. This page gives it little to work with.',
      evidence:
        chromeWords > contentWords
          ? `${contentWords} words in the page's own content; ${chromeWords} more are navigation, header or footer, which repeat on every page and are not counted.`
          : null,
      fix: contentWords >= 500
        ? null
        : misplaced
          ? `Move those paragraphs inside <main> or <article>${
            enoughOnceMoved ? '' : ', then expand the page with specifics: definitions, numbers, steps and comparisons'
          }. Writing more copy into <header> or <aside> will not change what an engine reads.`
          : 'Expand the page with specifics: definitions, numbers, steps, comparisons, and edge cases.',
      earned: depthScore,
      max: 6,
    }),
  );

  // Encoding and content type — cheap but genuinely breaks extraction when wrong.
  const contentType = String(ctx.page.headers['content-type'] || '');
  const declaresCharset = /charset=/i.test(contentType) || /<meta[^>]+charset=/i.test(html);
  const isHtmlType = /text\/html|application\/xhtml/i.test(contentType) || !contentType;
  out.push(
    finding({
      id: 'content-type',
      category: 'content',
      severity: isHtmlType && declaresCharset ? 'pass' : 'low',
      title: isHtmlType && declaresCharset ? 'Content type and charset declared correctly' : 'Content type or charset is missing',
      detail: isHtmlType
        ? declaresCharset
          ? `Served as ${contentType || 'text/html'}.`
          : 'No character encoding is declared, which can mangle quotes and accented characters in extracted answers.'
        : `Served as ${contentType}, which is not HTML — crawlers may skip parsing it.`,
      fix: isHtmlType && declaresCharset ? null : 'Send `Content-Type: text/html; charset=utf-8`.',
      earned: isHtmlType && declaresCharset ? 3 : 1,
      max: 3,
    }),
  );

  // Truncation is worth surfacing: very large documents get cut by real crawlers too.
  if (ctx.page.truncated) {
    out.push(
      finding({
        id: 'page-size',
        category: 'content',
        severity: 'medium',
        title: 'Page is very large',
        detail: `The document exceeded ${Math.round(ctx.page.bytes / 1024)}KB and was truncated during analysis. Crawlers apply their own limits, so content past the cut may never be read.`,
        fix: 'Reduce page weight, or move the important content nearer the top of the document.',
        earned: 0,
        max: 2,
      }),
    );
  } else {
    out.push(
      finding({
        id: 'page-size',
        category: 'content',
        severity: 'pass',
        title: `Document size is reasonable (${Math.round(ctx.page.bytes / 1024)}KB)`,
        detail: 'The whole document fits comfortably inside normal crawler fetch limits.',
        earned: 2,
        max: 2,
      }),
    );
  }

  return out;
}

/* --------------------------------------------------------------- structure */

function checkStructure(ctx) {
  const out = [];
  const { html, text } = ctx;
  const heads = extractHeadings(html);
  ctx.headings = heads;
  const h1s = heads.filter((heading) => heading.level === 1);

  if (h1s.length === 1) {
    out.push(
      finding({
        id: 'h1',
        category: 'structure',
        severity: 'pass',
        title: 'Exactly one H1',
        detail: `"${h1s[0].text.slice(0, 120)}" — a single unambiguous topic statement is what an engine attaches the page's meaning to.`,
        earned: 4,
        max: 4,
      }),
    );
  } else {
    out.push(
      finding({
        id: 'h1',
        category: 'structure',
        severity: h1s.length === 0 ? 'high' : 'low',
        title: h1s.length === 0 ? 'No H1 on the page' : `${h1s.length} H1 elements`,
        detail:
          h1s.length === 0
            ? 'Without an H1 the engine has to infer the page topic from the title tag alone, which weakens topical matching.'
            : 'Multiple H1s split the page topic, making it ambiguous which claim the page is authoritative about.',
        evidence: h1s.map((heading) => heading.text.slice(0, 80)).join('\n') || '(none)',
        fix: 'Use exactly one H1 that states the page topic in the words a user would search for.',
        earned: h1s.length === 0 ? 0 : 2,
        max: 4,
      }),
    );
  }

  // Hierarchy: skipped levels break the outline a model builds of the page.
  const skips = [];
  for (let i = 1; i < heads.length; i += 1) {
    if (heads[i].level - heads[i - 1].level > 1) {
      skips.push(`H${heads[i - 1].level} → H${heads[i].level} at "${heads[i].text.slice(0, 60)}"`);
    }
  }
  const subheads = heads.filter((heading) => heading.level >= 2).length;
  out.push(
    finding({
      id: 'heading-hierarchy',
      category: 'structure',
      severity: subheads === 0 ? 'medium' : skips.length > 2 ? 'low' : 'pass',
      title:
        subheads === 0
          ? 'No subheadings to break up the page'
          : skips.length
            ? `${subheads} subheadings, ${skips.length} level skip(s)`
            : `${subheads} subheadings in a clean hierarchy`,
      detail:
        subheads === 0
          ? 'A wall of text forces the model to guess where an answer starts and stops. Subheadings are the chunk boundaries retrieval systems split on.'
          : skips.length
            ? 'Skipped heading levels muddle the outline an engine derives from the page.'
            : 'The heading outline gives retrieval clean chunk boundaries to work with.',
      evidence: skips.slice(0, 5).join('\n') || null,
      fix: subheads === 0 ? 'Break the content into H2 sections, one per question the page answers.' : skips.length ? 'Keep heading levels sequential.' : null,
      earned: subheads === 0 ? 0 : skips.length > 2 ? 2 : 4,
      max: 4,
    }),
  );

  // Question-shaped headings map directly onto the prompts people type.
  const questionHeads = heads.filter((heading) => /\?\s*$/.test(heading.text) || /^(how|what|why|when|where|who|which|can|do|does|is|are|should)\b/i.test(heading.text));
  out.push(
    finding({
      id: 'question-headings',
      category: 'structure',
      severity: questionHeads.length >= 2 ? 'pass' : 'low',
      title: questionHeads.length ? `${questionHeads.length} question-style heading(s)` : 'No question-style headings',
      detail:
        questionHeads.length >= 2
          ? 'Headings phrased as questions match user prompts almost literally, which is the cleanest retrieval signal you can give.'
          : 'People ask answer engines questions. Headings that mirror those questions get matched and lifted far more often than noun-phrase headings.',
      evidence: questionHeads.slice(0, 4).map((heading) => heading.text.slice(0, 80)).join('\n') || null,
      fix: questionHeads.length >= 2 ? null : 'Rewrite key H2s as the question a user would actually ask, and answer it in the first sentence below.',
      earned: questionHeads.length >= 2 ? 3 : questionHeads.length === 1 ? 1.5 : 0,
      max: 3,
    }),
  );

  // Lists and tables are disproportionately quoted by answer engines — but a
  // nav menu and a footer link list are neither, and every page on the site
  // carries them.
  const contentMarkup = ctx.contentHtml || mainContent(html);
  const lists = countTag(contentMarkup, 'ul') + countTag(contentMarkup, 'ol');
  const tables = countTag(contentMarkup, 'table');
  out.push(
    finding({
      id: 'extractable-blocks',
      category: 'structure',
      severity: lists + tables > 0 ? 'pass' : 'low',
      title: lists + tables > 0 ? `${lists} list(s) and ${tables} table(s)` : 'No lists or tables',
      detail:
        lists + tables > 0
          ? 'Lists and tables are the formats answer engines quote most readily, because the structure survives extraction.'
          : 'Prose-only pages lose to competitors whose steps, specs or comparisons are already in list or table form.',
      fix: lists + tables > 0 ? null : 'Convert steps, criteria and comparisons into lists or a table.',
      earned: lists + tables > 0 ? 2 : 0,
      max: 2,
    }),
  );

  // A direct answer near the top is what gets lifted verbatim. Taken from the
  // content region, because the first long line in the raw document is
  // routinely a cookie notice — and quoting that back as the page's answer is
  // both wrong and embarrassing in a report someone paid for.
  const openingSource = ctx.contentText || visibleText(mainContent(html));
  const opening = openingSource.split('\n').filter((line) => line.trim().length > 60)[0] || '';
  const hasDirectOpening = opening.length >= 60 && opening.length <= 400;
  out.push(
    finding({
      id: 'direct-answer',
      category: 'structure',
      severity: hasDirectOpening ? 'pass' : 'low',
      title: hasDirectOpening ? 'Opens with a self-contained paragraph' : 'No clear summary paragraph near the top',
      detail: hasDirectOpening
        ? 'The first substantial paragraph is a quotable length, which is what engines lift as the answer.'
        : 'Engines lift the first self-contained paragraph that answers the page’s implied question. Without one they either skip the page or quote something arbitrary.',
      evidence: opening ? `${opening.slice(0, 200)}${opening.length > 200 ? '…' : ''}` : null,
      fix: hasDirectOpening ? null : 'Open with a 40–60 word paragraph that answers the page’s core question outright, before any preamble.',
      earned: hasDirectOpening ? 2 : 0,
      max: 2,
    }),
  );

  return out;
}

/* ------------------------------------------------------------------ schema */

function checkSchema(ctx) {
  const out = [];
  const blocks = jsonLdBlocks(ctx.html);
  const nodes = flattenJsonLd(blocks);
  const types = jsonLdTypes(nodes);
  ctx.schemaTypes = types;
  // Kept for the authority checks, which must read declared facts rather than
  // regex the raw document.
  ctx.schemaNodes = nodes;

  const broken = blocks.filter((block) => !block.ok);

  if (!blocks.length) {
    out.push(
      finding({
        id: 'jsonld-present',
        category: 'schema',
        severity: 'high',
        title: 'No JSON-LD structured data',
        detail:
          'Structured data is how you state facts about the page in a form no model has to infer: who wrote it, what it is about, when it changed, what entity it belongs to. Without it, attribution depends entirely on the engine guessing correctly.',
        impact: 'Weaker entity association and lower citation confidence across every engine.',
        fix: 'Add a JSON-LD block — the report generates one tailored to this page.',
        earned: 0,
        max: 7,
      }),
    );
  } else if (broken.length) {
    out.push(
      finding({
        id: 'jsonld-present',
        category: 'schema',
        severity: 'high',
        title: `${broken.length} JSON-LD block(s) contain invalid JSON`,
        detail: 'A malformed block is discarded entirely by parsers, so the markup you wrote is doing nothing at all.',
        evidence: broken.map((block) => `${block.error}\n${block.raw.slice(0, 200)}`).join('\n---\n'),
        fix: 'Fix the JSON syntax and re-validate. A single trailing comma silently voids the whole block.',
        earned: 1,
        max: 7,
      }),
    );
  } else {
    out.push(
      finding({
        id: 'jsonld-present',
        category: 'schema',
        severity: 'pass',
        title: `Valid JSON-LD present (${[...types].slice(0, 6).join(', ') || 'untyped'})`,
        detail: `${blocks.length} block(s) parsed cleanly, describing ${nodes.length} entity node(s).`,
        earned: 7,
        max: 7,
      }),
    );
  }

  // Entity identity — the difference between "a page" and "a page by someone".
  const hasOrgOrPerson = types.has('organization') || types.has('person') || types.has('localbusiness');
  out.push(
    finding({
      id: 'entity-schema',
      category: 'schema',
      severity: hasOrgOrPerson ? 'pass' : 'medium',
      title: hasOrgOrPerson ? 'Publisher entity is declared' : 'No Organization or Person entity',
      detail: hasOrgOrPerson
        ? 'The page names the entity behind it, which is what engines use to connect this content to your brand.'
        : 'Nothing on the page tells an engine which organisation or person stands behind it, so citations are less likely to name you.',
      fix: hasOrgOrPerson ? null : 'Add an Organization node with `name`, `url`, `logo` and `sameAs` links to your official profiles.',
      earned: hasOrgOrPerson ? 4 : 0,
      max: 4,
    }),
  );

  // Content-type schema.
  const contentTypes = ['article', 'blogposting', 'newsarticle', 'faqpage', 'howto', 'product', 'softwareapplication', 'webpage', 'techarticle', 'qapage', 'recipe', 'course', 'event', 'service'];
  const hasContentSchema = contentTypes.some((type) => types.has(type));
  out.push(
    finding({
      id: 'content-schema',
      category: 'schema',
      severity: hasContentSchema ? 'pass' : 'medium',
      title: hasContentSchema ? 'Page-type schema present' : 'No page-type schema (Article, FAQPage, HowTo, Product…)',
      detail: hasContentSchema
        ? `Declared as ${[...types].filter((type) => contentTypes.includes(type)).join(', ')}, which tells engines how to treat the content.`
        : 'Typing the page tells engines what kind of answer it can serve. FAQPage and HowTo in particular map straight onto the question formats users ask.',
      fix: hasContentSchema ? null : 'Add the schema.org type that matches this page, with its required fields populated.',
      earned: hasContentSchema ? 4 : 0,
      max: 4,
    }),
  );

  return out;
}

/* ---------------------------------------------------------------- metadata */

function checkMetadata(ctx) {
  const out = [];
  const { html, url } = ctx;

  const pageTitle = extractTitle(html);
  const titleOk = pageTitle.length >= 15 && pageTitle.length <= 70;
  out.push(
    finding({
      id: 'title',
      category: 'metadata',
      severity: pageTitle ? (titleOk ? 'pass' : 'low') : 'high',
      title: pageTitle ? (titleOk ? 'Title tag is well-sized' : `Title is ${pageTitle.length} characters`) : 'Missing title tag',
      detail: pageTitle
        ? titleOk
          ? `"${pageTitle}"`
          : `"${pageTitle}" — titles outside roughly 15–70 characters get truncated or read as low-effort.`
        : 'The title is the strongest single statement of what the page is about, and it is the text most citations display.',
      fix: pageTitle && titleOk ? null : 'Write a 40–60 character title stating the page topic in the user’s own words.',
      earned: pageTitle ? (titleOk ? 3 : 1.5) : 0,
      max: 3,
    }),
  );

  const description = meta(html, 'description');
  const descOk = description.length >= 70 && description.length <= 200;
  out.push(
    finding({
      id: 'description',
      category: 'metadata',
      severity: description ? (descOk ? 'pass' : 'low') : 'medium',
      title: description ? (descOk ? 'Meta description is well-sized' : `Meta description is ${description.length} characters`) : 'Missing meta description',
      detail: description
        ? `"${description.slice(0, 180)}${description.length > 180 ? '…' : ''}"`
        : 'The description is often the summary an engine reuses when it lists your page as a source.',
      fix: description && descOk ? null : 'Write a 120–160 character description that summarises the page’s answer, not its marketing pitch.',
      earned: description ? (descOk ? 2 : 1) : 0,
      max: 2,
    }),
  );

  const canonicals = linkRel(html, 'canonical');
  let canonicalOk = false;
  let canonicalNote = 'No canonical link.';
  if (canonicals.length === 1) {
    try {
      const canonical = new URL(canonicals[0], url);
      canonicalOk = true;
      const relation = canonicalRelation(canonical, new URL(url));
      canonicalNote =
        relation === 'self'
          ? `Self-referencing canonical: ${canonical}`
          : relation === 'variant'
            ? `Canonical consolidates this URL's variants onto ${canonical}. That is the expected setup — the audited URL differs only by scheme, www or trailing slash.`
            : `Canonical points to a different page: ${canonical} — this URL defers its citations to that one.`;
    } catch {
      canonicalNote = `Canonical is not a valid URL: ${canonicals[0]}`;
    }
  } else if (canonicals.length > 1) {
    canonicalNote = `${canonicals.length} conflicting canonical links — engines will pick one arbitrarily or ignore all of them.`;
  }
  out.push(
    finding({
      id: 'canonical',
      category: 'metadata',
      severity: canonicalOk ? 'pass' : canonicals.length > 1 ? 'medium' : 'low',
      title: canonicalOk ? 'Canonical URL declared' : canonicals.length > 1 ? 'Conflicting canonical links' : 'No canonical URL',
      detail: canonicalNote,
      fix: canonicalOk ? null : 'Add exactly one self-referencing `<link rel="canonical">` so citation credit consolidates on one URL.',
      earned: canonicalOk ? 2 : 0,
      max: 2,
    }),
  );

  const lang = htmlLang(html);
  out.push(
    finding({
      id: 'lang',
      category: 'metadata',
      severity: lang ? 'pass' : 'low',
      title: lang ? `Language declared (${lang})` : 'No lang attribute on <html>',
      detail: lang
        ? 'Engines can route this page to the right language audience with confidence.'
        : 'Without a declared language, engines guess — and mis-guessed pages get excluded from language-filtered answers.',
      fix: lang ? null : 'Add `lang="en"` (or the correct code) to the `<html>` element.',
      earned: lang ? 1 : 0,
      max: 1,
    }),
  );

  const ogTitle = meta(html, 'og:title');
  const ogDescription = meta(html, 'og:description');
  out.push(
    finding({
      id: 'open-graph',
      category: 'metadata',
      severity: ogTitle && ogDescription ? 'pass' : 'low',
      title: ogTitle && ogDescription ? 'Open Graph metadata present' : 'Incomplete Open Graph metadata',
      detail:
        ogTitle && ogDescription
          ? 'Social and assistant previews have a clean title and summary to display.'
          : 'Several assistants fall back to Open Graph tags when building a source card for your page.',
      fix: ogTitle && ogDescription ? null : 'Add `og:title`, `og:description`, `og:url` and `og:image`.',
      earned: ogTitle && ogDescription ? 2 : ogTitle || ogDescription ? 1 : 0,
      max: 2,
    }),
  );

  return out;
}

/* --------------------------------------------------------------- authority */


/** Hosts where a link is a profile or share button rather than a source. */
const SELF_PROMOTION_HOSTS = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'linkedin.com',
  'instagram.com', 'tiktok.com', 'pinterest.com', 'threads.net',
]);

function safeHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * How a canonical URL relates to the URL that was audited.
 *
 * Comparing the two as strings makes normal configuration look like a fault:
 * a canonical pointing from the apex to the www host, or from http to https,
 * is exactly what consolidation is for, and reporting it as "this page defers
 * its citations elsewhere" reads as a warning about something done right.
 * Those spellings address the same resource, so they are reported as such.
 */
function canonicalRelation(canonical, audited) {
  const shape = (url) => ({
    host: url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''),
    path: url.pathname.replace(/\/+$/, '') || '/',
    query: url.search,
  });
  const a = shape(canonical);
  const b = shape(audited);

  if (a.host !== b.host || a.path !== b.path || a.query !== b.query) return 'elsewhere';
  // Same resource. Identical spelling is "self"; anything else is a variant
  // being folded onto the canonical spelling, which is the point of the tag.
  return canonical.toString().replace(/\/$/, '') === audited.toString().replace(/\/$/, '') ? 'self' : 'variant';
}

function checkAuthority(ctx) {
  const out = [];
  const { html, url } = ctx;
  const types = ctx.schemaTypes || new Set();

  // Read authorship from the parsed structured data rather than regexing the
  // raw HTML. A bundler that inlines package metadata puts `"author":` inside
  // a <script>, which no engine reads as authorship but which a document-wide
  // regex happily accepts — reporting "authorship is declared" for a page that
  // declares none.
  const nodes = ctx.schemaNodes || [];
  const authorMeta = meta(html, 'author');
  const hasAuthorNode = nodes.some((node) => node.author || node.creator);
  const hasAuthor = Boolean(authorMeta) || types.has('person') || hasAuthorNode || linkRel(html, 'author').length > 0;
  out.push(
    finding({
      id: 'author',
      category: 'authority',
      severity: hasAuthor ? 'pass' : 'low',
      title: hasAuthor ? 'Authorship is declared' : 'No author attribution',
      detail: hasAuthor
        ? `Attribution present${authorMeta ? `: ${authorMeta}` : ' in structured data'}.`
        : 'Named authorship is a trust signal engines weigh when choosing between competing sources on the same claim.',
      fix: hasAuthor ? null : 'Name the author in visible text and in `author` structured data.',
      earned: hasAuthor ? 2 : 0,
      max: 2,
    }),
  );

  const modified =
    meta(html, 'article:modified_time') || meta(html, 'og:updated_time') || meta(html, 'last-modified');
  // Declared in structured data, not merely mentioned somewhere in a script.
  const schemaDate = nodes.some((node) => node.datePublished || node.dateModified || node.dateCreated);
  // A visible <time datetime="..."> is a real, reader-facing date signal.
  const timeElement = findTags(html, 'time').some((tag) => tag.attrs.datetime);
  const headerDate = ctx.page.headers['last-modified'];
  const hasFreshness = Boolean(modified || schemaDate || timeElement || headerDate);
  out.push(
    finding({
      id: 'freshness',
      category: 'authority',
      severity: hasFreshness ? 'pass' : 'low',
      title: hasFreshness ? 'Freshness signal present' : 'No published or modified date',
      detail: hasFreshness
        ? `Dated via ${modified ? 'meta tags' : schemaDate ? 'structured data' : timeElement ? 'a visible <time> element' : 'the Last-Modified header'}.`
        : 'Engines strongly prefer sources they can date, especially for anything that changes over time. An undated page loses to a dated competitor on identical content.',
      fix: hasFreshness ? null : 'Publish `datePublished` and `dateModified` in structured data and show the date on the page.',
      earned: hasFreshness ? 2 : 0,
      max: 2,
    }),
  );

  // "Different hostname" is not the same as "external source". It counts a
  // site's own www/apex variant, its blog and docs subdomains, and its own
  // social profiles as corroboration — so a page that cites nothing at all
  // passes an authority check on the strength of its own footer links.
  const ownDomain = registrableDomain(safeHostname(url));
  const outbound = extractLinks(html, url).filter((link) => {
    if (!link.absolute) return false;
    const host = safeHostname(link.absolute);
    if (!host) return false;
    const domain = registrableDomain(host);
    if (!domain || domain === ownDomain) return false;
    return !SELF_PROMOTION_HOSTS.has(domain);
  });
  out.push(
    finding({
      id: 'citations',
      category: 'authority',
      severity: outbound.length >= 2 ? 'pass' : 'low',
      title: outbound.length ? `${outbound.length} outbound link(s)` : 'No outbound links',
      detail:
        outbound.length >= 2
          ? 'Linking out to sources is a corroboration signal — pages that cite tend to get cited.'
          : 'Pages that cite external sources read as researched rather than promotional, which raises the odds an engine trusts them.',
      fix: outbound.length >= 2 ? null : 'Link to the primary sources, standards or data your claims rest on.',
      earned: outbound.length >= 2 ? 1 : 0,
      max: 1,
    }),
  );

  return out;
}

/* ---------------------------------------------------------------- assembly */

/**
 * Run every check against a fetched page.
 * `ctx` is mutated by the checks so later ones can reuse earlier parsing.
 */
export function runChecks(input) {
  const ctx = {
    url: input.url,
    page: input.page,
    html: input.page.body || '',
    robots: input.robots || { found: false, body: '', status: 0, url: null },
    llms: input.llms || { found: false, body: '', status: 0, url: null },
    sitemap: input.sitemap || { found: false, body: '', status: 0, url: null },
  };
  ctx.text = visibleText(ctx.html);

  const findings = [
    ...checkAccess(ctx),
    ...checkContent(ctx),
    ...checkStructure(ctx),
    ...checkSchema(ctx),
    ...checkMetadata(ctx),
    ...checkAuthority(ctx),
  ];

  return { findings, ctx };
}
