/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from 'chai';
import {suite, test} from 'mocha';
import type * as webdriver from 'selenium-webdriver';

import {measurementName, queryForMemory} from '../measure.js';
import {MemoryMeasurement} from '../types.js';

/**
 * Build a fake selenium `performance` log entry containing a single trace
 * event payload, in the same format as Chromium's `Tracing.dataCollected`.
 */
function logEntry(params: unknown): {message: string} {
  return {
    message: JSON.stringify({
      message: {method: 'Tracing.dataCollected', params},
    }),
  };
}

/**
 * Build a minimal fake WebDriver that:
 *   - supports `sendDevToolsCommand('Tracing.requestMemoryDump', ...)`
 *   - returns the supplied trace entries from `driver.manage().logs().get()`
 */
function fakeDriver(opts: {
  dumpGuid?: string;
  logChunks: Array<Array<{message: string}>>;
}): unknown {
  let chunkIndex = 0;
  return {
    sendDevToolsCommand: async (cmd: string) => {
      if (cmd === 'Tracing.requestMemoryDump') {
        return {dumpGuid: opts.dumpGuid, success: true};
      }
      return undefined;
    },
    manage() {
      return {
        logs() {
          return {
            get: async () => {
              if (chunkIndex >= opts.logChunks.length) {
                return [];
              }
              return opts.logChunks[chunkIndex++];
            },
          };
        },
      };
    },
  };
}

