/**
 * Comparing an audit against an earlier one.
 *
 * A single score is a snapshot; what a team actually needs to know is whether
 * today's deploy made things worse. This turns the CI gate from "are we above
 * 80" into "did we just regress", which is the difference between a one-off
 * check and something worth running on every pull request.
 *
 * The most valuable signal here is crawler access changing. A `robots.txt`
 * edit that quietly removes you from Perplexity produces no error, no failing
 * test and no analytics dip you could attribute — but it is a one-line diff
 * this catches immediately.
 */

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, pass: 4 };

/** A finding's identity across runs — the check that fired, not its wording. */
const keyOf = (finding) => finding.id;

/**
 * Compare two audit results for the same URL.
 *
 * Both arguments are results from `auditUrl` (or their JSON round-trip).
 * Returns the deltas plus a `regressed` flag suitable for failing a build.
 */
export function compareAudits(baseline, current, options = {}) {
  const { minSeverity = 'high' } = options;
  const threshold = SEVERITY_RANK[minSeverity] ?? SEVERITY_RANK.high;

  if (!baseline || typeof baseline.score !== 'number') {
    throw new Error('Baseline is not an audit result (no score field). Pass a file written by --json.');
  }
  if (!current || typeof current.score !== 'number') {
    throw new Error('Current result is not an audit result.');
  }

  const baselineIssues = new Map((baseline.issues || []).map((issue) => [keyOf(issue), issue]));
  const currentIssues = new Map((current.issues || []).map((issue) => [keyOf(issue), issue]));

  const fixed = [];
  const introduced = [];
  const worsened = [];
  const improved = [];

  for (const [key, issue] of baselineIssues) {
    if (!currentIssues.has(key)) {
      fixed.push(issue);
      continue;
    }
    const now = currentIssues.get(key);
    const before = SEVERITY_RANK[issue.severity];
    const after = SEVERITY_RANK[now.severity];
    if (after < before) worsened.push({ ...now, from: issue.severity, to: now.severity });
    else if (after > before) improved.push({ ...now, from: issue.severity, to: now.severity });
  }

  for (const [key, issue] of currentIssues) {
    if (!baselineIssues.has(key)) introduced.push(issue);
  }

  // Crawler access changes, which are the highest-signal regression of all.
  const baselineCrawlers = new Map((baseline.crawlers || []).map((crawler) => [crawler.token, crawler]));
  const crawlerChanges = [];
  for (const crawler of current.crawlers || []) {
    const before = baselineCrawlers.get(crawler.token);
    if (!before || before.allowed === crawler.allowed) continue;
    crawlerChanges.push({
      token: crawler.token,
      vendor: crawler.vendor,
      surface: crawler.surface,
      purpose: crawler.purpose,
      was: before.allowed ? 'allowed' : 'blocked',
      now: crawler.allowed ? 'allowed' : 'blocked',
      rule: crawler.rule,
      lost: before.allowed && !crawler.allowed,
    });
  }
  // A crawler present in the baseline but absent now means robots.txt
  // disappeared entirely, which is worth surfacing rather than ignoring.
  const robotsDisappeared = (baseline.crawlers || []).length > 0 && (current.crawlers || []).length === 0;

  const categoryDeltas = {};
  for (const [key, category] of Object.entries(current.categories || {})) {
    const before = baseline.categories && baseline.categories[key];
    if (!before) continue;
    categoryDeltas[key] = {
      label: category.label,
      before: before.earned,
      after: category.earned,
      delta: Math.round((category.earned - before.earned) * 10) / 10,
      max: category.max,
    };
  }

  const scoreDelta = current.score - baseline.score;
  const blockingIntroduced = introduced.filter((issue) => SEVERITY_RANK[issue.severity] <= threshold);
  const lostCrawlers = crawlerChanges.filter((change) => change.lost);

  // Free-tier results carry only the top few findings, so an issue can appear
  // "fixed" purely by dropping off a truncated list. When either side is
  // truncated the finding-level diff is advisory only, and the regression
  // verdict falls back to the two signals that are complete at every tier:
  // the score and the crawler matrix.
  const truncated = Boolean(baseline.issuesWithheld) || Boolean(current.issuesWithheld);

  const regressed = truncated
    ? scoreDelta < 0 || lostCrawlers.length > 0
    : scoreDelta < 0 || blockingIntroduced.length > 0 || worsened.length > 0 || lostCrawlers.length > 0;

  return {
    url: current.url,
    baselineUrl: baseline.url,
    baselineAt: baseline.fetchedAt,
    currentAt: current.fetchedAt,
    baselineScore: baseline.score,
    currentScore: current.score,
    scoreDelta,
    baselineGrade: baseline.grade,
    currentGrade: current.grade,
    categoryDeltas,
    fixed,
    introduced,
    worsened,
    improved,
    blockingIntroduced,
    crawlerChanges,
    lostCrawlers,
    robotsDisappeared,
    regressed,
    truncated,
    // Comparing two different URLs is almost always a mistake, but it can be
    // deliberate (staging vs production), so it is a warning and not an error.
    urlMismatch: baseline.url !== current.url,
    summary: summarize({ scoreDelta, lostCrawlers, blockingIntroduced, fixed, worsened, regressed, truncated }),
  };
}

