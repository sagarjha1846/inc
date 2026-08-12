/**
 * The hosted UI, served as one self-contained HTML document.
 *
 * Everything is inline — no CDN, no build step, no external requests — so the
 * whole product is a single Worker deploy. The page is also the sales page:
 * the free audit has to be good enough to trust, and the withheld findings
 * have to be specific enough to want.
 */

import { AI_CRAWLERS } from '../core/robots.js';

/**
 * A URL safe to put in an `href`, or null.
 *
 * `priceUrl` and `requestUrl` were interpolated raw into the buy button's
 * attribute, so a value carrying a quote broke out of it and one starting
 * `javascript:` armed the button with a script. Both arrive from configuration
 * — `CHECKOUT_URL` on the Worker, a repository variable on the static build —
 * which is not the same as trusted: a repository variable can be set by anyone
 * with write access, and the result is served to every visitor of the public
 * landing page.
 *
 * Only absolute http(s) and same-document links are accepted. Anything else is
 * treated as no link at all, which the caller already handles, rather than
 * being escaped into something that renders but cannot work.
 */
function safeLink(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('./')) return escapeAttr(raw);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return escapeAttr(url.toString());
  } catch {
    return null;
  }
}

const ATTR_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeAttr = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ATTR_ESCAPES[char]);

/**
 * @param {object} options
 * @param {string} [options.priceUrl]   A real checkout link. Buys immediately.
 * @param {string} [options.requestUrl] Where to send someone who wants to buy
 *   when no checkout exists yet. Standing up a payment processor is the one
 *   step that needs an account and a decision; until it happens, the choice is
 *   between a button that cannot take money and a way to reach the seller.
 * @param {number} [options.crawlerCount]
 * @param {object} [options.demoResult] A pre-computed audit rendered on load.
 *   Used by `/demo`, so a visitor sees a full report — the thing they are
 *   being asked to pay for — before they type anything.
 */
