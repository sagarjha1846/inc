/**
 * Public API for the `citable` package.
 *
 * Everything here runs unchanged on Node 20+, Cloudflare Workers, Deno and
 * Bun: no dependencies, no Node built-ins, nothing but fetch and WebCrypto.
 */

export { auditUrl, auditSite, urlsFromSitemap, FREE_ISSUE_LIMIT } from './audit.js';
export { runChecks, CATEGORIES, SEVERITY_ORDER } from './checks.js';
export { scoreFindings, prioritize, gradeFor, headroom } from './score.js';
export { generateAll, generateRobotsPatch, generateLlmsTxt, generateJsonLd, generateFaqSchema } from './generate.js';
export { renderMarkdown, renderSiteMarkdown, renderTerminal, renderHtml, renderSiteHtml } from './report.js';
export { compareAudits, renderComparison, renderComparisonMarkdown } from './compare.js';
export { AI_CRAWLERS, CITATION_CRAWLERS, parseRobots, isAllowed, crawlerMatrix } from './robots.js';
export { issueKey, verifyKey, tierFor, parseRevoked, REVOKED_KEY_IDS } from './license.js';
export { fetchPage, fetchOptional, normalizeUrl, FetchError, DEFAULT_USER_AGENT } from './fetch.js';
export * as html from './html.js';
