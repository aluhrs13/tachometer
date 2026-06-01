/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {BenchmarkResult} from './types.js';
import jstat from 'jstat';

interface Distribution {
  mean: number;
  variance: number;
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export interface SummaryStats {
  size: number;
  mean: number;
  meanCI: ConfidenceInterval;
  variance: number;
  standardDeviation: number;
  relativeStandardDeviation: number;
}

export interface ResultStats {
  result: BenchmarkResult;
  stats: SummaryStats;
}

export interface ResultStatsWithDifferences extends ResultStats {
  /**
   * Sparse map from peer index (in the original `stats` array passed to
   * {@link computeDifferences}) to the pairwise difference against that
   * peer. Only peers within the same comparison group have entries:
   *
   * - Results that carry a `compareKey` on their {@link Measurement}
   *   (currently only auto-discovered memory measurements do) compare
   *   only against other results with the same `(unit, compareKey)`
   *   pair.
   * - Results without a `compareKey` compare against every other
   *   compareKey-less result with the same unit. This preserves the
   *   pre-existing all-pairs behavior for traditional timing benchmarks.
   *
   * Indices absent from the map mean "no comparison" - callers should
   * treat missing entries the same way they previously treated `null`
   * slots in the dense array.
   */
  differences: Map<number, Difference>;
}

export interface Difference {
  absolute: ConfidenceInterval;
  relative: ConfidenceInterval;
}

export function summaryStats(data: number[]): SummaryStats {
  const size = data.length;
  const sum = sumOf(data);
  const mean = sum / size;
  const squareResiduals = data.map((val) => (val - mean) ** 2);
  // n - 1 due to https://en.wikipedia.org/wiki/Bessel%27s_correction
  const variance = sumOf(squareResiduals) / (size - 1);
  const stdDev = Math.sqrt(variance);
  return {
    size,
    mean,
    meanCI: confidenceInterval95(
      samplingDistributionOfTheMean({mean, variance}, size),
      size
    ),
    variance,
    standardDeviation: stdDev,
    // aka coefficient of variation
    relativeStandardDeviation: stdDev / mean,
  };
}

/**
 * Compute a 95% confidence interval for the given distribution.
 */
function confidenceInterval95(
  {mean, variance}: Distribution,
  size: number
): ConfidenceInterval {
  // http://www.stat.yale.edu/Courses/1997-98/101/confint.htm
  const t = jstat.studentt.inv(1 - 0.05 / 2, size - 1);
  const stdDev = Math.sqrt(variance);
  const margin = t * stdDev;
  return {
    low: mean - margin,
    high: mean + margin,
  };
}

/**
 * Return whether the given confidence interval contains a value.
 */
export function intervalContains(
  interval: ConfidenceInterval,
  value: number
): boolean {
  return value >= interval.low && value <= interval.high;
}

/**
 * Absolute auto-sample conditions, partitioned by unit. A timing result is
 * checked only against `ms` conditions and a memory result only against
 * `bytes` conditions, so a user can pass e.g. `0.1ms,+10KiB` and have each
 * apply to the appropriate set of results without being incorrectly compared
 * across units.
 */
export interface AutoSampleConditions {
  absolute: {ms: number[]; bytes: number[]};
  relative: number[];
}

/**
 * Return whether all difference confidence intervals are unambiguously located
 * on one side or the other of all given auto sample conditions.
 *
 * For example, given the conditions 0 and 1:
 *
 *    <--->                   true
 *        <--->               false
 *            <--->           true
 *                <--->       false
 *                    <--->   true
 *        <----------->       false
 *
 *  |-------|-------|-------| ms difference
 * -1       0       1       2
 */
export function autoSampleConditionsResolved(
  resultStats: ResultStatsWithDifferences[],
  conditions: AutoSampleConditions
): boolean {
  for (const stats of resultStats) {
    const {differences} = stats;
    if (differences === undefined) {
      continue;
    }
    // Pick the absolute conditions whose unit matches this result. Defaults
    // to `ms` for backward compatibility when a result has no explicit unit.
    const unit = stats.result.unit ?? 'ms';
    const absolute =
      unit === 'bytes' ? conditions.absolute.bytes : conditions.absolute.ms;
    // TODO We may want to offer more control over which particular set of
    // differences we care about resolving. For the moment, a condition of 1%
    // means we'll try to resolve a 1% difference pairwise in both directions.
    for (const diff of differences.values()) {
      for (const condition of absolute) {
        if (intervalContains(diff.absolute, condition)) {
          return false;
        }
      }
      for (const condition of conditions.relative) {
        if (intervalContains(diff.relative, condition)) {
          return false;
        }
      }
    }
  }
  return true;
}

function sumOf(data: number[]): number {
  return data.reduce((acc, cur) => acc + cur);
}

/**
 * Given an array of results, return a new array of results where each result
 * has additional statistics describing how it compares to each other result.
 *
 * The output's `differences` field is a sparse `Map<peerIndex, Difference>`.
 * Comparisons are only computed within the same "group" - two results are
 * in the same group when they share the same unit AND either both have the
 * same `compareKey` or neither has a `compareKey`. This avoids the O(N^2)
 * pairwise iteration that the previous dense implementation performed -
 * with auto-discovered memory measurements, N can be in the hundreds
 * (variants x discovered tuples) and the all-pairs work plus storage was
 * the dominant cost of the run.
 */
export function computeDifferences(
  stats: ResultStats[]
): ResultStatsWithDifferences[] {
  // Bucket result indices by (unit, compareKey). Results without a
  // compareKey collapse into a single per-unit bucket so they continue
  // to be compared pairwise with every other compareKey-less result of
  // the same unit, matching the original all-pairs behavior for timing
  // benchmarks.
  const NO_KEY = '\u0000';
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < stats.length; i++) {
    const unit = stats[i].result.unit ?? 'ms';
    const key = stats[i].result.measurement?.compareKey ?? NO_KEY;
    const bucketKey = `${unit}|${key}`;
    let bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(bucketKey, bucket);
    }
    bucket.push(i);
  }

  const out: ResultStatsWithDifferences[] = stats.map((s) => ({
    ...s,
    differences: new Map<number, Difference>(),
  }));

  // For each bucket, compute the ordered pairwise differences. Note that
  // computeDifference(a, b) and computeDifference(b, a) are asymmetric
  // (relative difference is computed against the first argument's mean),
  // so we need both directions per unordered pair.
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let a = 0; a < bucket.length; a++) {
      const i = bucket[a];
      for (let b = 0; b < bucket.length; b++) {
        if (a === b) continue;
        const j = bucket[b];
        // From result i's perspective, the comparison against peer j is
        // computeDifference(j, i) - matching the original semantics where
        // `differences[j]` on result i held
        // computeDifference(stats[j].stats, stats[i].stats).
        out[i].differences.set(
          j,
          computeDifference(stats[j].stats, stats[i].stats)
        );
      }
    }
  }

  return out;
}