export function renderApp({
  priceUrl = '#pricing',
  requestUrl = '',
  crawlerCount = AI_CRAWLERS.length,
  demoResult = null,
} = {}) {
  // A deploy that never set CHECKOUT_URL would otherwise render live buy
  // buttons pointing at the placeholder link, so a visitor clicking "Get a Pro
  // key" lands on a 404 and the operator has no reason to notice. Failing
  // visibly is better than a broken promise.
  //
  // The test is only that the URL is not a known placeholder, which cannot tell
  // a checkout from any other link — the static site pointed these buttons at a
  // feature table in the README and passed. So the label is chosen from which
  // option was supplied rather than assumed: a button that says "buy" has to
  // lead somewhere that takes money, and one that leads somewhere else has to
  // say what it actually does.
  const usable = (value) => Boolean(value) && value !== '#pricing' && !/CHANGE-ME/i.test(value);
  const checkoutHref = usable(priceUrl) ? safeLink(priceUrl) : null;
  const requestHref = !checkoutHref && usable(requestUrl) ? safeLink(requestUrl) : null;

  const buyButton = (label, requestLabel) => {
    if (checkoutHref) return `<a class="cta" href="${checkoutHref}">${label}</a>`;
    if (requestHref) return `<a class="cta cta-request" href="${requestHref}">${requestLabel}</a>`;
    return `<span class="cta cta-disabled" role="note">Checkout not configured</span>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Citable — can AI answer engines cite your site?</title>
<meta name="description" content="Audit whether ChatGPT, Claude, Perplexity and Google AI Overviews can crawl, read and cite your pages. Free score in seconds, with the exact files needed to fix what it finds.">
<link rel="canonical" href="/">
<meta property="og:title" content="Citable — can AI answer engines cite your site?">
<meta property="og:description" content="Free audit of your site's AI answer-engine visibility.">
<meta property="og:type" content="website">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","@id":"/#org","name":"Citable","url":"/"},
 {"@type":"SoftwareApplication","name":"Citable","applicationCategory":"DeveloperApplication","operatingSystem":"Web","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"},"publisher":{"@id":"/#org"}}
]}
</script>
<style>
:root{
  --bg:#0b0d10; --panel:#12151a; --panel-2:#171b21; --line:#242a33;
  --text:#e8ecf1; --muted:#8b97a8; --accent:#5eead4; --accent-dim:#2dd4bf;
  --red:#f87171; --amber:#fbbf24; --blue:#60a5fa; --green:#4ade80;
  --radius:14px; --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme: light){
  :root{--bg:#f7f8fa;--panel:#fff;--panel-2:#f2f4f7;--line:#e3e7ed;--text:#151a21;--muted:#5c6675;--accent:#0d9488;--accent-dim:#14b8a6}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
.wrap{max-width:940px;margin:0 auto;padding:0 20px}
header{padding:56px 0 0}
.logo{font-family:var(--mono);font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent)}
h1{font-size:clamp(28px,5vw,44px);line-height:1.15;margin:14px 0 12px;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:17px;max-width:60ch;margin:0 0 28px}
form{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
input[type=url],input[type=text]{flex:1 1 320px;min-width:0;background:var(--panel);border:1px solid var(--line);color:var(--text);
  padding:14px 16px;border-radius:var(--radius);font-size:16px;font-family:var(--mono)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{background:var(--accent);color:#04120f;border:0;padding:14px 24px;border-radius:var(--radius);
  font-size:16px;font-weight:650;cursor:pointer;font-family:inherit}
button:hover{background:var(--accent-dim)}
button:disabled{opacity:.55;cursor:progress}
.keyrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--muted);margin-bottom:44px}
.keyrow input{flex:0 1 300px;padding:9px 12px;font-size:13px;border-radius:9px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin-bottom:18px}
.hidden{display:none}
.scorewrap{display:flex;gap:28px;align-items:center;flex-wrap:wrap}
.ring{flex:0 0 128px}
.scoremeta h2{margin:0 0 6px;font-size:20px;letter-spacing:-.01em;word-break:break-all}
.verdict{color:var(--muted);margin:0 0 10px}
.chips{display:flex;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:12px}
.chip{background:var(--panel-2);border:1px solid var(--line);padding:4px 9px;border-radius:99px;color:var(--muted)}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin:0 0 16px;font-weight:600}
.cat{display:grid;grid-template-columns:150px 1fr 58px;gap:12px;align-items:center;margin-bottom:11px;font-size:14px}
.track{height:8px;background:var(--panel-2);border-radius:99px;overflow:hidden}
.fill{height:100%;border-radius:99px;transition:width .5s ease}
.num{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right}
table{width:100%;border-collapse:collapse;font-size:14px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:600}
td.tok{font-family:var(--mono);font-size:13px}
.ok{color:var(--green)} .bad{color:var(--red);font-weight:600}
.finding{border-left:3px solid var(--line);padding:2px 0 2px 16px;margin-bottom:22px}
.finding.critical{border-color:var(--red)} .finding.high{border-color:var(--red)}
.finding.medium{border-color:var(--amber)} .finding.low{border-color:var(--blue)}
.ftitle{font-weight:650;margin:0 0 6px;display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.sev{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;padding:2px 7px;border-radius:5px;background:var(--panel-2);color:var(--muted)}
.sev.critical,.sev.high{background:rgba(248,113,113,.15);color:var(--red)}
.sev.medium{background:rgba(251,191,36,.15);color:var(--amber)}
.sev.low{background:rgba(96,165,250,.15);color:var(--blue)}
.fdetail{margin:0 0 8px;color:var(--text)}
.fix{margin:0;color:var(--muted);font-size:14px}
.fix b{color:var(--accent);font-weight:600}
pre{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow-x:auto;
  font-family:var(--mono);font-size:12.5px;line-height:1.55;margin:8px 0}
.lock{background:linear-gradient(180deg,transparent,var(--panel-2));border:1px dashed var(--line);
  border-radius:var(--radius);padding:26px;text-align:center;margin-top:6px}
.lock p{margin:0 0 14px;color:var(--muted)}
.lock strong{color:var(--text)}
.cta{display:inline-block;background:var(--accent);color:#04120f;padding:12px 22px;border-radius:var(--radius);
  text-decoration:none;font-weight:650}
.cta-disabled{background:var(--panel-2);color:var(--muted);border:1px dashed var(--line);cursor:not-allowed}
.cta-request{background:var(--panel-2);color:var(--text);border:1px solid var(--accent)}
.err{border-color:var(--red);color:var(--red)}
.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.tab{background:var(--panel-2);border:1px solid var(--line);color:var(--muted);padding:6px 13px;border-radius:9px;
  font-size:13px;cursor:pointer;font-family:var(--mono)}
.tab[aria-selected=true]{background:var(--accent);color:#04120f;border-color:var(--accent);font-weight:600}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
.price{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:24px}
.price.pro{border-color:var(--accent)}
.price h4{margin:0 0 4px;font-size:17px}
.amount{font-size:32px;font-weight:700;letter-spacing:-.02em;margin:8px 0 4px}
.amount span{font-size:14px;font-weight:400;color:var(--muted)}
.price ul{margin:14px 0 20px;padding-left:18px;color:var(--muted);font-size:14px}
.price li{margin-bottom:6px}
footer{color:var(--muted);font-size:13px;padding:40px 0 60px;border-top:1px solid var(--line);margin-top:50px}
.spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#04120f;
  border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:560px){.cat{grid-template-columns:110px 1fr 52px;font-size:13px}}
</style>
</head>
<body>
<div class="wrap">

<!-- Only the wordmark is site chrome. The headline and the sentence under it
     are this page's own content, so they live in <main>: extractors discard
     <header>, and a page that put its whole argument there would fail the
     content-depth check this tool sells. -->
<header>
  <div class="logo">Citable</div>
</header>

<main>
  <h1>Can AI answer engines actually cite your site?</h1>
  <p class="sub">ChatGPT, Claude, Perplexity and Google AI Overviews send traffic to pages they can crawl, read and trust. Most sites fail at least one of the three without knowing. Check yours in about ten seconds.</p>

  <!--run-->
  <form id="f">
    <input id="url" type="url" placeholder="https://yoursite.com/page" required autocomplete="url" spellcheck="false">
    <button id="go" type="submit">Run free audit</button>
  </form>
  <div class="keyrow">
    <label for="key">Pro key</label>
    <input id="key" type="text" placeholder="CTB1…  (optional)" spellcheck="false" autocomplete="off">
    <span>unlocks every finding + generated fix files</span>
  </div>
  <!--/run-->

  <div id="out"></div>

  <section id="pricing" class="card">
    <h3>Pricing</h3>
    <div class="grid2">
      <div class="price">
        <h4>Free</h4>
        <div class="amount">$0</div>
        <ul>
          <li>Full score and category breakdown</li>
          <li>Complete AI crawler access matrix</li>
          <li>Your top 3 findings</li>
          <li>Unlimited local CLI audits</li>
        </ul>
      </div>
      <div class="price pro">
        <h4>Pro</h4>
        <div class="amount">$49 <span>one-time</span></div>
        <ul>
          <li>Every finding, ranked by points recovered</li>
          <li>Generated robots.txt patch for AI crawlers</li>
          <li>Generated llms.txt for your site</li>
          <li>Generated JSON-LD and FAQPage schema</li>
          <li>Whole-site crawls and Markdown reports</li>
          <li>CI gate: fail builds when the score drops</li>
        </ul>
        ${buyButton('Get a Pro key', 'Request a Pro key')}
      </div>
    </div>
  </section>

  <section class="card">
    <h3>What gets checked</h3>
    <div class="grid2">
      <div><strong>Crawler access</strong><p class="fix">Whether robots.txt lets the crawlers that produce citations reach the page at all — checked per crawler, per path.</p></div>
      <div><strong>Readable content</strong><p class="fix">Whether the answer exists in the HTML. Most AI crawlers do not run JavaScript, so a client-rendered page reads as blank.</p></div>
      <div><strong>Answer structure</strong><p class="fix">Whether a model can lift a clean answer: one H1, question-shaped headings, lists and tables, a direct opening paragraph.</p></div>
      <div><strong>Structured data</strong><p class="fix">Whether the page states machine-readable facts about who published it and what kind of content it is.</p></div>
      <div><strong>Metadata</strong><p class="fix">Title, description, canonical, language and Open Graph — the text engines reuse when they build a source card.</p></div>
      <div><strong>Authority</strong><p class="fix">Authorship, freshness dates and outbound citations, which decide who wins between two sources making the same claim.</p></div>
    </div>
  </section>
</main>

<footer>
  <p>Citable checks ${crawlerCount} AI crawlers across OpenAI, Anthropic, Google, Perplexity, Apple, Meta, Amazon, ByteDance and Common Crawl.</p>
  <p>API: <code>GET /api/audit?url=example.com</code> · <code>format=markdown</code> for a report · CLI: <code>npx citable example.com</code></p>
</footer>

</div>

${demoResult ? '<script>window.__CITABLE_DEMO__ = ' + JSON.stringify(demoResult).replace(/</g, '\\u003c') + ';</script>' : ''}
<script>
const CATEGORY_COLORS = { high:'var(--green)', mid:'var(--amber)', low:'var(--red)' };
const out = document.getElementById('out');
const form = document.getElementById('f');
const go = document.getElementById('go');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function barColor(ratio){ return ratio >= .8 ? CATEGORY_COLORS.high : ratio >= .5 ? CATEGORY_COLORS.mid : CATEGORY_COLORS.low; }

function ring(score){
  const radius = 54, circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const color = barColor(score / 100);
  return \`<svg class="ring" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Score \${score} out of 100">
    <circle cx="64" cy="64" r="\${radius}" fill="none" stroke="var(--panel-2)" stroke-width="11"/>
    <circle cx="64" cy="64" r="\${radius}" fill="none" stroke="\${color}" stroke-width="11" stroke-linecap="round"
      stroke-dasharray="\${circumference}" stroke-dashoffset="\${offset}" transform="rotate(-90 64 64)"/>
    <text x="64" y="60" text-anchor="middle" font-size="30" font-weight="700" fill="var(--text)"
      font-family="var(--sans)">\${score}</text>
    <text x="64" y="80" text-anchor="middle" font-size="11" fill="var(--muted)" font-family="var(--sans)">out of 100</text>
  </svg>\`;
}

function renderCategories(categories){
  return Object.values(categories).map((category) => \`
    <div class="cat">
      <div title="\${esc(category.blurb)}">\${esc(category.label)}</div>
      <div class="track"><div class="fill" style="width:\${Math.round(category.ratio*100)}%;background:\${barColor(category.ratio)}"></div></div>
      <div class="num">\${category.earned}/\${category.max}</div>
    </div>\`).join('');
}

function renderCrawlers(crawlers){
  if (!crawlers || !crawlers.length) return '<p class="fix">No robots.txt was found, so nothing is blocked — every crawler may fetch this page.</p>';
  const rows = crawlers.map((crawler) => \`<tr>
      <td class="tok">\${esc(crawler.token)}</td>
      <td>\${esc(crawler.surface)}</td>
      <td>\${esc(crawler.purpose)}</td>
      <td class="\${crawler.allowed ? 'ok' : 'bad'}">\${crawler.allowed ? 'Allowed' : 'Blocked'}\${crawler.rule && !crawler.allowed ? ' — <span class="tok">'+esc(crawler.rule)+'</span>' : ''}</td>
    </tr>\`).join('');
  return \`<div class="scroll"><table><thead><tr><th>Crawler</th><th>Surface</th><th>Purpose</th><th>Status</th></tr></thead><tbody>\${rows}</tbody></table></div>\`;
}

function renderFindings(issues){
  if (!issues.length) return '<p class="fix">No open findings — every check passed.</p>';
  return issues.map((issue, index) => \`
    <div class="finding \${esc(issue.severity)}">
      <p class="ftitle"><span class="sev \${esc(issue.severity)}">\${esc(issue.severity.toUpperCase())}</span> \${index+1}. \${esc(issue.title)}</p>
      <p class="fdetail">\${esc(issue.detail)}</p>
      \${issue.evidence ? '<pre>'+esc(String(issue.evidence).slice(0,900))+'</pre>' : ''}
      \${issue.impact ? '<p class="fix"><b>Costs you:</b> '+esc(issue.impact)+'</p>' : ''}
      \${issue.fix ? '<p class="fix"><b>Fix:</b> '+esc(issue.fix)+'</p>' : ''}
    </div>\`).join('');
}

function renderGenerated(generated){
  const panels = [
    ['robots.txt', generated.robotsTxt, ''],
    ['llms.txt', generated.llmsTxt, ''],
    ['JSON-LD', generated.jsonLd.markup, generated.jsonLd.note],
    ['FAQ schema', generated.faqSchema.markup, generated.faqSchema.note],
  ];
  const tabs = panels.map(([name], index) =>
    \`<button class="tab" role="tab" aria-selected="\${index===0}" data-panel="\${index}">\${esc(name)}</button>\`).join('');
  const bodies = panels.map(([name, content, note], index) =>
    \`<div class="panel \${index===0?'':'hidden'}" data-panel="\${index}">
      \${note ? '<p class="fix">'+esc(note)+'</p>' : ''}
      \${content ? '<pre>'+esc(content)+'</pre>' : '<p class="fix">Nothing to generate — this is already in place.</p>'}
    </div>\`).join('');
  return \`<div class="card"><h3>Ready-to-ship fixes</h3><div class="tabs" role="tablist">\${tabs}</div>\${bodies}</div>\`;
}

function renderResult(result){
  const upgrade = result.issuesWithheld > 0 ? \`
    <div class="lock">
      <p><strong>\${result.issuesWithheld} more finding\${result.issuesWithheld===1?'':'s'} found on this page.</strong><br>
      Pro unlocks all \${result.issuesTotal}, plus a generated robots.txt patch, llms.txt, JSON-LD and FAQ schema built from this page.</p>
      ${buyButton('Unlock the full report — $49', 'Request a key — $49')}
    </div>\` : '';

  out.innerHTML = \`
    <div class="card">
      <div class="scorewrap">
        \${ring(result.score)}
        <div class="scoremeta">
          <h2>\${esc(result.url)}</h2>
          <p class="verdict">\${esc(result.verdict)}</p>
          <div class="chips">
            <span class="chip">Grade \${esc(result.grade)}</span>
            <span class="chip">HTTP \${result.http.status}</span>
            <span class="chip">\${result.http.responseMs}ms</span>
            <span class="chip">\${result.stats.words} words rendered</span>
            <span class="chip">\${result.issuesTotal} open findings</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card"><h3>Score breakdown</h3>\${renderCategories(result.categories)}</div>
    <div class="card"><h3>Which AI engines can reach this page</h3>\${renderCrawlers(result.crawlers)}</div>
    <div class="card"><h3>Findings\${result.tier==='free' ? ' — top '+result.issues.length : ''}</h3>\${renderFindings(result.issues)}\${upgrade}</div>
    \${result.generated ? renderGenerated(result.generated) : ''}
  \`;

  out.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      out.querySelectorAll('.tab').forEach((other) => other.setAttribute('aria-selected', String(other === tab)));
      out.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== tab.dataset.panel));
    });
  });
  out.scrollIntoView({ behavior:'smooth', block:'start' });
}

// The static build (GitHub Pages) serves this page without the audit form,
// since a browser cannot fetch another origin to audit it. Everything below
// is guarded so the same script drives both the hosted app and that build.
if (form) form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = document.getElementById('url').value.trim();
  const key = keyField ? keyField.value.trim() : '';
  if (!url) return;

  go.disabled = true;
  go.innerHTML = '<span class="spin"></span>Auditing…';
  out.innerHTML = '<div class="card"><p class="fix">Fetching the page, robots.txt, llms.txt and sitemap…</p></div>';

  try {
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, key: key || undefined }),
    });
    const data = await response.json();
    if (!response.ok) {
      out.innerHTML = '<div class="card err"><strong>' + esc(data.error || 'Failed') + '</strong><p class="fix">' + esc(data.message || '') + '</p></div>';
    } else {
      renderResult(data);
      if (key) localStorage.setItem('citable_key', key);
    }
  } catch (error) {
    out.innerHTML = '<div class="card err"><strong>Network error</strong><p class="fix">' + esc(error.message) + '</p></div>';
  } finally {
    go.disabled = false;
    go.textContent = 'Run free audit';
  }
});

const keyField = document.getElementById('key');
const savedKey = localStorage.getItem('citable_key');
if (savedKey && keyField) keyField.value = savedKey;

// A baked-in sample report, when this page was served as the demo.
if (window.__CITABLE_DEMO__) {
  renderResult(window.__CITABLE_DEMO__);
  window.scrollTo(0, 0);
}
</script>
</body>
</html>`;
}