function summarize({ scoreDelta, lostCrawlers, blockingIntroduced, fixed, worsened, regressed, truncated }) {
  if (lostCrawlers.length) {
    const surfaces = [...new Set(lostCrawlers.map((change) => change.surface))].join(', ');
    return `Regression: this page is no longer reachable by ${surfaces}. A robots.txt change removed it from those answers.`;
  }
  if (!truncated && blockingIntroduced.length) {
    return `Regression: ${blockingIntroduced.length} new blocking issue(s) since the baseline.`;
  }
  if (!truncated && worsened.length) {
    return `Regression: ${worsened.length} existing issue(s) got worse.`;
  }
  if (regressed) {
    return `Regression: score fell ${Math.abs(scoreDelta)} point(s).`;
  }
  if (scoreDelta > 0) {
    return `Improved by ${scoreDelta} point(s)${fixed.length ? `, ${fixed.length} issue(s) fixed` : ''}.`;
  }
  return 'No change since the baseline.';
}

/** Terminal rendering of a comparison. */
export function renderComparison(diff, options = {}) {
  const { color = true } = options;
  const paint = (code, text) => (color ? `${code}${text}[0m` : text);
  const RED = '[31m';
  const GREEN = '[32m';
  const YELLOW = '[33m';
  const DIM = '[2m';
  const BOLD = '[1m';

  const lines = [''];
  lines.push(paint(BOLD, diff.url));

  const arrow = diff.scoreDelta > 0 ? '▲' : diff.scoreDelta < 0 ? '▼' : '—';
  const deltaColor = diff.scoreDelta > 0 ? GREEN : diff.scoreDelta < 0 ? RED : DIM;
  const deltaText = diff.scoreDelta === 0 ? 'no change' : `${diff.scoreDelta > 0 ? '+' : ''}${diff.scoreDelta}`;
  lines.push(
    `${diff.baselineScore}/100 → ${paint(BOLD, `${diff.currentScore}/100`)} ${paint(deltaColor, `${arrow} ${deltaText}`)}`,
  );
  lines.push('');
  lines.push(paint(diff.regressed ? RED : GREEN, diff.summary));
  lines.push('');

  if (diff.urlMismatch) {
    lines.push(paint(YELLOW, `  Note: baseline was ${diff.baselineUrl}, this run was ${diff.url}`));
    lines.push('');
  }

  if (diff.truncated) {
    lines.push(paint(YELLOW, '  Finding-level diff unavailable on the free tier.'));
    lines.push(
      paint(
        DIM,
        '  Free results carry only the top few findings, so an issue can drop off the list\n  without being fixed. Score, crawler access and category movement below are complete.\n  Run with a Pro key for a finding-level diff.',
      ),
    );
    lines.push('');
  }

  if (diff.robotsDisappeared) {
    lines.push(paint(YELLOW, '  robots.txt is no longer being served — nothing is blocked, but the policy is gone.'));
    lines.push('');
  }

  if (diff.crawlerChanges.length) {
    lines.push(paint(BOLD, 'Crawler access changes'));
    for (const change of diff.crawlerChanges) {
      const marker = change.lost ? paint(RED, '  ✗') : paint(GREEN, '  ✓');
      lines.push(`${marker} ${change.token} (${change.surface}): ${change.was} → ${change.now}${change.rule ? ` — ${change.rule}` : ''}`);
    }
    lines.push('');
  }

  const section = (title, items, code, format) => {
    if (!items.length) return;
    lines.push(paint(BOLD, `${title} (${items.length})`));
    for (const item of items) lines.push(`  ${paint(code, format(item))}`);
    lines.push('');
  };

  // Suppressed entirely when truncated: a partial list produces confidently
  // wrong entries in both directions, and a wrong "Fixed" is worse than none.
  if (!diff.truncated) {
    section('Introduced', diff.introduced, RED, (issue) => `[${issue.severity.toUpperCase()}] ${issue.title}`);
    section('Worsened', diff.worsened, RED, (issue) => `${issue.title} (${issue.from} → ${issue.to})`);
    section('Fixed', diff.fixed, GREEN, (issue) => issue.title);
    section('Improved', diff.improved, GREEN, (issue) => `${issue.title} (${issue.from} → ${issue.to})`);
  }

  const moved = Object.values(diff.categoryDeltas).filter((category) => category.delta !== 0);
  if (moved.length) {
    lines.push(paint(BOLD, 'Category movement'));
    for (const category of moved) {
      const sign = category.delta > 0 ? '+' : '';
      lines.push(
        `  ${category.label.padEnd(18)} ${paint(category.delta > 0 ? GREEN : RED, `${sign}${category.delta}`)} ${paint(DIM, `(${category.before} → ${category.after} of ${category.max})`)}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Markdown rendering, for CI job summaries and PR comments. */
export function renderComparisonMarkdown(diff) {
  const lines = [];
  const arrow = diff.scoreDelta > 0 ? '▲' : diff.scoreDelta < 0 ? '▼' : '—';
  const sign = diff.scoreDelta > 0 ? '+' : '';

  lines.push(`### AI visibility: ${diff.baselineScore} → **${diff.currentScore}** ${arrow} ${sign}${diff.scoreDelta}`);
  lines.push('');
  lines.push(diff.regressed ? `**${diff.summary}**` : diff.summary);
  lines.push('');

  if (diff.truncated) {
    lines.push(
      '> Finding-level diff unavailable on the free tier — free results carry only the top few findings, so an issue can drop off the list without being fixed. Score, crawler access and category movement are complete.',
    );
    lines.push('');
  }

  if (diff.crawlerChanges.length) {
    lines.push('| Crawler | Surface | Was | Now |');
    lines.push('| --- | --- | --- | --- |');
    for (const change of diff.crawlerChanges) {
      lines.push(`| \`${change.token}\` | ${change.surface} | ${change.was} | ${change.lost ? `**${change.now}**` : change.now} |`);
    }
    lines.push('');
  }

  const list = (title, items, format) => {
    if (!items.length) return;
    lines.push(`**${title}**`);
    lines.push('');
    for (const item of items) lines.push(`- ${format(item)}`);
    lines.push('');
  };

  if (!diff.truncated) {
    list('Introduced', diff.introduced, (issue) => `\`${issue.severity}\` ${issue.title}`);
    list('Worsened', diff.worsened, (issue) => `${issue.title} (${issue.from} → ${issue.to})`);
    list('Fixed', diff.fixed, (issue) => issue.title);
    list('Improved', diff.improved, (issue) => `${issue.title} (${issue.from} → ${issue.to})`);
  }

  return lines.join('\n');
}
