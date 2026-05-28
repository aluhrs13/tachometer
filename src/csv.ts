/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {stringify as csvStringify} from 'csv-stringify/sync';

import {ResultStatsWithDifferences} from './stats.js';

const precision = 5;

/**
 * Format statistical results as a CSV file string.
 *
 * Columns: benchmark, mean min, mean max, vs benchmark, % change min,
 * % change max, change min, change max.
 *
 * Each result contributes one "mean" row (with the four `vs` columns
 * empty) plus one row per pairwise comparison against a peer in the
 * same compareKey group. The legacy "wide" shape (one `vs <peer>`
 * group of columns per benchmark) doesn't scale: with auto-discovered
 * memory measurements a single run can produce tens of thousands of
 * benchmarks, which would mean millions of columns.
 */
export function formatCsvStats(results: ResultStatsWithDifferences[]): string {
  // Use the unit of the first result for the column header. If results have
  // mixed units (e.g. ms and bytes), values are still emitted unchanged with
  // their natural unit.
  const unit = (results[0]?.result.unit ?? 'ms') as 'ms' | 'bytes';
  const header = [
    'benchmark',
    `mean min (${unit})`,
    `mean max (${unit})`,
    'vs benchmark',
    '% change min',
    '% change max',
    `${unit} change min`,
    `${unit} change max`,
  ];
  const rows: Array<Array<string>> = [];
  for (const result of results) {
    rows.push([
      result.result.name,
      result.stats.meanCI.low.toFixed(precision),
      result.stats.meanCI.high.toFixed(precision),
      '',
      '',
      '',
      '',
      '',
    ]);
    // Stable order: ascending peer index.
    const sortedDiffs = [...result.differences.entries()].sort(
      (a, b) => a[0] - b[0]
    );
    for (const [peerIndex, diff] of sortedDiffs) {
      rows.push([
        result.result.name,
        '',
        '',
        results[peerIndex].result.name,
        (diff.relative.low * 100).toFixed(precision) + '%',
        (diff.relative.high * 100).toFixed(precision) + '%',
        diff.absolute.low.toFixed(precision),
        diff.absolute.high.toFixed(precision),
      ]);
    }
  }
  return csvStringify([header, ...rows]);
}

/**
 * Format raw sample results as a CSV file string.
 *
 * Columns correspond to benchmarks. Rows correspond to sample iterations. The
 * first row is headers containing the benchmark names.
 *
 * For example:
 *
 * foo, bar, baz
 * 1.2, 5.5, 9.4
 * 1.8, 5.6, 9.1
 * 1.3, 5.2, 9.8
 */
export function formatCsvRaw(results: ResultStatsWithDifferences[]): string {
  const headers = [];
  const rows: Array<number[]> = [];
  for (let r = 0; r < results.length; r++) {
    const {result} = results[r];
    headers.push(result.name);
    for (let m = 0; m < result.millis.length; m++) {
      if (rows[m] === undefined) {
        rows[m] = [];
      }
      rows[m][r] = result.millis[m];
    }
  }
  return csvStringify([headers, ...rows]);
}
