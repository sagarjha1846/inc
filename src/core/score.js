/**
 * Scoring.
 *
 * Each category is normalised independently (earned ÷ available × weight) so a
 * check that doesn't apply to a page can drop out without silently deflating
 * the score. The headline number is therefore always out of 100 and always
 * comparable between pages.
 */

import { CATEGORIES, SEVERITY_ORDER } from './checks.js';

const SEVERITY_RANK = Object.fromEntries(SEVERITY_ORDER.map((severity, index) => [severity, index]));

export function scoreFindings(findings) {
  const categories = {};

  for (const [key, meta] of Object.entries(CATEGORIES)) {
    const inCategory = findings.filter((item) => item.category === key);
    const available = inCategory.reduce((sum, item) => sum + item.max, 0);
    const earned = inCategory.reduce((sum, item) => sum + item.earned, 0);
    const ratio = available > 0 ? earned / available : 1;
    categories[key] = {
      key,
      label: meta.label,
      blurb: meta.blurb,
      weight: meta.weight,
      earned: Math.round(ratio * meta.weight * 10) / 10,
      max: meta.weight,
      ratio,
      findings: inCategory.length,
      issues: inCategory.filter((item) => item.severity !== 'pass').length,
    };
  }

  const score = Math.round(Object.values(categories).reduce((sum, category) => sum + category.earned, 0));

  return {
    score,
    grade: gradeFor(score),
    verdict: verdictFor(score, findings),
    categories,
    counts: countBySeverity(findings),
  };
}

export function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 68) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, pass: 0 };
  for (const item of findings) counts[item.severity] = (counts[item.severity] || 0) + 1;
  return counts;
}

function verdictFor(score, findings) {
  const critical = findings.filter((item) => item.severity === 'critical');
  if (critical.length) {
    return `Not citable as it stands — ${critical.length} blocking issue${critical.length > 1 ? 's' : ''} prevent${critical.length > 1 ? '' : 's'} AI engines from using this page.`;
  }
  if (score >= 90) return 'Strong. This page is set up to be found, read and cited by AI answer engines.';
  if (score >= 80) return 'Good. The fundamentals are in place; the remaining fixes are refinements.';
  if (score >= 68) return 'Workable, but competitors with cleaner structure will be cited ahead of this page.';
  if (score >= 55) return 'Weak. AI engines can reach this page but have little reason to quote it.';
  return 'Poor. This page is effectively invisible to AI answer engines.';
}

/**
 * Findings ordered the way a person should work through them: hard blockers
 * first, then by how many points each fix actually recovers.
 */
export function prioritize(findings) {
  return findings
    .filter((item) => item.severity !== 'pass')
    .map((item) => ({ ...item, gap: item.max - item.earned }))
    .sort((a, b) => {
      const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (bySeverity !== 0) return bySeverity;
      return b.gap - a.gap;
    });
}

/** Points recoverable if every open finding were fixed. */
export function headroom(findings) {
  const scored = scoreFindings(findings);
  return Math.max(0, 100 - scored.score);
}
