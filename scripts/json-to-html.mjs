#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

/**
 * Render a tachometer --json-file result file as a self-contained HTML
 * report.
 *
 * Usage:
 *   node scripts/json-to-html.mjs <results.json> [<out.html>]
 *
 * If <out.html> is omitted, the report is written alongside the input as
 * `<results>.html`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length < 1 || args[0] === '--help' || args[0] === '-h') {
  console.error(
    'Usage: node scripts/json-to-html.mjs <results.json> [<out.html>]'
  );
  process.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 1);
}

const inputPath = path.resolve(args[0]);
const outputPath = args[1]
  ? path.resolve(args[1])
  : inputPath.replace(/\.json$/i, '') + '.html';

const json = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const benchmarks = json.benchmarks ?? [];
if (benchmarks.length === 0) {
  console.error(`No benchmarks found in ${inputPath}`);
  process.exit(1);
}

// ---------- formatting helpers ----------

const fmtMs = (n) => `${n.toFixed(2)}ms`;

const fmtBytes = (n) => {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs.toFixed(0)} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(2)} KiB`;
  if (abs < 1024 * 1024 * 1024)
    return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MiB`;
  return `${sign}${(abs / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const fmt = (n, unit) => (unit === 'bytes' ? fmtBytes(n) : fmtMs(n));

const fmtCi = (ci, unit) =>
  `${fmt(ci.low, unit)} <span class="dim">–</span> ${fmt(ci.high, unit)}`;

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c])
  );

// ---------- sample stats ----------

function sampleStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const median =
    n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
  const variance =
    samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1 || 1);
  const stddev = Math.sqrt(variance);
  return {min, max, mean, median, stddev, n};
}

// ---------- inline SVG histogram ----------

function sparkHistogram(samples, unit, width = 220, height = 36) {
  if (samples.length === 0) return '';
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  // Sturges' rule, capped.
  const buckets = Math.max(
    4,
    Math.min(20, Math.ceil(Math.log2(samples.length) + 1))
  );
  const span = max - min || 1;
  const counts = new Array(buckets).fill(0);
  for (const v of samples) {
    let idx = Math.floor(((v - min) / span) * buckets);
    if (idx === buckets) idx = buckets - 1;
    counts[idx]++;
  }
  const peak = Math.max(...counts, 1);
  const barW = width / buckets;
  const pad = 1;
  const bars = counts
    .map((c, i) => {
      const h = (c / peak) * (height - 2);
      const x = i * barW + pad / 2;
      const y = height - h;
      const w = barW - pad;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(
        2
      )}" height="${h.toFixed(2)}" />`;
    })
    .join('');
  const title = `${samples.length} samples; min ${fmt(min, unit)}, max ${fmt(
    max,
    unit
  )}`;
  return `<svg class="hist" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(
    title
  )}"><title>${escapeHtml(title)}</title>${bars}</svg>`;
}

// ---------- per-result rendering ----------

const unitOf = (b) => b.unit ?? 'ms';

function browserLabel(b) {
  const br = b.browser ?? {};
  let s = br.name ?? '?';
  if (br.headless) s += '-headless';
  if (br.userAgent) {
    const m = br.userAgent.match(
      /(Chrome|Firefox|Edg|Safari|HeadlessChrome)\/(\d+(?:\.\d+)*)/
    );
    if (m) s += ` <span class="dim">${escapeHtml(m[2])}</span>`;
  }
  return s;
}

function diffCell(diff, rUnit) {
  if (!diff) {
    return '<td class="diff diff-empty"><span class="dim">—</span></td>';
  }
  const absLow = diff.absolute.low;
  const absHigh = diff.absolute.high;
  const pctLow = diff.percentChange.low;
  const pctHigh = diff.percentChange.high;
  let cls = 'diff-unsure';
  let label = 'unsure';
  if (absLow > 0 && pctLow > 0) {
    cls = 'diff-slower';
    label = 'slower';
  } else if (absHigh < 0 && pctHigh < 0) {
    cls = 'diff-faster';
    label = 'faster';
  }
  // Show the diff as positive magnitudes when faster.
  const showAbs =
    cls === 'diff-faster'
      ? {low: -absHigh, high: -absLow}
      : {low: absLow, high: absHigh};
  const showPct =
    cls === 'diff-faster'
      ? {low: -pctHigh, high: -pctLow}
      : {low: pctLow, high: pctHigh};
  return `<td class="diff ${cls}">
    <div class="label">${label}</div>
    <div class="ci">${fmt(showAbs.low, rUnit)} <span class="dim">–</span> ${fmt(
    showAbs.high,
    rUnit
  )}</div>
    <div class="ci dim">${showPct.low.toFixed(
      1
    )}% <span>–</span> ${showPct.high.toFixed(1)}%</div>
  </td>`;
}

// ---------- HTML ----------

const generated = new Date();
const reportTitle = path.basename(inputPath);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>tachometer report — ${escapeHtml(reportTitle)}</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: #1d1d1f;
    --bg: #ffffff;
    --surface: #f7f7f8;
    --border: #e4e4e7;
    --dim: #6b7280;
    --accent: #0a84ff;
    --faster: #16a34a;
    --slower: #dc2626;
    --unsure: #6b7280;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #f5f5f7;
      --bg: #0b0b0c;
      --surface: #18181b;
      --border: #27272a;
      --dim: #a1a1aa;
      --accent: #4eb3ff;
      --faster: #4ade80;
      --slower: #f87171;
      --unsure: #a1a1aa;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    color: var(--fg);
    background: var(--bg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.4;
  }
  main { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px 0; font-weight: 600; }
  h2 { font-size: 16px; margin: 32px 0 12px 0; font-weight: 600; }
  .meta {
    color: var(--dim);
    font-size: 12px;
    margin-bottom: 24px;
  }
  .meta code {
    background: var(--surface);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .dim { color: var(--dim); }
  table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 12px;
    font-variant-numeric: tabular-nums;
  }
  thead th {
    text-align: left;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 8px 10px;
    font-weight: 600;
    font-size: 12px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  tbody td {
    padding: 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  tbody tr:hover { background: var(--surface); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .bench-name { font-weight: 600; }
  .unit-badge {
    display: inline-block;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-left: 6px;
  }
  .hist {
    width: 220px;
    height: 36px;
    fill: var(--accent);
    display: block;
  }
  /* Differences matrix */
  table.diff-matrix th, table.diff-matrix td {
    padding: 6px 8px;
    font-size: 12px;
  }
  table.diff-matrix th.col {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    text-align: left;
    white-space: nowrap;
    max-height: 180px;
  }
  table.diff-matrix th.row {
    text-align: left;
    white-space: nowrap;
    background: var(--surface);
  }
  td.diff {
    text-align: right;
    min-width: 140px;
  }
  td.diff .label {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  td.diff .ci { font-size: 11px; line-height: 1.3; }
  td.diff-faster { color: var(--faster); }
  td.diff-slower { color: var(--slower); }
  td.diff-unsure { color: var(--unsure); }
  td.diff-empty { background: var(--surface); }
  .footer {
    margin-top: 32px;
    font-size: 11px;
    color: var(--dim);
    text-align: center;
  }
</style>
</head>
<body>
<main>
  <h1>tachometer report</h1>
  <p class="meta">
    Source: <code>${escapeHtml(inputPath)}</code>
    · Generated ${generated.toISOString()}
    · ${benchmarks.length} result${benchmarks.length === 1 ? '' : 's'}
  </p>

  <h2>Summary</h2>
  <table>
    <thead>
      <tr>
        <th>Benchmark</th>
        <th>Browser</th>
        <th class="num">Samples</th>
        <th class="num">Mean (95% CI)</th>
        <th class="num">Median</th>
        <th class="num">Min</th>
        <th class="num">Max</th>
        <th class="num">Std dev</th>
        <th>Distribution</th>
      </tr>
    </thead>
    <tbody>
      ${benchmarks
        .map((b) => {
          const unit = unitOf(b);
          const s = sampleStats(b.samples);
          return `<tr>
            <td><span class="bench-name">${escapeHtml(
              b.name
            )}</span><span class="unit-badge">${escapeHtml(unit)}</span></td>
            <td>${browserLabel(b)}</td>
            <td class="num">${s.n}</td>
            <td class="num">${fmtCi(b.mean, unit)}</td>
            <td class="num">${fmt(s.median, unit)}</td>
            <td class="num">${fmt(s.min, unit)}</td>
            <td class="num">${fmt(s.max, unit)}</td>
            <td class="num">${fmt(s.stddev, unit)}</td>
            <td>${sparkHistogram(b.samples, unit)}</td>
          </tr>`;
        })
        .join('\n')}
    </tbody>
  </table>

  <h2>Differences (95% confidence intervals)</h2>
  <p class="meta">
    Each cell compares the row benchmark to the column benchmark. Cross-unit
    pairs (e.g. milliseconds vs bytes) are intentionally left blank.
  </p>
  <table class="diff-matrix">
    <thead>
      <tr>
        <th></th>
        ${benchmarks
          .map((b) => `<th class="col">${escapeHtml(b.name)}</th>`)
          .join('')}
      </tr>
    </thead>
    <tbody>
      ${benchmarks
        .map((row, ri) => {
          const rUnit = unitOf(row);
          return `<tr>
            <th class="row">${escapeHtml(row.name)}</th>
            ${benchmarks
              .map((_, ci) =>
                ri === ci
                  ? '<td class="diff diff-empty"><span class="dim">·</span></td>'
                  : diffCell(row.differences?.[ci], rUnit)
              )
              .join('')}
          </tr>`;
        })
        .join('\n')}
    </tbody>
  </table>

  <p class="footer">
    Rendered by <code>scripts/json-to-html.mjs</code>.
  </p>
</main>
</body>
</html>
`;

await fs.writeFile(outputPath, html, 'utf8');
console.log(`Wrote ${outputPath}`);
