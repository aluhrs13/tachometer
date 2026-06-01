/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from 'chai';
import {suite, test} from 'mocha';

import {
  captureCpuMetrics,
  cpuCompareKey,
  enableCpuMetrics,
  measurementName,
  queryForCpu,
} from '../measure.js';
import type {CpuMetricsCache} from '../measure.js';
import {ResolvedCpuMeasurement} from '../types.js';

/**
 * Build a minimal fake Chromium WebDriver exposing the two CDP send methods
 * we use: `sendDevToolsCommand` (void) for `Performance.enable`, and
 * `sendAndGetDevToolsCommand` (value-returning) for `Performance.getMetrics`.
 * This mirrors selenium-webdriver, where only `sendAndGetDevToolsCommand`
 * delivers a command's return payload.
 */
function fakeCpuDriver(opts: {
  enableResult?: unknown;
  enableThrows?: boolean;
  metrics?: Array<{name: string; value: number}> | (() => unknown);
}): unknown {
  return {
    sendDevToolsCommand: async (cmd: string) => {
      if (cmd === 'Performance.enable') {
        if (opts.enableThrows) {
          throw new Error('Thread time is not supported on this platform');
        }
        return opts.enableResult;
      }
      return undefined;
    },
    sendAndGetDevToolsCommand: async (cmd: string) => {
      if (cmd === 'Performance.getMetrics') {
        const m =
          typeof opts.metrics === 'function' ? opts.metrics() : opts.metrics;
        if (m === undefined) {
          return undefined;
        }
        return {metrics: m};
      }
      return undefined;
    },
  };
}

type DriverArg = Parameters<typeof captureCpuMetrics>[0];

