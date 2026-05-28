/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from 'chai';
import {suite, test} from 'mocha';
import type * as webdriver from 'selenium-webdriver';

import {
  categoryTupleId,
  compileGlob,
  enumerateMemoryDump,
  measurementName,
  probeMemoryCategories,
  queryForMemory,
} from '../measure.js';
import {
  AggregatedMemoryMeasurement,
  ResolvedMemoryMeasurement,
} from '../types.js';

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
  onDump?: () => void;
}): unknown {
  let chunkIndex = 0;
  return {
    sendDevToolsCommand: async (cmd: string) => {
      if (cmd === 'Tracing.requestMemoryDump') {
        opts.onDump?.();
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

const memDump = (
  pid: number,
  dumpId: string,
  allocators: {[k: string]: {[a: string]: string | number}},
  processTotals?: {[a: string]: string}
) => ({
  ph: 'v' as const,
  pid,
  id: dumpId,
  args: {
    dumps: {
      ...(processTotals ? {process_totals: processTotals} : {}),
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

suite('measure', () => {
  suite('measurementName', () => {
    test('resolved memory entry', () => {
      const m: ResolvedMemoryMeasurement = {
        mode: 'memory',
        processRole: 'renderer',
        allocator: 'v8/main/heap',
        attribute: 'size',
      };
      assert.equal(measurementName(m), 'memory:tuple:renderer:v8/main/heap.size');
    });

    test('explicit name wins over auto-derived label', () => {
      const m: ResolvedMemoryMeasurement = {
        mode: 'memory',
        processRole: 'renderer',
        allocator: 'malloc',
        attribute: 'size',
        name: 'my-mem',
      };
      assert.equal(measurementName(m), 'my-mem');
    });

    test('unresolved memory measurement falls back to generic label', () => {
      assert.equal(measurementName({mode: 'memory'}), 'memory');
    });

    test('aggregated memory entry uses memory:sum:<sumAs>', () => {
      const m: AggregatedMemoryMeasurement = {
        mode: 'memory',
        sumAs: 'network-service-size',
        attribute: 'size',
        sources: [
          {
            processRole: 'service: network.mojom.networkservice',
            allocator: 'malloc',
          },
          {
            processRole: 'service: network.mojom.networkservice',
            allocator: 'v8',
          },
        ],
      };
      assert.equal(measurementName(m), 'memory:sum:network-service-size');
    });

    test('aggregated entry ignores MeasurementBase.name', () => {
      // For aggregated entries the user names them via `sumAs`, not
      // `name`, so a stray `name` field should NOT override the
      // memory:sum:<sumAs> label.
      const m: AggregatedMemoryMeasurement = {
        mode: 'memory',
        sumAs: 'net-svc',
        attribute: 'size',
        sources: [],
        name: 'should-be-ignored',
      };
      assert.equal(measurementName(m), 'memory:sum:net-svc');
    });
  });

  suite('compileGlob', () => {
    test('literal pattern matches exactly that tuple', () => {
      const rx = compileGlob('renderer:skia.size');
      assert.isTrue(rx.test('renderer:skia.size'));
      assert.isFalse(rx.test('renderer:skia.effective_size'));
      assert.isFalse(rx.test('renderer:skia/sk_glyph_cache.size'));
      assert.isFalse(rx.test('browser:skia.size'));
    });

    test('asterisk matches any sequence including : / and .', () => {
      const rx = compileGlob('renderer:skia*');
      assert.isTrue(rx.test('renderer:skia.size'));
      assert.isTrue(rx.test('renderer:skia.effective_size'));
      assert.isTrue(rx.test('renderer:skia/sk_glyph_cache.size'));
      assert.isFalse(rx.test('browser:skia.size'));
    });

    test('asterisk in process-role position matches across roles', () => {
      const rx = compileGlob('*:malloc.size');
      assert.isTrue(rx.test('renderer:malloc.size'));
      assert.isTrue(rx.test('browser:malloc.size'));
      assert.isTrue(rx.test('service: network.mojom.networkservice:malloc.size'));
      assert.isFalse(rx.test('renderer:malloc.effective_size'));
      assert.isFalse(rx.test('renderer:malloc/partitions.size'));
    });

    test('regex specials in the pattern are escaped', () => {
      // The user's tuple IDs include `.` and `:` which are regex
      // specials. The glob must escape these so a pattern like
      // `renderer:skia.size` matches exactly that, not e.g.
      // `renderer:skia_size`.
      const rx = compileGlob('renderer:skia.size');
      assert.isFalse(rx.test('renderer:skiaxsize'));
      assert.isFalse(rx.test('renderer:skia_size'));
    });

    test('match is anchored on both ends', () => {
      const rx = compileGlob('renderer:skia.size');
      assert.isFalse(rx.test('xrenderer:skia.size'));
      assert.isFalse(rx.test('renderer:skia.sizex'));
    });
  });

  suite('categoryTupleId', () => {
    test('joins the parts as <role>:<allocator>.<attribute>', () => {
      assert.equal(
        categoryTupleId({
          processRole: 'renderer',
          allocator: 'v8/main/heap',
          attribute: 'size',
        }),
        'renderer:v8/main/heap.size'
      );
    });
  });

  suite('enumerateMemoryDump', () => {
    test('extracts every (role, allocator, attribute) tuple', () => {
      const events = [
        processNameEvent(1, 'Renderer'),
        processNameEvent(2, 'Browser'),
        memDump(
          1,
          'g',
          {
            'v8/main/heap': {size: '10', effective_size: '20'},
            malloc: {size: '30'},
          },
          {resident_set_bytes: '40'}
        ),
        memDump(2, 'g', {malloc: {size: '50'}}),
      ];
      const tuples = enumerateMemoryDump(events);
      assert.deepEqual(tuples, [
        {processRole: 'browser', allocator: 'malloc', attribute: 'size'},
        {processRole: 'renderer', allocator: 'malloc', attribute: 'size'},
        {
          processRole: 'renderer',
          allocator: 'process_totals',
          attribute: 'resident_set_bytes',
        },
        {
          processRole: 'renderer',
          allocator: 'v8/main/heap',
          attribute: 'effective_size',
        },
        {
          processRole: 'renderer',
          allocator: 'v8/main/heap',
          attribute: 'size',
        },
      ]);
    });

    test('drops noisy non-byte attributes (counters, flags, rates)', () => {
      // Memory-infra emits dozens of non-byte attrs per allocator
      // (object_count, alloc_count, fragmentation, brp_pool_usage,
      // is_peak_rss_resettable, syscalls_per_minute, ...). The
      // enumerator keeps only the bytes-focused subset
      // (size, effective_size, plus the process_totals RSS-style
      // attributes) so the result table is a memory result table and
      // not a noise dump.
      const events = [
        processNameEvent(1, 'Renderer'),
        memDump(
          1,
          'g',
          {
            'v8/main/heap': {
              size: '100',
              effective_size: '90',
              allocated_objects_size: '50',
              object_count: '5',
              alloc_count: '7',
              fragmentation: '1',
              is_prepaint: '0',
            },
            cc: {
              size: '20',
              memory_policy: 'ALLOW_PREPAINT_ONLY',
              syscalls_per_minute: '3',
            },
          },
          {
            resident_set_bytes: '40',
            peak_resident_set_size: '50',
            private_footprint_bytes: '60',
            is_peak_rss_resettable: '1',
            soft_memory_limit: '999',
          }
        ),
      ];
      const tuples = enumerateMemoryDump(events);
      assert.deepEqual(tuples, [
        {processRole: 'renderer', allocator: 'cc', attribute: 'size'},
        {
          processRole: 'renderer',
          allocator: 'process_totals',
          attribute: 'peak_resident_set_size',
        },
        {
          processRole: 'renderer',
          allocator: 'process_totals',
          attribute: 'private_footprint_bytes',
        },
        {
          processRole: 'renderer',
          allocator: 'process_totals',
          attribute: 'resident_set_bytes',
        },
        {
          processRole: 'renderer',
          allocator: 'v8/main/heap',
          attribute: 'effective_size',
        },
        {
          processRole: 'renderer',
          allocator: 'v8/main/heap',
          attribute: 'size',
        },
      ]);
    });

    test('drops dumps with no role metadata', () => {
      const events = [
        // No process_name event for pid 99; its dump must not contribute
        // to the enumerated tuple set.
        memDump(99, 'g', {malloc: {size: '10'}}),
      ];
      assert.deepEqual(enumerateMemoryDump(events), []);
    });

    test('respects maxAllocatorDepth', () => {
      // `malloc` is depth 1, `malloc/partitions` is depth 2,
      // `malloc/partitions/allocator/buckets/bucket_0000016` is depth 5.
      // With maxAllocatorDepth = 2 we keep depths 1-2 and drop deeper
      // ones - the parent's roll-up row is still there.
      const events = [
        processNameEvent(1, 'Renderer'),
        memDump(1, 'g', {
          malloc: {size: '100'},
          'malloc/partitions': {size: '90'},
          'malloc/partitions/allocator': {size: '80'},
          'malloc/partitions/allocator/buckets/bucket_0000016': {size: '5'},
          'malloc/partitions/allocator/buckets/bucket_0000032': {size: '7'},
        }),
      ];
      const tuples = enumerateMemoryDump(events, {maxAllocatorDepth: 2});
      assert.deepEqual(tuples, [
        {processRole: 'renderer', allocator: 'malloc', attribute: 'size'},
        {
          processRole: 'renderer',
          allocator: 'malloc/partitions',
          attribute: 'size',
        },
      ]);
    });

    test('deduplicates tuples across multiple processes with the same role', () => {
      const events = [
        processNameEvent(10, 'Renderer'),
        processNameEvent(11, 'Renderer'),
        memDump(10, 'g', {malloc: {size: '1'}}),
        memDump(11, 'g', {malloc: {size: '2'}}),
      ];
      assert.deepEqual(enumerateMemoryDump(events), [
        {processRole: 'renderer', allocator: 'malloc', attribute: 'size'},
      ]);
    });

    test('skips non-numeric attribute values', () => {
      // Real Chromium dumps include attrs like
      // `cc/tile_manager_*.memory_policy = "ALLOW_PREPAINT_ONLY"`.
      // These are not comparable scalars and would crash the extraction
      // path's hex parser - enumeration must filter them out.
      const events = [
        processNameEvent(1, 'Renderer'),
        memDump(1, 'g', {
          cc: {
            size: '100',
            memory_policy: 'ALLOW_PREPAINT_ONLY',
          },
        }),
      ];
      const tuples = enumerateMemoryDump(events);
      assert.deepEqual(tuples, [
        {processRole: 'renderer', allocator: 'cc', attribute: 'size'},
      ]);
    });

    test('skips per-instance allocator names with `_0x<hex>` and UUID suffixes', () => {
      // Per-object dumps like `gpu/discardable_cache/cache_0x7fff12345`
      // embed the providing object's address; the address changes between
      // samples so the tuple cannot be tracked across the run. The
      // aggregate parent dump (no `_0x` suffix) is the comparable one.
      // Likewise for colon-separated UUID-like resource identifiers
      // (`mailbox_00:4F:65:5D:...`), 32-char hex UUIDs
      // (`shared_memory/<UUID>`), and Blink mangled type IDs
      // (`__<16hex>`).
      const events = [
        processNameEvent(1, 'Renderer'),
        memDump(1, 'g', {
          'gpu/discardable_cache/cache': {size: '100'},
          'gpu/discardable_cache/cache_0x7fff12345abc': {size: '50'},
          'gpu/shared_images/client_0x1': {size: '25'},
          'media/webmediaplayer/player_0x12abcd34': {size: '10'},
          'gpu/shared_images/client_0x1/mailbox_00:4F:65:5D:FE:DD:46:8C':
            {size: '7'},
          'shared_memory/001428541A9D22AAAB91F7EC8E552D81': {size: '8'},
          'blink_gc/main/allocated_objects': {size: '500'},
          'blink_gc/main/allocated_objects/__1007c21d112fe171': {size: '3'},
        }),
      ];
      const tuples = enumerateMemoryDump(events);
      assert.deepEqual(tuples, [
        {
          processRole: 'renderer',
          allocator: 'blink_gc/main/allocated_objects',
          attribute: 'size',
        },
        {
          processRole: 'renderer',
          allocator: 'gpu/discardable_cache/cache',
          attribute: 'size',
        },
      ]);
    });
  });

  suite('probeMemoryCategories', () => {
    test('drains until quiet so all process dumps are captured', async () => {
      // First chunk after the dump request contains the renderer dump only.
      // A later chunk delivers the browser dump. probeMemoryCategories
      // must keep draining until the log is quiet so both roles end up in
      // the enumerated tuple set.
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [
          // Pre-dump drain
          [],
          // Right after dump - only renderer arrives
          [
            logEntry(processNameEvent(1, 'Renderer')),
            logEntry(memDump(1, 'g', {malloc: {size: '1'}})),
          ],
          // Browser dump comes a bit later
          [
            logEntry(processNameEvent(2, 'Browser')),
            logEntry(memDump(2, 'g', {malloc: {size: '2'}})),
          ],
          // Quiet drains follow
          [],
          [],
          [],
        ],
      });
      const tuples = await probeMemoryCategories(
        driver as Parameters<typeof probeMemoryCategories>[0],
        {mode: 'memory', gcBefore: false},
        {timeoutMs: 5000}
      );
      assert.isDefined(tuples);
      // Both renderer and browser roles should be present.
      const roles = new Set(tuples!.map((t) => t.processRole));
      assert.deepEqual([...roles].sort(), ['browser', 'renderer']);
    });

    test('returns undefined when no dump arrives in time', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [[], [], []],
      });
      const tuples = await probeMemoryCategories(
        driver as Parameters<typeof probeMemoryCategories>[0],
        {mode: 'memory', gcBefore: false},
        {timeoutMs: 50}
      );
      assert.isUndefined(tuples);
    });
  });

  suite('queryForMemory', () => {
    test('extracts metric for the resolved process role', async () => {
      const driver = fakeDriver({
        dumpGuid: 'abc123',
        logChunks: [
          [],
          [
            logEntry(processNameEvent(101, 'Renderer')),
            logEntry(processNameEvent(102, 'Browser')),
            logEntry(memDump(101, 'abc123', {'v8/main/heap': {size: '1000'}})),
            logEntry(memDump(102, 'abc123', {'v8/main/heap': {size: 'ff'}})),
          ],
          [],
        ],
      });
      const m: ResolvedMemoryMeasurement = {
        mode: 'memory',
        processRole: 'renderer',
        allocator: 'v8/main/heap',
        attribute: 'size',
        gcBefore: false,
      };
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        m
      );
      // Only the renderer dump should be summed: 0x1000 = 4096.
      assert.equal(val, 0x1000);
    });

    test('sums values across multiple processes with the same role', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [
          [],
          [
            logEntry(processNameEvent(1, 'Renderer')),
            logEntry(processNameEvent(2, 'Renderer')),
            logEntry(memDump(1, 'g', {malloc: {size: '10'}})),
            logEntry(memDump(2, 'g', {malloc: {size: '20'}})),
          ],
          [],
        ],
      });
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'malloc',
          attribute: 'size',
          gcBefore: false,
        }
      );
      // 0x10 + 0x20 = 0x30
      assert.equal(val, 0x10 + 0x20);
    });

    test('reads process_totals attribute', async () => {
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
          processRole: 'renderer',
          allocator: 'process_totals',
          attribute: 'resident_set_bytes',
          gcBefore: false,
        }
      );
      assert.equal(val, 0x2000);
    });

    test('returns 0 when process role is present but allocator is absent', async () => {
      // Renderer dump is present, but it does not include the requested
      // `nonexistent` allocator. Auto-discovery treats that as a true zero
      // rather than throwing, so the retry loop does not spin forever.
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
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'nonexistent',
          attribute: 'size',
          gcBefore: false,
        }
      );
      assert.equal(val, 0);
    });

    test('treats non-numeric attribute values as 0 instead of throwing', async () => {
      // If a later sample reports a string-typed value where an earlier
      // sample reported a number (or for an attribute that was always
      // string), extraction must not crash the whole benchmark. Treat
      // the value as 0 (the same as "allocator absent") so the run can
      // finish and the result column still aligns.
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [
          [],
          [
            logEntry(processNameEvent(1, 'Renderer')),
            logEntry(
              memDump(1, 'g', {
                cc: {memory_policy: 'ALLOW_PREPAINT_ONLY'},
              })
            ),
          ],
          [],
        ],
      });
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'cc',
          attribute: 'memory_policy',
          gcBefore: false,
        }
      );
      assert.equal(val, 0);
    });

    test('returns 0 when the requested process role is missing from an otherwise-valid dump', async () => {
      // No 'gpu process' role event arrived in this sample even though the
      // dump did arrive (we got the renderer's dump). The role is gone
      // for this sample - common for Chromium's transient utility services
      // like `service: quarantine.mojom.quarantine` that spawn for a
      // single task and shut down. Retrying the page wouldn't bring them
      // back; treat the tuple as 0 so the run can finish. (Genuine
      // "dump never arrived" cases still return `undefined` via the
      // separate test below.)
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
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {
          mode: 'memory',
          processRole: 'gpu process',
          allocator: 'malloc',
          attribute: 'size',
          gcBefore: false,
        }
      );
      assert.equal(val, 0);
    });

    test('returns undefined when no dumps received', async () => {
      const driver = fakeDriver({
        dumpGuid: 'g',
        logChunks: [[], []],
      });
      const val = await queryForMemory(
        driver as Parameters<typeof queryForMemory>[0],
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'malloc',
          attribute: 'size',
          gcBefore: false,
        },
        {timeoutMs: 50}
      );
      assert.isUndefined(val);
    });

    test('returns undefined when Tracing.requestMemoryDump hangs (watchdog)', async () => {
      // Some chromedriver hangs manifest as `sendDevToolsCommand` never
      // resolving. Without a watchdog the whole benchmark stalls; with
      // it, we bail this attempt and the per-attempt retry loop in
      // `takeSamples` reloads the page.
      const driver = {
        sendDevToolsCommand: async (cmd: string) => {
          if (cmd === 'Tracing.requestMemoryDump') {
            // Intentionally never resolves.
            return new Promise(() => {
              /* hang forever */
            });
          }
          return undefined;
        },
        manage() {
          return {
            logs() {
              return {
                get: async () => [],
              };
            },
          };
        },
      };
      const val = await queryForMemory(
        driver as unknown as Parameters<typeof queryForMemory>[0],
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'malloc',
          attribute: 'size',
          gcBefore: false,
        },
        // Short `devtoolsTimeoutMs` so this test doesn't itself hang.
        // In production this defaults to a 10 s watchdog.
        {timeoutMs: 50, devtoolsTimeoutMs: 50}
      );
      assert.isUndefined(val);
    });

    test('issues only one dump request even when polling internally', async () => {
      // Even when the dump events take several poll intervals to arrive,
      // we should only request one dump per queryForMemory call.
      let dumpRequests = 0;
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
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'malloc',
          attribute: 'size',
          gcBefore: false,
        },
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
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'malloc',
          attribute: 'size',
          gcBefore: false,
        },
        {consumedPerfLog}
      );
      assert.equal(val, 0x5);
      // Two entries should have been forwarded: the process_name event and
      // the memory dump event.
      assert.equal(consumedPerfLog.length, 2);
    });

    test('memoryDumpCache shares one dump across multiple metrics', async () => {
      // Two queryForMemory calls (one for v8, one for malloc) with the
      // same cache object should only fire ONE dump request and read
      // both metrics out of the same captured events.
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
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'malloc',
          attribute: 'size',
          gcBefore: false,
        },
        {memoryDumpCache: cache, timeoutMs: 2000}
      );
      const v2 = await queryForMemory(
        driver as unknown as Parameters<typeof queryForMemory>[0],
        {
          mode: 'memory',
          processRole: 'renderer',
          allocator: 'v8/main/heap',
          attribute: 'size',
          gcBefore: false,
        },
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
          {
            mode: 'memory',
            processRole: 'renderer',
            allocator: 'malloc',
            attribute: 'size',
          }
        );
      } catch (e) {
        err = e as Error;
      }
      assert.isDefined(err);
      assert.match(err!.message, /Chromium/);
    });

    suite('aggregated', () => {
      test('sums one attribute across multiple (role, allocator) sources', async () => {
        const driver = fakeDriver({
          dumpGuid: 'g',
          logChunks: [
            [],
            [
              logEntry(processNameEvent(1, 'Renderer')),
              logEntry(processNameEvent(2, 'Browser')),
              logEntry(processNameEvent(3, 'GPU Process')),
              logEntry(
                memDump(1, 'g', {malloc: {size: '100'}, v8: {size: '200'}})
              ),
              logEntry(memDump(2, 'g', {malloc: {size: '50'}})),
              logEntry(memDump(3, 'g', {malloc: {size: '7'}})),
            ],
            [],
          ],
        });
        const m: AggregatedMemoryMeasurement = {
          mode: 'memory',
          sumAs: 'malloc-total',
          attribute: 'size',
          sources: [
            {processRole: 'renderer', allocator: 'malloc'},
            {processRole: 'browser', allocator: 'malloc'},
            {processRole: 'gpu process', allocator: 'malloc'},
          ],
          gcBefore: false,
        };
        const val = await queryForMemory(
          driver as Parameters<typeof queryForMemory>[0],
          m
        );
        assert.equal(val, 0x100 + 0x50 + 0x7);
      });

      test('treats missing process roles as 0 contribution (bug-6 policy)', async () => {
        // Source 2 (`gpu process`) is gone from this sample. Its
        // contribution to the sum is 0, not "retry the whole page".
        const driver = fakeDriver({
          dumpGuid: 'g',
          logChunks: [
            [],
            [
              logEntry(processNameEvent(1, 'Renderer')),
              logEntry(memDump(1, 'g', {malloc: {size: '100'}})),
            ],
            [],
          ],
        });
        const m: AggregatedMemoryMeasurement = {
          mode: 'memory',
          sumAs: 'malloc-total',
          attribute: 'size',
          sources: [
            {processRole: 'renderer', allocator: 'malloc'},
            {processRole: 'gpu process', allocator: 'malloc'},
          ],
          gcBefore: false,
        };
        const val = await queryForMemory(
          driver as Parameters<typeof queryForMemory>[0],
          m
        );
        assert.equal(val, 0x100);
      });

      test('treats missing allocator within a present role as 0 contribution', async () => {
        const driver = fakeDriver({
          dumpGuid: 'g',
          logChunks: [
            [],
            [
              logEntry(processNameEvent(1, 'Renderer')),
              logEntry(memDump(1, 'g', {malloc: {size: '100'}})),
            ],
            [],
          ],
        });
        const m: AggregatedMemoryMeasurement = {
          mode: 'memory',
          sumAs: 'mixed',
          attribute: 'size',
          sources: [
            {processRole: 'renderer', allocator: 'malloc'},
            {processRole: 'renderer', allocator: 'nonexistent'},
          ],
          gcBefore: false,
        };
        const val = await queryForMemory(
          driver as Parameters<typeof queryForMemory>[0],
          m
        );
        assert.equal(val, 0x100);
      });

      test('returns undefined when the dump itself does not arrive', async () => {
        const driver = fakeDriver({
          dumpGuid: 'g',
          logChunks: [[], []],
        });
        const m: AggregatedMemoryMeasurement = {
          mode: 'memory',
          sumAs: 'malloc-total',
          attribute: 'size',
          sources: [{processRole: 'renderer', allocator: 'malloc'}],
          gcBefore: false,
        };
        const val = await queryForMemory(
          driver as Parameters<typeof queryForMemory>[0],
          m,
          {timeoutMs: 50}
        );
        assert.isUndefined(val);
      });
    });
  });
});