suite('measure', () => {
  suite('measurementName', () => {
    test('memory metric', () => {
      assert.equal(
        measurementName({mode: 'memory', metric: 'v8/main/heap.size'}),
        'memory:v8/main/heap.size'
      );
    });
    test('memory with explicit name', () => {
      assert.equal(
        measurementName({
          mode: 'memory',
          metric: 'malloc.size',
          name: 'my-mem',
        }),
        'my-mem'
      );
    });
  });

  suite('queryForMemory', () => {
    const memDump = (
      pid: number,
      dumpId: string,
      allocators: {[k: string]: {[a: string]: string | number}}
    ) => ({
      ph: 'v' as const,
      pid,
      id: dumpId,
      args: {
        dumps: {
          allocators: Object.fromEntries(
            Object.entries(allocators).map(([name, attrs]) => [
              name,
              {
                attrs: Object.fromEntries(
                  Object.entries(attrs).map(([k, v]) => [k, {value: v}])
                ),
              },
            ])
          ),
        },
      },
    });

    const processNameEvent = (pid: number, name: string) => ({
      ph: 'M' as const,
      pid,
      name: 'process_name',
      args: {name},
    });

    test('extracts metric from renderer dump (hex value)', async () => {
      const driver = fakeDriver({
        dumpGuid: 'abc123',
        logChunks: [
          // First drainPerformanceLog (before dump): empty.
          [],
          // Second drainPerformanceLog (after dump): the dump events.
          [
            logEntry(processNameEvent(101, 'Renderer')),
            logEntry(processNameEvent(102, 'Browser')),
            logEntry(memDump(101, 'abc123', {'v8/main/heap': {size: '1000'}})),
            logEntry(memDump(102, 'abc123', {'v8/main/heap': {size: 'ff'}})),
          ],
          [],
        ],
      });
      const m: MemoryMeasurement = {
        mode: 'memory',
        metric: 'v8/main/heap.size',
        gcBefore: false,
      };
      // 0x1000 = 4096 (renderer pid 101 should win for default process=renderer)
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        m
      );
      assert.equal(val, 0x1000);
    });

    test('extracts metric as numeric value', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [
          [],
          [
            logEntry(processNameEvent(50, 'Renderer')),
            logEntry(memDump(50, 'g', {malloc: {size: 12345}})),
          ],
          [],
        ],
      });
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {mode: 'memory', metric: 'malloc.size', gcBefore: false}
      );
      assert.equal(val, 12345);
    });

    test('process: all sums across processes', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [
          [],
          [
            logEntry(processNameEvent(1, 'Renderer')),
            logEntry(processNameEvent(2, 'Browser')),
            logEntry(memDump(1, 'g', {malloc: {size: '10'}})),
            logEntry(memDump(2, 'g', {malloc: {size: '20'}})),
          ],
          [],
        ],
      });
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {mode: 'memory', metric: 'malloc.size', process: 'all', gcBefore: false}
      );
      // 0x10 + 0x20 = 48
      assert.equal(val, 0x10 + 0x20);
    });

    test('process_totals path', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [
          [],
          [
            logEntry(processNameEvent(1, 'Renderer')),
            logEntry({
              ph: 'v',
              pid: 1,
              id: 'g',
              args: {dumps: {process_totals: {resident_set_bytes: '2000'}}},
            }),
          ],
          [],
        ],
      });
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {
          mode: 'memory',
          metric: 'process_totals.resident_set_bytes',
          gcBefore: false,
        }
      );
      assert.equal(val, 0x2000);
    });

    test('throws when metric not present', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [
          [],
          [
            logEntry(processNameEvent(1, 'Renderer')),
            logEntry(memDump(1, 'g', {malloc: {size: '10'}})),
          ],
          [],
        ],
      });
      let err: Error | undefined;
      try {
        await queryForMemory(driver as Parameters<typeof queryForMemory>[0], {
          mode: 'memory',
          metric: 'nonexistent.size',
          gcBefore: false,
        });
      } catch (e) {
        err = e as Error;
      }
      assert.isDefined(err);
      assert.match(err!.message, /Available top-level allocators: malloc/);
    });

    test('returns undefined when no dumps received', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [[], []],
      });
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {mode: 'memory', metric: 'malloc.size', gcBefore: false},
        {timeoutMs: 50}
      );
      assert.isUndefined(val);
    });

    test('issues only one dump request even when polling internally', async () => {
      // Count how many times Tracing.requestMemoryDump is dispatched. Even
      // when the dump events take several poll intervals to arrive, we should
      // only request one dump per queryForMemory call.
      let dumpRequests = 0;
      // First two `get()` calls return empty (simulating the dump taking
      // ~200ms to appear in the performance log), then the dump events
      // arrive, then the post-find drain returns empty.
      const chunks: Array<Array<{message: string}>> = [
        [],
        [],
        [
          logEntry(processNameEvent(1, 'Renderer')),
          logEntry(memDump(1, 'g', {malloc: {size: '7'}})),
        ],
        [],
      ];
      let chunkIndex = 0;
      const driver = {
        sendDevToolsCommand: async (cmd: string) => {
          if (cmd === 'Tracing.requestMemoryDump') {
            dumpRequests++;
            return {dumpGuid: 'g', success: true};
          }
          return undefined;
        },
        manage() {
          return {
            logs() {
              return {
                get: async () => {
                  if (chunkIndex >= chunks.length) return [];
                  return chunks[chunkIndex++];
                },
              };
            },
          };
        },
      };
      const val = await queryForMemory(
        driver as unknown as Parameters<typeof queryForMemory>[0],
        {mode: 'memory', metric: 'malloc.size', gcBefore: false},
        {timeoutMs: 2000}
      );
      assert.equal(val, 0x7);
      assert.equal(dumpRequests, 1);
    });

    test('forwards consumed performance log entries to the accumulator', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [
          [],
          [
            logEntry(processNameEvent(1, 'Renderer')),
            logEntry(memDump(1, 'g', {malloc: {size: '5'}})),
          ],
          [],
        ],
      });
      const consumedPerfLog: webdriver.logging.Entry[] = [];
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {mode: 'memory', metric: 'malloc.size', gcBefore: false},
        {consumedPerfLog}
      );
      assert.equal(val, 0x5);
      // Two entries should have been forwarded: the process_name event and
      // the memory dump event.
      assert.equal(consumedPerfLog.length, 2);
    });

    test('memoryDumpCache shares one dump across multiple metrics', async () => {
      // Count how many times Tracing.requestMemoryDump is dispatched. With
      // a shared cache, two queryForMemory calls (one for v8, one for
      // malloc) should only fire ONE dump request and read both metrics
      // out of the same captured events.
      let dumpRequests = 0;
      const chunks: Array<Array<{message: string}>> = [
        [],
        [
          logEntry(processNameEvent(1, 'Renderer')),
          logEntry(
            memDump(1, 'g', {
              malloc: {size: 'a'},
              'v8/main/heap': {size: 'b'},
            })
          ),
        ],
        [],
      ];
      let chunkIndex = 0;
      const driver = {
        sendDevToolsCommand: async (cmd: string) => {
          if (cmd === 'Tracing.requestMemoryDump') {
            dumpRequests++;
            return {dumpGuid: 'g', success: true};
          }
          return undefined;
        },
        manage() {
          return {
            logs() {
              return {
                get: async () => {
                  if (chunkIndex >= chunks.length) return [];
                  return chunks[chunkIndex++];
                },
              };
            },
          };
        },
      };
      const cache = {};
      const v1 = await queryForMemory(
        driver as unknown as Parameters<typeof queryForMemory>[0],
        {mode: 'memory', metric: 'malloc.size', gcBefore: false},
        {memoryDumpCache: cache, timeoutMs: 2000}
      );
      const v2 = await queryForMemory(
        driver as unknown as Parameters<typeof queryForMemory>[0],
        {mode: 'memory', metric: 'v8/main/heap.size', gcBefore: false},
        {memoryDumpCache: cache, timeoutMs: 2000}
      );
      assert.equal(v1, 0xa);
      assert.equal(v2, 0xb);
      assert.equal(dumpRequests, 1, 'should fire only one dump request');
    });

    test('throws on non-Chromium driver', async () => {
      const driver = {
        manage() {
          return {logs: () => ({get: async () => []})};
        },
      };
      let err: Error | undefined;
      try {
        await queryForMemory(
          driver as unknown as Parameters<typeof queryForMemory>[0],
          {mode: 'memory', metric: 'malloc.size'}
        );
      } catch (e) {
        err = e as Error;
      }
      assert.isDefined(err);
      assert.match(err!.message, /Chromium/);
    });
  });
});