suite('cpu', () => {
  suite('cpuCompareKey', () => {
    test('prefixes the metric name with cpu:mainThread:', () => {
      assert.equal(
        cpuCompareKey({mode: 'cpu', metric: 'TaskDuration'}),
        'cpu:mainThread:TaskDuration'
      );
    });
  });

  suite('measurementName', () => {
    test('resolved cpu entry uses cpu:mainThread:<metric>', () => {
      const m: ResolvedCpuMeasurement = {
        mode: 'cpu',
        metric: 'ScriptDuration',
      };
      assert.equal(measurementName(m), 'cpu:mainThread:ScriptDuration');
    });

    test('explicit name wins over auto-derived label', () => {
      const m: ResolvedCpuMeasurement = {
        mode: 'cpu',
        metric: 'ScriptDuration',
        name: 'my-cpu',
      };
      assert.equal(measurementName(m), 'my-cpu');
    });

    test('unresolved cpu measurement falls back to generic label', () => {
      assert.equal(measurementName({mode: 'cpu'}), 'cpu');
    });
  });

  suite('captureCpuMetrics', () => {
    test('returns a name->value (seconds) map', async () => {
      const driver = fakeCpuDriver({
        metrics: [
          {name: 'TaskDuration', value: 0.5},
          {name: 'ScriptDuration', value: 0.25},
        ],
      });
      const map = await captureCpuMetrics(driver as DriverArg);
      assert.isDefined(map);
      assert.equal(map!.get('TaskDuration'), 0.5);
      assert.equal(map!.get('ScriptDuration'), 0.25);
    });

    test('returns undefined when getMetrics yields no metrics array', async () => {
      const driver = fakeCpuDriver({metrics: () => ({})});
      const map = await captureCpuMetrics(driver as DriverArg);
      assert.isUndefined(map);
    });

    test('returns undefined when getMetrics resolves to null (void CDP send)', async () => {
      // Regression: selenium's plain `sendDevToolsCommand` resolves to
      // null/void even for value-returning commands. If CPU capture ever
      // sees a null result it must recover (return undefined for retry),
      // not dereference null and crash.
      const driver = {
        sendAndGetDevToolsCommand: async () => null,
      };
      const map = await captureCpuMetrics(driver as unknown as DriverArg);
      assert.isUndefined(map);
    });

    test('throws on a non-Chromium driver (no sendAndGetDevToolsCommand)', async () => {
      let threw = false;
      try {
        await captureCpuMetrics({} as unknown as DriverArg);
      } catch (e) {
        threw = true;
        assert.match((e as Error).message, /Chromium-based browser/);
      }
      assert.isTrue(threw);
    });
  });

  suite('enableCpuMetrics', () => {
    test('resolves when Performance.enable succeeds', async () => {
      const driver = fakeCpuDriver({enableResult: {}});
      await enableCpuMetrics(driver as DriverArg);
    });

    test('throws a clear error when thread-time is unsupported', async () => {
      const driver = fakeCpuDriver({enableThrows: true});
      let threw = false;
      try {
        await enableCpuMetrics(driver as DriverArg);
      } catch (e) {
        threw = true;
        assert.match((e as Error).message, /Failed to enable CPU measurement/);
      }
      assert.isTrue(threw);
    });

    test('throws on a non-Chromium driver (no sendDevToolsCommand)', async () => {
      let threw = false;
      try {
        await enableCpuMetrics({} as unknown as DriverArg);
      } catch (e) {
        threw = true;
        assert.match((e as Error).message, /Chromium-based browser/);
      }
      assert.isTrue(threw);
    });
  });

  suite('queryForCpu', () => {
    const metric: ResolvedCpuMeasurement = {
      mode: 'cpu',
      metric: 'TaskDuration',
    };

    test('returns (end - baseline) * 1000 ms', async () => {
      const driver = fakeCpuDriver({
        metrics: [{name: 'TaskDuration', value: 0.7}],
      });
      const cache: CpuMetricsCache = {
        baseline: new Map([['TaskDuration', 0.2]]),
      };
      const val = await queryForCpu(driver as DriverArg, metric, cache);
      // (0.7 - 0.2) * 1000 = 500 ms (allow float slop).
      assert.closeTo(val!, 500, 1e-6);
    });

    test('caches the end snapshot across metrics in one attempt', async () => {
      let getMetricsCalls = 0;
      const driver = fakeCpuDriver({
        metrics: () => {
          getMetricsCalls++;
          return [
            {name: 'TaskDuration', value: 1.0},
            {name: 'ScriptDuration', value: 0.4},
          ];
        },
      });
      const cache: CpuMetricsCache = {
        baseline: new Map([
          ['TaskDuration', 0.0],
          ['ScriptDuration', 0.0],
        ]),
      };
      const a = await queryForCpu(driver as DriverArg, metric, cache);
      const b = await queryForCpu(
        driver as DriverArg,
        {mode: 'cpu', metric: 'ScriptDuration'},
        cache
      );
      assert.closeTo(a!, 1000, 1e-6);
      assert.closeTo(b!, 400, 1e-6);
      // getMetrics should only have been issued once; the second row reads
      // from the cached end snapshot.
      assert.equal(getMetricsCalls, 1);
    });

    test('returns undefined when baseline is missing', async () => {
      const driver = fakeCpuDriver({
        metrics: [{name: 'TaskDuration', value: 0.7}],
      });
      const cache: CpuMetricsCache = {};
      const val = await queryForCpu(driver as DriverArg, metric, cache);
      assert.isUndefined(val);
    });

    test('returns undefined when the end snapshot cannot be read', async () => {
      const driver = fakeCpuDriver({metrics: () => undefined});
      const cache: CpuMetricsCache = {
        baseline: new Map([['TaskDuration', 0.2]]),
      };
      const val = await queryForCpu(driver as DriverArg, metric, cache);
      assert.isUndefined(val);
    });

    test('clamps a tiny negative (float-noise) delta to 0', async () => {
      const driver = fakeCpuDriver({
        metrics: [{name: 'TaskDuration', value: 0.2 - 1e-9}],
      });
      const cache: CpuMetricsCache = {
        baseline: new Map([['TaskDuration', 0.2]]),
      };
      const val = await queryForCpu(driver as DriverArg, metric, cache);
      assert.equal(val, 0);
    });

    test('throws when the delta is meaningfully negative (counter reset)', async () => {
      const driver = fakeCpuDriver({
        metrics: [{name: 'TaskDuration', value: 0.1}],
      });
      const cache: CpuMetricsCache = {
        baseline: new Map([['TaskDuration', 0.5]]),
      };
      let threw = false;
      try {
        await queryForCpu(driver as DriverArg, metric, cache);
      } catch (e) {
        threw = true;
        assert.match((e as Error).message, /decreased between baseline and end/);
      }
      assert.isTrue(threw);
    });

    test('throws when the metric is absent from a read snapshot', async () => {
      const driver = fakeCpuDriver({
        metrics: [{name: 'ScriptDuration', value: 0.3}],
      });
      const cache: CpuMetricsCache = {
        baseline: new Map([['TaskDuration', 0.0]]),
      };
      let threw = false;
      try {
        await queryForCpu(driver as DriverArg, metric, cache);
      } catch (e) {
        threw = true;
        assert.match((e as Error).message, /was not present/);
      }
      assert.isTrue(threw);
    });
  });
});
