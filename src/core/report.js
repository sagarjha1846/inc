/**
 * Report rendering.
 *
 * The Markdown report is a deliverable in its own right — it is the artifact an
 * agency hands a client, so it leads with the verdict and the money question
 * ("which engines can cite this page today"), then the fixes in the order they
 * should be done.
 */

const SEVERITY_LABEL = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  pass: 'PASS',
};

/**
 * Fence a block of text that came from the audited page.
 *
 * Evidence quotes the page verbatim, and generated files carry its title and
 * description. A three-backtick fence is closed by the first three backticks
 * inside it, so a page containing one breaks out: everything after it stops
 * being quoted and becomes live Markdown — headings, links, and raw HTML,
 * which most renderers pass straight through into a document someone is about
 * to send a client.
 *
 * CommonMark closes a fenced block only with a fence at least as long as the
 * one that opened it, so the opening fence is made longer than any run of
 * backticks in the content. Nothing is altered or stripped: the evidence has
 * to remain a faithful quote of what was found.
 */
function fenced(text, info = '') {
  const body = String(text ?? '');
  const longest = (body.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}${info}`, body, fence];
}

const BAR_WIDTH = 24;

function bar(ratio) {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * BAR_WIDTH);
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

/** Full Markdown report for one page. */
export function renderMarkdown(result, options = {}) {
  const { brand = 'Citable', includeGenerated = true } = options;
  const lines = [];

  lines.push(`# AI Visibility Audit — ${result.url}`);
  lines.push('');
  lines.push(`**Score: ${result.score}/100 (${result.grade})** · ${result.verdict}`);
  lines.push('');
  lines.push(`Audited ${new Date(result.fetchedAt).toUTCString()} · HTTP ${result.http.status} in ${result.http.responseMs}ms · ${result.stats.words} words server-rendered`);
  lines.push('');

  lines.push('## Score breakdown');
  lines.push('');
  lines.push('| Category | Score | | What it measures |');
  lines.push('| --- | --- | --- | --- |');
  for (const category of Object.values(result.categories)) {
    lines.push(`| ${category.label} | ${category.earned}/${category.max} | \`${bar(category.ratio)}\` | ${category.blurb} |`);
  }
  lines.push('');

  if (result.crawlers && result.crawlers.length) {
    lines.push('## Which AI engines can reach this page');
    lines.push('');
    lines.push('| Crawler | Surface | Purpose | Status |');
    lines.push('| --- | --- | --- | --- |');
    for (const crawler of result.crawlers) {
      lines.push(
        `| \`${crawler.token}\` | ${crawler.surface} | ${crawler.purpose} | ${crawler.allowed ? 'Allowed' : `**Blocked** (${crawler.rule || 'group default'})`} |`,
      );
    }
    lines.push('');
  }

  lines.push(`## Findings (${result.issuesTotal} open)`);
  lines.push('');
  if (!result.issues.length) {
    lines.push('No open issues. Every check passed.');
    lines.push('');
  }
  result.issues.forEach((issue, index) => {
    lines.push(`### ${index + 1}. [${SEVERITY_LABEL[issue.severity]}] ${issue.title}`);
    lines.push('');
    lines.push(issue.detail);
    lines.push('');
    if (issue.evidence) {
      lines.push(...fenced(String(issue.evidence).slice(0, 1200)));
      lines.push('');
    }
    if (issue.impact) {
      lines.push(`**Costs you:** ${issue.impact}`);
      lines.push('');
    }
    if (issue.fix) {
      lines.push(`**Fix:** ${issue.fix}`);
      lines.push('');
    }
    lines.push(`*Recovers up to ${Math.round((issue.max - issue.earned) * 10) / 10} points.*`);
    lines.push('');
  });

  if (result.issuesWithheld > 0) {
    lines.push(`> ${result.issuesWithheld} further finding(s) and all generated fix files are included in ${brand} Pro.`);
    lines.push('');
  }

  if (result.passes && result.passes.length) {
    lines.push('## Already correct');
    lines.push('');
    for (const item of result.passes) lines.push(`- **${item.title}** — ${item.detail}`);
    lines.push('');
  }

  if (includeGenerated && result.generated) {
    lines.push('## Ready-to-ship fixes');
    lines.push('');

    lines.push('### robots.txt — append this');
    lines.push('');
    lines.push(...fenced(result.generated.robotsTxt.trim()));
    lines.push('');

    lines.push('### /llms.txt — create this file');
    lines.push('');
    lines.push(...fenced(result.generated.llmsTxt.trim(), 'markdown'));
    lines.push('');

    lines.push('### JSON-LD — paste inside `<head>`');
    lines.push('');
    lines.push(result.generated.jsonLd.note);
    lines.push('');
    if (result.generated.jsonLd.markup) {
      lines.push(...fenced(result.generated.jsonLd.markup, 'html'));
      lines.push('');
    }

    lines.push('### FAQPage schema');
    lines.push('');
    lines.push(result.generated.faqSchema.note);
    lines.push('');
    if (result.generated.faqSchema.markup) {
      lines.push(...fenced(result.generated.faqSchema.markup, 'html'));
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`Generated by ${brand}.`);
  lines.push('');
  return lines.join('\n');
}

/** Site-level rollup across many pages. */
export function renderSiteMarkdown(rollup, options = {}) {
  const { brand = 'Citable' } = options;
  const lines = [];

  lines.push('# Site-wide AI Visibility Audit');
  lines.push('');
  lines.push(`**Average score: ${rollup.averageScore}/100** across ${rollup.pagesAudited} page(s)${rollup.pagesFailed ? ` (${rollup.pagesFailed} failed to fetch)` : ''}.`);
  lines.push('');

  if (rollup.sitewideIssues.length) {
    lines.push('## Template-level issues');
    lines.push('');
    lines.push('Issues appearing on many pages usually live in a shared template, so one fix moves every page at once. Do these first.');
    lines.push('');
    lines.push('| Issue | Severity | Pages affected | Fix |');
    lines.push('| --- | --- | --- | --- |');
    for (const issue of rollup.sitewideIssues) {
      lines.push(`| ${issue.title} | ${SEVERITY_LABEL[issue.severity]} | ${issue.pages} | ${issue.fix || '—'} |`);
    }
    lines.push('');
    if (rollup.sitewideIssuesWithheld > 0) {
      // Without this the reader takes the table above for the whole list and
      // works through it believing the template is then clean.
      lines.push(
        `> Showing ${rollup.sitewideIssues.length} of ${rollup.sitewideIssuesTotal} template-level issues. ` +
          `${rollup.sitewideIssuesWithheld} more are included in ${brand} Pro.`,
      );
      lines.push('');
    }
  }

  lines.push('## Pages');
  lines.push('');
  lines.push('| Page | Score | Open issues |');
  lines.push('| --- | --- | --- |');
  for (const page of rollup.pages) {
    if (typeof page.score !== 'number') {
      lines.push(`| ${page.url} | — | fetch failed: ${page.error} |`);
      continue;
    }
    lines.push(`| ${page.url} | ${page.score}/100 (${page.grade}) | ${page.issuesTotal} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`Generated by ${brand}.`);
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------- HTML */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

const SEVERITY_WORD = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  pass: 'Pass',
};

/**
 * A self-contained HTML report.
 *
 * This is the client deliverable: one file with no external requests, a light
 * palette that survives being printed or saved as PDF, and a cover block that
 * leads with the verdict rather than the methodology. Someone paying for an
 * audit is buying a document they can forward to their engineering lead, so it
 * has to read as a report and not as tool output.
 */
export function renderHtml(result, options = {}) {
  const {
    brand = 'Citable',
    accent = '#0d9488',
    preparedFor = null,
    preparedBy = null,
    includeGenerated = true,
  } = options;

  const scoreColor = result.score >= 80 ? '#15803d' : result.score >= 60 ? '#b45309' : '#b91c1c';
  const circumference = 2 * Math.PI * 54;
  const dashOffset = circumference * (1 - result.score / 100);

  const categoryRows = Object.values(result.categories)
    .map((category) => {
      const width = Math.round(category.ratio * 100);
      const color = category.ratio >= 0.8 ? '#15803d' : category.ratio >= 0.5 ? '#b45309' : '#b91c1c';
      return `<tr>
      <th scope="row">${escapeHtml(category.label)}<span class="blurb">${escapeHtml(category.blurb)}</span></th>
      <td class="barcell"><span class="track"><span class="fill" style="width:${width}%;background:${color}"></span></span></td>
      <td class="num">${category.earned}<span class="of">/${category.max}</span></td>
    </tr>`;
    })
    .join('\n');

  const crawlerRows = (result.crawlers || [])
    .map(
      (crawler) => `<tr>
      <td class="mono">${escapeHtml(crawler.token)}</td>
      <td>${escapeHtml(crawler.surface)}</td>
      <td>${escapeHtml(crawler.purpose)}</td>
      <td class="${crawler.allowed ? 'ok' : 'bad'}">${
        crawler.allowed ? 'Allowed' : `Blocked${crawler.rule ? ` — <span class="mono">${escapeHtml(crawler.rule)}</span>` : ''}`
      }</td>
    </tr>`,
    )
    .join('\n');

  const findingBlocks = result.issues
    .map(
      (issue, index) => `<section class="finding sev-${escapeHtml(issue.severity)}">
    <h3><span class="pill">${escapeHtml(SEVERITY_WORD[issue.severity] || issue.severity)}</span>${index + 1}. ${escapeHtml(issue.title)}</h3>
    <p>${escapeHtml(issue.detail)}</p>
    ${issue.evidence ? `<pre>${escapeHtml(String(issue.evidence).slice(0, 1200))}</pre>` : ''}
    ${issue.impact ? `<p class="meta"><strong>Costs you:</strong> ${escapeHtml(issue.impact)}</p>` : ''}
    ${issue.fix ? `<p class="meta fix"><strong>Fix:</strong> ${escapeHtml(issue.fix)}</p>` : ''}
    <p class="points">Recovers up to ${Math.round((issue.max - issue.earned) * 10) / 10} points</p>
  </section>`,
    )
    .join('\n');

  const generatedBlocks =
    includeGenerated && result.generated
      ? `<h2>Ready-to-ship fixes</h2>
  <p class="lede">Each file below is generated from this page. Review, then paste.</p>
  ${codeBlock('robots.txt — append to your existing file', result.generated.robotsTxt)}
  ${codeBlock('/llms.txt — create this file at your site root', result.generated.llmsTxt)}
  ${codeBlock('JSON-LD — paste inside &lt;head&gt;', result.generated.jsonLd.markup, result.generated.jsonLd.note)}
  ${codeBlock('FAQPage schema', result.generated.faqSchema.markup, result.generated.faqSchema.note)}`
      : '';

  const withheld =
    result.issuesWithheld > 0
      ? `<p class="withheld">${result.issuesWithheld} further finding(s) and the generated fix files are included in ${escapeHtml(brand)} Pro.</p>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Visibility Audit — ${escapeHtml(result.url)}</title>
<style>
  :root { --accent:${accent}; --ink:#16202b; --muted:#5c6675; --line:#e2e7ee; --panel:#f7f9fb; }
  *{box-sizing:border-box}
  body{margin:0;background:#fff;color:var(--ink);line-height:1.62;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    font-size:15px;-webkit-font-smoothing:antialiased}
  .page{max-width:820px;margin:0 auto;padding:48px 28px 72px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
  .brandbar{display:flex;justify-content:space-between;align-items:baseline;
    border-bottom:2px solid var(--accent);padding-bottom:10px;margin-bottom:28px;flex-wrap:wrap;gap:8px}
  .brandbar .name{font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:var(--accent)}
  .brandbar .date{font-size:12px;color:var(--muted)}
  h1{font-size:25px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em;word-break:break-word}
  .url{color:var(--muted);font-size:13px;margin:0 0 26px;word-break:break-all}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);
    margin:40px 0 14px;padding-bottom:7px;border-bottom:1px solid var(--line)}
  h3{font-size:16px;margin:0 0 7px;display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
  p{margin:0 0 10px}
  .lede{color:var(--muted);margin-bottom:16px}
  .hero{display:flex;gap:26px;align-items:center;background:var(--panel);
    border:1px solid var(--line);border-radius:12px;padding:22px;flex-wrap:wrap}
  .hero .verdict{flex:1 1 300px;min-width:0}
  .hero .verdict p{margin:0;font-size:17px;font-weight:600;line-height:1.45}
  .facts{margin-top:12px;font-size:13px;color:var(--muted)}
  .facts span{display:inline-block;margin-right:16px;white-space:nowrap}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  thead th{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:600}
  .cats th{font-weight:600;width:38%}
  .cats .blurb{display:block;font-weight:400;font-size:12px;color:var(--muted);margin-top:2px}
  .barcell{width:44%}
  .track{display:block;height:9px;background:#e8edf3;border-radius:99px;overflow:hidden}
  .fill{display:block;height:100%;border-radius:99px}
  .num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
  .num .of{color:var(--muted);font-weight:400}
  .scroll{overflow-x:auto}
  .ok{color:#15803d} .bad{color:#b91c1c;font-weight:600}
  .finding{border-left:4px solid var(--line);padding:2px 0 2px 16px;margin:0 0 24px;
    break-inside:avoid;page-break-inside:avoid}
  .finding.sev-critical,.finding.sev-high{border-color:#b91c1c}
  .finding.sev-medium{border-color:#b45309}
  .finding.sev-low{border-color:#2563eb}
  .pill{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;
    padding:3px 8px;border-radius:5px;background:#eef2f7;color:var(--muted)}
  .sev-critical .pill,.sev-high .pill{background:#fdeaea;color:#b91c1c}
  .sev-medium .pill{background:#fdf1e0;color:#b45309}
  .sev-low .pill{background:#e8f0fe;color:#2563eb}
  .meta{font-size:14px;color:var(--muted)}
  .meta strong{color:var(--ink)}
  .fix strong{color:var(--accent)}
  .points{font-size:12px;color:var(--muted);font-style:italic;margin:0}
  pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;
    overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;margin:8px 0 0}
  .gen{margin-bottom:26px;break-inside:avoid}
  .gen h3{font-size:14px;display:block}
  .gen .note{font-size:13px;color:var(--muted);margin:0}
  .withheld{background:var(--panel);border:1px dashed var(--line);border-radius:8px;
    padding:14px 16px;color:var(--muted);font-size:14px}
  footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);
    font-size:12px;color:var(--muted)}
  @media print{
    .page{padding:0;max-width:none}
    body{font-size:11.5pt}
    h2{page-break-after:avoid}
    pre{white-space:pre-wrap}
  }
</style>
</head>
<body>
<div class="page">

  <div class="brandbar">
    <span class="name">${escapeHtml(brand)} — AI Visibility Audit</span>
    <span class="date">${escapeHtml(new Date(result.fetchedAt).toUTCString())}</span>
  </div>

  <h1>Can AI answer engines cite this page?</h1>
  <p class="url">${escapeHtml(result.url)}${preparedFor ? ` · Prepared for ${escapeHtml(preparedFor)}` : ''}${
    preparedBy ? ` · by ${escapeHtml(preparedBy)}` : ''
  }</p>

  <div class="hero">
    <svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Score ${result.score} out of 100">
      <circle cx="64" cy="64" r="54" fill="none" stroke="#e8edf3" stroke-width="11"/>
      <circle cx="64" cy="64" r="54" fill="none" stroke="${scoreColor}" stroke-width="11" stroke-linecap="round"
        stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${dashOffset.toFixed(1)}"
        transform="rotate(-90 64 64)"/>
      <text x="64" y="61" text-anchor="middle" font-size="31" font-weight="700" fill="#16202b"
        font-family="system-ui,sans-serif">${result.score}</text>
      <text x="64" y="80" text-anchor="middle" font-size="11" fill="#5c6675"
        font-family="system-ui,sans-serif">out of 100 · ${escapeHtml(result.grade)}</text>
    </svg>
    <div class="verdict">
      <p>${escapeHtml(result.verdict)}</p>
      <div class="facts">
        <span>HTTP ${result.http.status}</span>
        <span>${result.http.responseMs}ms</span>
        <span>${result.stats.words} words server-rendered</span>
        <span>${result.issuesTotal} open findings</span>
      </div>
    </div>
  </div>

  <h2>Score breakdown</h2>
  <table class="cats"><tbody>
${categoryRows}
  </tbody></table>

  ${
    crawlerRows
      ? `<h2>Which AI engines can reach this page</h2>
  <p class="lede">Blocking a <em>training</em> crawler is a content policy. Blocking a <em>citation</em> or <em>live-fetch</em> crawler removes this page from that engine's answers.</p>
  <div class="scroll"><table>
    <thead><tr><th>Crawler</th><th>Surface</th><th>Purpose</th><th>Status</th></tr></thead>
    <tbody>
${crawlerRows}
    </tbody>
  </table></div>`
      : `<h2>Which AI engines can reach this page</h2>
  <p class="lede">No robots.txt was found, so nothing is blocked — every crawler may fetch this page.</p>`
  }

  <h2>Findings${result.tier === 'free' ? ` — top ${result.issues.length}` : ''}</h2>
${findingBlocks || '<p>No open findings — every check passed.</p>'}
  ${withheld}

  ${generatedBlocks}

  <footer>
    Generated by ${escapeHtml(brand)}. Scoring weights are a judgement call, not an empirically
    derived model; the underlying measurements are objective and reproducible.
  </footer>

</div>
</body>
</html>
`;
}

/**
 * A self-contained HTML report for a whole-site audit.
 *
 * An agency engagement covers a site, not a page, so this is the deliverable
 * that tier actually ships. It leads with the template-level issues, because
 * an issue appearing on twenty pages is one fix in a shared layout rather than
 * twenty pieces of work — that prioritisation is most of what the client is
 * paying for.
 */
export function renderSiteHtml(rollup, options = {}) {
  const {
    brand = 'Citable',
    accent = '#0d9488',
    preparedFor = null,
    preparedBy = null,
  } = options;

  const audited = rollup.pages.filter((page) => typeof page.score === 'number');
  const failed = rollup.pages.filter((page) => typeof page.score !== 'number');
  const scoreColor = (score) => (score >= 80 ? '#15803d' : score >= 60 ? '#b45309' : '#b91c1c');

  const circumference = 2 * Math.PI * 54;
  const dashOffset = circumference * (1 - rollup.averageScore / 100);

  const templateRows = rollup.sitewideIssues
    .map(
      (issue) => `<tr>
      <td><strong>${escapeHtml(issue.title)}</strong></td>
      <td><span class="pill sev-${escapeHtml(issue.severity)}">${escapeHtml(SEVERITY_WORD[issue.severity] || issue.severity)}</span></td>
      <td class="num">${issue.pages}<span class="of">/${audited.length}</span></td>
      <td>${escapeHtml(issue.fix || '—')}</td>
    </tr>`,
    )
    .join('\n');

  const pageRows = [...audited]
    .sort((a, b) => a.score - b.score)
    .map((page) => {
      const blockedCitation = (page.crawlers || [])
        .filter((crawler) => !crawler.allowed && crawler.purpose !== 'training')
        .map((crawler) => crawler.token);
      return `<tr>
      <td class="mono url">${escapeHtml(page.url)}</td>
      <td class="num" style="color:${scoreColor(page.score)}"><strong>${page.score}</strong><span class="of">/100</span></td>
      <td>${escapeHtml(page.grade)}</td>
      <td class="num">${page.issuesTotal}</td>
      <td class="${blockedCitation.length ? 'bad' : 'ok'}">${blockedCitation.length ? escapeHtml(blockedCitation.join(', ')) : 'none'}</td>
    </tr>`;
    })
    .join('\n');

  const failedRows = failed.length
    ? `<h2>Could not be fetched</h2>
  <div class="scroll"><table>
    <thead><tr><th>URL</th><th>Reason</th></tr></thead>
    <tbody>${failed
      .map((page) => `<tr><td class="mono url">${escapeHtml(page.url)}</td><td>${escapeHtml(page.error || 'unknown')}</td></tr>`)
      .join('\n')}</tbody>
  </table></div>`
    : '';

  const worst = rollup.worst;
  const best = rollup.best;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site AI Visibility Audit — ${escapeHtml(audited.length ? new URL(audited[0].url).hostname : 'site')}</title>
<style>
  :root { --accent:${accent}; --ink:#16202b; --muted:#5c6675; --line:#e2e7ee; --panel:#f7f9fb; }
  *{box-sizing:border-box}
  body{margin:0;background:#fff;color:var(--ink);line-height:1.62;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    font-size:15px;-webkit-font-smoothing:antialiased}
  .page{max-width:880px;margin:0 auto;padding:48px 28px 72px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
  .url{word-break:break-all;max-width:340px}
  .brandbar{display:flex;justify-content:space-between;align-items:baseline;
    border-bottom:2px solid var(--accent);padding-bottom:10px;margin-bottom:28px;flex-wrap:wrap;gap:8px}
  .brandbar .name{font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:var(--accent)}
  .brandbar .date{font-size:12px;color:var(--muted)}
  h1{font-size:25px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:13px;margin:0 0 26px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);
    margin:40px 0 14px;padding-bottom:7px;border-bottom:1px solid var(--line)}
  p{margin:0 0 10px}
  .lede{color:var(--muted);margin-bottom:16px}
  .hero{display:flex;gap:26px;align-items:center;background:var(--panel);
    border:1px solid var(--line);border-radius:12px;padding:22px;flex-wrap:wrap}
  .hero .verdict{flex:1 1 300px;min-width:0}
  .hero .verdict p{margin:0;font-size:17px;font-weight:600;line-height:1.45}
  .facts{margin-top:12px;font-size:13px;color:var(--muted)}
  .facts span{display:inline-block;margin-right:16px;white-space:nowrap}
  table{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:14px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  thead th{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .num .of{color:var(--muted);font-weight:400}
  .scroll{overflow-x:auto}
  .ok{color:#15803d} .bad{color:#b91c1c;font-weight:600}
  .pill{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;
    padding:3px 8px;border-radius:5px;background:#eef2f7;color:var(--muted);white-space:nowrap}
  .sev-critical,.sev-high{background:#fdeaea;color:#b91c1c}
  .sev-medium{background:#fdf1e0;color:#b45309}
  .sev-low{background:#e8f0fe;color:#2563eb}
  footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
  @media print{ .page{padding:0;max-width:none} body{font-size:11pt} h2{page-break-after:avoid} tr{page-break-inside:avoid} }
</style>
</head>
<body>
<div class="page">

  <div class="brandbar">
    <span class="name">${escapeHtml(brand)} — Site AI Visibility Audit</span>
    <span class="date">${escapeHtml(new Date().toUTCString())}</span>
  </div>

  <h1>Can AI answer engines cite this site?</h1>
  <p class="sub">${audited.length} page(s) audited${preparedFor ? ` · Prepared for ${escapeHtml(preparedFor)}` : ''}${
    preparedBy ? ` · by ${escapeHtml(preparedBy)}` : ''
  }</p>

  <div class="hero">
    <svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Average score ${rollup.averageScore} out of 100">
      <circle cx="64" cy="64" r="54" fill="none" stroke="#e8edf3" stroke-width="11"/>
      <circle cx="64" cy="64" r="54" fill="none" stroke="${scoreColor(rollup.averageScore)}" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${dashOffset.toFixed(1)}"
        transform="rotate(-90 64 64)"/>
      <text x="64" y="61" text-anchor="middle" font-size="31" font-weight="700" fill="#16202b"
        font-family="system-ui,sans-serif">${rollup.averageScore}</text>
      <text x="64" y="80" text-anchor="middle" font-size="11" fill="#5c6675"
        font-family="system-ui,sans-serif">site average</text>
    </svg>
    <div class="verdict">
      <p>${escapeHtml(siteVerdict(rollup, audited))}</p>
      <div class="facts">
        <span>${audited.length} pages audited</span>
        ${failed.length ? `<span>${failed.length} unreachable</span>` : ''}
        ${worst ? `<span>Lowest ${worst.score}/100</span>` : ''}
        ${best ? `<span>Highest ${best.score}/100</span>` : ''}
      </div>
    </div>
  </div>

  ${
    templateRows
      ? `<h2>Fix these first — they repeat across pages</h2>
  <p class="lede">An issue on many pages usually lives in one shared template, so a single change moves every page at once.</p>
  <div class="scroll"><table>
    <thead><tr><th>Issue</th><th>Severity</th><th class="num">Pages</th><th>Fix</th></tr></thead>
    <tbody>
${templateRows}
    </tbody>
  </table></div>
  ${
    rollup.sitewideIssuesWithheld > 0
      ? `<p class="withheld">Showing ${rollup.sitewideIssues.length} of ${rollup.sitewideIssuesTotal} template-level issues. ${rollup.sitewideIssuesWithheld} more are included in ${escapeHtml(brand)} Pro.</p>`
      : ''
  }`
      : ''
  }

  <h2>Every page</h2>
  <div class="scroll"><table>
    <thead><tr><th>Page</th><th class="num">Score</th><th>Grade</th><th class="num">Issues</th><th>Blocked from</th></tr></thead>
    <tbody>
${pageRows}
    </tbody>
  </table></div>

  ${failedRows}

  <footer>
    Generated by ${escapeHtml(brand)}. Scoring weights are a judgement call, not an empirically
    derived model; the underlying measurements are objective and reproducible.
  </footer>

</div>
</body>
</html>
`;
}

function siteVerdict(rollup, audited) {
  const blocked = audited.filter((page) =>
    (page.crawlers || []).some((crawler) => !crawler.allowed && crawler.purpose !== 'training'),
  );
  if (blocked.length === audited.length && audited.length > 0) {
    return 'Every page audited is blocked from at least one answer engine. This is a site-wide robots.txt problem and the single highest-value fix available.';
  }
  if (blocked.length) {
    return `${blocked.length} of ${audited.length} pages are blocked from at least one answer engine.`;
  }
  if (rollup.averageScore >= 85) return 'Strong across the site. Crawlers can reach these pages and have good material to cite.';
  if (rollup.averageScore >= 70) return 'Reachable and readable, but competitors with cleaner structure will be cited ahead of these pages.';
  return 'Reachable, but these pages give answer engines little reason to quote them.';
}

function codeBlock(heading, content, note) {
  if (!content) {
    return `<div class="gen"><h3>${heading}</h3><p class="note">${escapeHtml(note || 'Nothing to generate — this is already in place.')}</p></div>`;
  }
  return `<div class="gen">
    <h3>${heading}</h3>
    ${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}
    <pre>${escapeHtml(content)}</pre>
  </div>`;
}

/* --------------------------------------------------------------- terminal */

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  yellow: '[33m',
  green: '[32m',
  cyan: '[36m',
  grey: '[90m',
};

const SEVERITY_COLOR = {
  critical: ANSI.red,
  high: ANSI.red,
  medium: ANSI.yellow,
  low: ANSI.cyan,
  pass: ANSI.green,
};

/** Coloured terminal output for the CLI. */
export function renderTerminal(result, options = {}) {
  const { color = true, verbose = false } = options;
  const paint = (code, text) => (color ? `${code}${text}${ANSI.reset}` : text);
  const lines = [];

  const scoreColor = result.score >= 80 ? ANSI.green : result.score >= 60 ? ANSI.yellow : ANSI.red;
  lines.push('');
  lines.push(paint(ANSI.bold, result.url));
  lines.push(`${paint(scoreColor, `${result.score}/100`)} ${paint(ANSI.dim, `(${result.grade})`)}  ${result.verdict}`);
  lines.push('');

  for (const category of Object.values(result.categories)) {
    const label = category.label.padEnd(18);
    const ratioColor = category.ratio >= 0.8 ? ANSI.green : category.ratio >= 0.5 ? ANSI.yellow : ANSI.red;
    lines.push(`  ${label} ${paint(ratioColor, bar(category.ratio))} ${String(category.earned).padStart(4)}/${category.max}`);
  }
  lines.push('');

  const blocked = (result.crawlers || []).filter((crawler) => !crawler.allowed);
  if (blocked.length) {
    lines.push(paint(ANSI.red, `  Blocked crawlers: ${blocked.map((crawler) => crawler.token).join(', ')}`));
    lines.push('');
  }

  if (result.issues.length) {
    lines.push(paint(ANSI.bold, `Findings (${result.issuesTotal} open)`));
    lines.push('');
    result.issues.forEach((issue, index) => {
      const tag = paint(SEVERITY_COLOR[issue.severity] || '', `[${SEVERITY_LABEL[issue.severity]}]`);
      lines.push(`  ${index + 1}. ${tag} ${paint(ANSI.bold, issue.title)}`);
      lines.push(`     ${wrap(issue.detail, 92, '     ')}`);
      if (verbose && issue.evidence) {
        lines.push(paint(ANSI.grey, indent(String(issue.evidence).slice(0, 500), '       ')));
      }
      if (issue.fix) lines.push(`     ${paint(ANSI.cyan, '→ ')}${wrap(issue.fix, 92, '     ')}`);
      lines.push('');
    });
  } else {
    lines.push(paint(ANSI.green, '  No open issues.'));
    lines.push('');
  }

  if (result.issuesWithheld > 0) {
    lines.push(paint(ANSI.dim, `  ${result.issuesWithheld} more finding(s) + generated robots.txt / llms.txt / JSON-LD available with a Pro key.`));
    lines.push('');
  }

  return lines.join('\n');
}

function wrap(text, width, prefix) {
  const words = String(text || '').split(/\s+/);
  const out = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.join(`\n${prefix}`);
}

function indent(text, prefix) {
  return String(text)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
