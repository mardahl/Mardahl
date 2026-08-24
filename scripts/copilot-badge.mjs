#!/usr/bin/env node
// Updates a public Gist with cumulative GitHub Copilot AI credit spend
// for GH_LOGIN, sourced from the org-level AI credit usage endpoint.
// No dependencies beyond Node 22's built-in fetch.

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

// 4. Idempotent write: skip PATCH if badge unchanged
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