export function computeDifference(
  a: SummaryStats,
  b: SummaryStats
): Difference {
  const meanA = samplingDistributionOfTheMean(a, a.size);
  const meanB = samplingDistributionOfTheMean(b, b.size);
  const diffAbs = samplingDistributionOfAbsoluteDifferenceOfMeans(meanA, meanB);
  const diffRel = samplingDistributionOfRelativeDifferenceOfMeans(meanA, meanB);
  // We're assuming sample sizes are equal. If they're not for some reason, be
  // conservative and use the smaller one for the t-distribution's degrees of
  // freedom (since that will lead to a wider confidence interval).
  const minSize = Math.min(a.size, b.size);
  return {
    absolute: confidenceInterval95(diffAbs, minSize),
    relative: confidenceInterval95(diffRel, minSize),
  };
}

/**
 * Estimates the sampling distribution of the mean. This models the distribution
 * of the means that we would compute under repeated samples of the given size.
 */
function samplingDistributionOfTheMean(
  dist: Distribution,
  sampleSize: number
): Distribution {
  // http://onlinestatbook.com/2/sampling_distributions/samp_dist_mean.html
  // http://www.stat.yale.edu/Courses/1997-98/101/sampmn.htm
  return {
    mean: dist.mean,
    // Error shrinks as sample size grows.
    variance: dist.variance / sampleSize,
  };
}

/**
 * Estimates the sampling distribution of the difference of means (b-a). This
 * models the distribution of the difference between two means that we would
 * compute under repeated samples under the given two sampling distributions of
 * means.
 */
function samplingDistributionOfAbsoluteDifferenceOfMeans(
  a: Distribution,
  b: Distribution
): Distribution {
  // http://onlinestatbook.com/2/sampling_distributions/samplingdist_diff_means.html
  // http://www.stat.yale.edu/Courses/1997-98/101/meancomp.htm
  return {
    mean: b.mean - a.mean,
    // The error from both input sampling distributions of means accumulate.
    variance: a.variance + b.variance,
  };
}

/**
 * Estimates the sampling distribution of the relative difference of means
 * ((b-a)/a). This models the distribution of the relative difference between
 * two means that we would compute under repeated samples under the given two
 * sampling distributions of means.
 */
function samplingDistributionOfRelativeDifferenceOfMeans(
  a: Distribution,
  b: Distribution
): Distribution {
  // http://blog.analytics-toolkit.com/2018/confidence-intervals-p-values-percent-change-relative-difference/
  // Note that the above article also prevents an alternative calculation for a
  // confidence interval for relative differences, but the one chosen here is
  // is much simpler and passes our stochastic tests, so it seems sufficient.
  if (a.mean === 0) {
    // Zero baseline: the percent change is undefined (division by zero).
    // Surface NaN so consumers can detect and render this as e.g. "n/a"
    // rather than `Infinity` (or quietly producing wrong numbers when the
    // variance term is also computed against `a.mean ** 4`).
    return {mean: NaN, variance: NaN};
  }
  return {
    mean: (b.mean - a.mean) / a.mean,
    variance:
      (a.variance * b.mean ** 2 + b.variance * a.mean ** 2) / a.mean ** 4,
  };
}
