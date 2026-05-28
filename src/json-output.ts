/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as systeminformation from 'systeminformation';

import {BrowserConfig} from './browser.js';
import {measurementName} from './measure.js';
import {ResultStatsWithDifferences} from './stats.js';
import {BenchmarkResult, Measurement, Unit} from './types.js';

export interface JsonOutputFile {
  benchmarks: Benchmark[];
}

interface BrowserConfigResult extends BrowserConfig {
  userAgent?: string;
}

interface Benchmark {
  name: string;
  bytesSent: number;
  version?: string;
  measurement: Measurement;
  browser?: BrowserConfigResult;
  mean: ConfidenceInterval;
  /**
   * Sparse list of pairwise comparisons against other benchmarks. Each
   * entry's `against` field is the 0-based index into this file's
   * `benchmarks` array of the peer this benchmark was compared with.
   *
   * Only peers within the same comparison group are listed (same unit
   * plus same `measurement.compareKey` for keyed measurements, or
   * any other keyless same-unit benchmark for legacy timing
   * benchmarks). Peers that are not comparable are simply absent from
   * the array; do not assume `differences[i]` corresponds to
   * `benchmarks[i]` - look at `against`.
   *
   * The previous dense `Array<Difference | null>` shape (one slot per
   * benchmark, with `null` for non-comparable pairs) is gone: with
   * auto-discovered memory measurements a single run can produce tens
   * of thousands of benchmarks, and the dense N^2 representation no
   * longer fits in memory.
   */
  differences: Difference[];
  samples: number[];
  /**
   * The unit the {@link samples} and {@link mean} values are expressed in.
   * Defaults to `'ms'` when omitted for backward compatibility.
   */
  unit?: Unit;
}

interface Difference {
  /**
   * Index into the surrounding {@link JsonOutputFile.benchmarks} array
   * identifying the peer this difference is computed against.
   */
  against: number;
  absolute: ConfidenceInterval;
  percentChange: ConfidenceInterval;
}

interface ConfidenceInterval {
  low: number;
  high: number;
}

export function jsonOutput(
  results: ResultStatsWithDifferences[]
): JsonOutputFile {
  const benchmarks: Benchmark[] = [];
  for (const result of results) {
    const differences: Difference[] = [];
    // The sparse map already only contains entries for peers within the
    // same comparison group, so we can serialize it directly without
    // walking the full result list (which would re-introduce the O(N^2)
    // memory cost we just removed in `computeDifferences`).
    for (const [peerIndex, difference] of result.differences) {
      differences.push({
        against: peerIndex,
        absolute: {
          low: difference.absolute.low,
          high: difference.absolute.high,
        },
        percentChange: {
          low: difference.relative.low * 100,
          high: difference.relative.high * 100,
        },
      });
    }
    // Stable order: ascending peer index.
    differences.sort((a, b) => a.against - b.against);
    benchmarks.push({
      name: result.result.name,
      bytesSent: result.result.bytesSent,
      version: result.result.version ? result.result.version : undefined,
      measurement: {
        name: measurementName(result.result.measurement),
        ...result.result.measurement,
      },
      browser: {
        ...result.result.browser,
        userAgent: result.result.userAgent,
      },
      mean: {
        low: result.stats.meanCI.low,
        high: result.stats.meanCI.high,
      },
      differences,
      samples: result.result.millis,
      // Only emit unit when not the default 'ms' to maintain backward
      // compatibility with existing JSON consumers.
      ...(result.result.unit && result.result.unit !== 'ms'
        ? {unit: result.result.unit}
        : {}),
    });
  }
  return {benchmarks};
}

// TODO(aomarks) Remove this in next major version.
export interface LegacyJsonOutputFormat {
  benchmarks: BenchmarkResult[];
  datetime: string; // YYYY-MM-DDTHH:mm:ss.sssZ
  system: {
    cpu: {
      manufacturer: string;
      model: string;
      family: string;
      speed: string;
      cores: number;
    };
    load: {
      average: number;
      current: number;
    };
    battery: {
      hasBattery: boolean;
      connected: boolean;
    };
    memory: {
      total: number;
      free: number;
      used: number;
      active: number;
      available: number;
    };
  };
}

// TODO(aomarks) Remove this in next major version.
export async function legacyJsonOutput(
  results: BenchmarkResult[]
): Promise<LegacyJsonOutputFormat> {
  // TODO Add git info.
  const battery = await systeminformation.battery();
  const cpu = await systeminformation.cpu();
  const currentLoad = await systeminformation.currentLoad();
  const memory = await systeminformation.mem();
  return {
    benchmarks: results,
    datetime: new Date().toISOString(),
    system: {
      cpu: {
        manufacturer: cpu.manufacturer,
        model: cpu.model,
        family: cpu.family,
        speed: cpu.speed.toFixed(2),
        cores: cpu.cores,
      },
      load: {
        average: currentLoad.avgLoad,
        current: currentLoad.currentLoad,
      },
      battery: {
        hasBattery: battery.hasBattery,
        connected: battery.acConnected,
      },
      memory: {
        total: memory.total,
        free: memory.free,
        used: memory.used,
        active: memory.active,
        available: memory.available,
      },
    },
  };
}
