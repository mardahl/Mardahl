#!/usr/bin/env node
// Updates a public Gist with cumulative GitHub Copilot AI credit spend
// for GH_LOGIN, sourced from the org-level AI credit usage endpoint.
// No dependencies beyond Node 22's built-in fetch.

import { writeFileSync } from 'node:fs';

const { BILLING_PAT, GIST_PAT, GH_ORG, GH_LOGIN, GIST_ID } = process.env;
for (const [k, v] of Object.entries({ BILLING_PAT, GIST_PAT, GH_ORG, GH_LOGIN, GIST_ID })) {
  if (!v) { console.error(`Missing env var ${k}`); process.exit(1); }
}

const API = 'https://api.github.com';
const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
});

const now = new Date();

// Daily runs refresh the current + previous month (previous catches late-posting
// line items). Pass BACKFILL=1 (workflow_dispatch input) to also fetch every
// month for the past 24 months - one-time seeding, the API's retention limit.
// Historic months are recomputed from the API when inside the window; older
// months stay frozen in state once they fall outside it.
const backfill = process.env.BACKFILL === '1';
const monthsToQuery = [];
const pushMonth = (year, month /* 1-based */) => monthsToQuery.push({ year, month });
pushMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
pushMonth(prev.getUTCFullYear(), prev.getUTCMonth() + 1);
if (backfill) {
  for (let i = 2; i < 24; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    pushMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }
}
console.log(`Querying ${monthsToQuery.length} month(s)${backfill ? ' (backfill mode)' : ''}.`);

// 1. Read existing gist state
const gistRes = await fetch(`${API}/gists/${GIST_ID}`, { headers: headers(GIST_PAT) });
if (!gistRes.ok) {
  console.error(`Gist read failed: HTTP ${gistRes.status}`);
  process.exit(1);
}
const gist = await gistRes.json();
const stateFile = gist.files['copilot-state.json'];
let state = { cumulativeUsd: 0, months: {}, lastUpdated: '' };
if (stateFile && !stateFile.truncated) {
  try { state = JSON.parse(stateFile.content); } catch {}
}

// 2. Query billing API for current + previous month (API is per-month source of truth)
for (const { year, month } of monthsToQuery) {
  const url = `${API}/organizations/${GH_ORG}/settings/billing/ai_credit/usage?year=${year}&month=${month}`;
  const res = await fetch(url, { headers: headers(BILLING_PAT) });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      console.error('HTTP', res.status, '- BILLING_PAT is fine-grained or missing manage_billing scope. Classic PAT required.');
    } else if (res.status === 404) {
      console.error('HTTP 404 - wrong org slug or org not on enhanced billing platform.');
    } else {
      console.error('HTTP', res.status, 'from billing API');
    }
    process.exit(1);
  }
  const body = await res.json();
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const usd = (body.usageItems || [])
    .filter((i) => i.product === 'Copilot')
    .reduce((s, i) => s + (i.netAmount || 0), 0);
  state.months[key] = Math.round(usd * 100) / 100;
}

state.cumulativeUsd = Math.round(Object.values(state.months).reduce((s, v) => s + v, 0) * 100) / 100;
state.lastUpdated = now.toISOString();

// 3. Build shields.io endpoint JSON (credits only, never a $ figure)
// 1 AI credit = $0.01 USD, so credits = round(netAmount * 100).
const creditsTotal = Math.round(state.cumulativeUsd * 100);
const badge = {
  schemaVersion: 1,
  label: 'copilot AI credits',
  message: creditsTotal.toLocaleString('en-US'),
  color: 'blue',
  namedLogo: 'githubcopilot',
};
const badgeStr = JSON.stringify(badge, null, 2) + '\n';
const stateStr = JSON.stringify(state, null, 2) + '\n';

// 3b. Build radical-styled SVG card with monthly sparkline. Written to
// assets/copilot-card.svg by the workflow and committed back to the repo -
// Gist raw URLs serve text/plain with nosniff, so SVG can't be hotlinked
// from there. Repo hotlink via raw.githubusercontent.com works.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sortedMonths = Object.entries(state.months).sort(([a], [b]) => a.localeCompare(b));
const firstNonZeroIdx = sortedMonths.findIndex(([, v]) => v > 0);
const series = (firstNonZeroIdx === -1 ? [] : sortedMonths.slice(firstNonZeroIdx))
  .map(([k, usd]) => ({ key: k, credits: Math.round(usd * 100) }));
const sinceLabel = series.length
  ? new Date(series[0].key + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  : '';

const CARD_W = 480, CARD_H = 200;
const SPARK_X = 30, SPARK_Y = 130, SPARK_W = CARD_W - 60, SPARK_H = 50;
const maxCredits = Math.max(...series.map((s) => s.credits), 1);
const gap = 3;
const barW = series.length ? (SPARK_W - gap * (series.length - 1)) / series.length : 0;
const bars = series.map((s, i) => {
  const h = Math.max(2, (s.credits / maxCredits) * SPARK_H);
  const x = SPARK_X + i * (barW + gap);
  const y = SPARK_Y + (SPARK_H - h);
  const isLatest = i === series.length - 1;
  return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="2" fill="${isLatest ? '#fe428e' : '#f8d847'}" opacity="${isLatest ? '1' : '0.65'}"/>`;
}).join('\n    ');

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" role="img" aria-label="${esc(badge.message)} GitHub Copilot AI credits consumed${sinceLabel ? ` since ${esc(sinceLabel)}` : ''}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141321"/>
      <stop offset="100%" stop-color="#1d1a2e"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" rx="8" fill="url(#bg)" stroke="#fe428e" stroke-opacity="0.4"/>
  <text x="30" y="42" fill="#a9fef7" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" letter-spacing="1">COPILOT AI CREDITS</text>
  <text x="30" y="90" fill="#fe428e" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="42" font-weight="700">${esc(badge.message)}</text>
  ${sinceLabel ? `<text x="30" y="112" fill="#a9fef7" opacity="0.6" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">consumed since ${esc(sinceLabel)}</text>` : ''}
  ${series.length > 0 ? `<g>
    ${bars}
    <text x="${SPARK_X}" y="${SPARK_Y + SPARK_H + 13}" fill="#a9fef7" opacity="0.5" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="9">${esc(series[0].key)}</text>
    <text x="${SPARK_X + SPARK_W}" y="${SPARK_Y + SPARK_H + 13}" text-anchor="end" fill="#a9fef7" opacity="0.5" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="9">${esc(series[series.length - 1].key)}</text>
  </g>` : ''}
</svg>
`;
const cardStr = card;

// Write the SVG card to disk; the workflow commits it back to the repo.
writeFileSync('assets/copilot-card.svg', cardStr);

// 4. Idempotent write: skip PATCH if badge JSON unchanged
const existingBadge = gist.files['copilot-badge.json'];
if (existingBadge && existingBadge.content === badgeStr) {
  console.log('Badge unchanged; skipping Gist PATCH.');
  process.exit(0);
}

const patchRes = await fetch(`${API}/gists/${GIST_ID}`, {
  method: 'PATCH',
  headers: { ...headers(GIST_PAT), 'Content-Type': 'application/json' },
  body: JSON.stringify({
    files: {
      'copilot-state.json': { content: stateStr },
      'copilot-badge.json': { content: badgeStr },
    },
  }),
});
if (!patchRes.ok) {
  console.error('Gist PATCH failed: HTTP', patchRes.status);
  process.exit(1);
}
console.log('Updated Gist. Cumulative spend:', badge.message);
