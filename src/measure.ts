/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as webdriver from 'selenium-webdriver';

import * as defaults from './defaults.js';
import {Server} from './server.js';
import {
  AggregatedMemoryMeasurement,
  isAggregatedMemoryMeasurement,
  isReadyMemoryMeasurement,
  isResolvedMemoryMeasurement,
  MemoryMeasurement,
  PerformanceEntryMeasurement,
  ResolvedMemoryMeasurement,
  RuntimeMeasurement,
} from './types.js';
import {throwUnreachable} from './util.js';

/**
 * Try to take a measurement in milliseconds from the given browser. Returns
 * undefined if the measurement is not available (which may just mean we need to
 * wait some more time).
 *
 * `consumedPerfLog`, when supplied, is appended to with any `performance`
 * channel log entries that this call consumed (currently only memory
 * measurements drain the performance log). This lets a caller that also wants
 * to write a `--trace` file see the entries that would otherwise be lost.
 *
 * `memoryDumpCache`, when supplied, is shared across calls so that multiple
 * memory measurements on the same page only fire one
 * `Tracing.requestMemoryDump` per sample (one dump contains every
 * allocator's stats, so we extract each metric from the same events).
 */
export async function measure(
  driver: webdriver.WebDriver,
  measurement: RuntimeMeasurement,
  server: Server | undefined,
  consumedPerfLog?: webdriver.logging.Entry[],
  memoryDumpCache?: MemoryDumpCache
): Promise<number | undefined> {
  switch (measurement.mode) {
    case 'callback':
      if (server === undefined) {
        throw new Error('Internal error: no server for spec');
      }
      return (await server.nextResults()).millis;
    case 'expression':
      return queryForExpression(driver, measurement.expression);
    case 'performance':
      return queryForPerformanceEntry(driver, measurement);
    case 'memory':
      if (!isReadyMemoryMeasurement(measurement)) {
        throw new Error(
          'Internal error: unresolved memory measurement reached `measure()`. ' +
            'All `mode:"memory"` measurements must be expanded into ' +
            '`ResolvedMemoryMeasurement` or `AggregatedMemoryMeasurement` ' +
            'entries by the probe phase before sampling begins.'
        );
      }
      return queryForMemory(driver, measurement, {
        consumedPerfLog,
        memoryDumpCache,
      });
  }
  throwUnreachable(
    measurement,
    `Internal error: unknown measurement type ` + JSON.stringify(measurement)
  );
}

/**
 * https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEntry
 *
 * Note a more complete interface for this is defined in the standard
 * lib.dom.d.ts, but we don't want to depend on that since it would make all
 * DOM types ambiently defined.
 */
interface PerformanceEntry {
  entryType:
    | 'frame'
    | 'navigation'
    | 'resource'
    | 'mark'
    | 'measure'
    | 'paint'
    | 'longtask';
  name: string;
  startTime: number;
  duration: number;
}

/**
 * Query the browser for the Performance Entry matching the given criteria.
 * Returns undefined if no matching entry is found. Throws if the performance
 * entry has an unsupported type. If there are multiple entries matching the
 * same criteria, returns only the first one.
 */
async function queryForPerformanceEntry(
  driver: webdriver.WebDriver,
  measurement: PerformanceEntryMeasurement
): Promise<number | undefined> {
  const escaped = escapeStringLiteral(measurement.entryName);
  const script = `return window.performance.getEntriesByName(\`${escaped}\`);`;
  const entries = (await driver.executeScript(script)) as PerformanceEntry[];
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length > 1) {
    console.log(
      'WARNING: Found multiple performance marks/measurements with name ' +
        `"${measurement.entryName}". This likely indicates an error. ` +
        'Picking the first one.'
    );
  }
  const entry = entries[0];
  switch (entry.entryType) {
    case 'measure':
      return entry.duration;
    case 'mark':
    case 'paint':
      return entry.startTime;
    default:
      // We may want to support other entry types, but we'll need to investigate
      // how to interpret them, and we may need additional criteria to decide
      // which exact numbers to report from them.
      throw new Error(
        `Performance entry type not supported: ${entry.entryType}`
      );
  }
}

/**
 * Execute the given expression in the browser and return the result, if it is a
 * positive number. If null or undefined, returns undefined. If some other type,
 * throws.
 */
async function queryForExpression(
  driver: webdriver.WebDriver,
  expression: string
): Promise<number | undefined> {
  const result = (await driver.executeScript(
    `return (${expression});`
  )) as unknown;
  if (result !== undefined && result !== null) {
    if (typeof result !== 'number') {
      throw new Error(
        `'${expression}' was type ` + `${typeof result}, expected number.`
      );
    }
    if (result < 0) {
      throw new Error(`'${expression}' was negative: ${result}`);
    }
    return result;
  }
}

/**
 * Escape a string such that it can be safely embedded in a JavaScript template
 * literal (backtick string).
 */
function escapeStringLiteral(unescaped: string): string {
  return unescaped
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

// ----- Memory measurement (Chromium memory-infra) ---------------------------

/**
 * Shape of an entry returned by the Selenium `performance` log channel.
 * Each entry's `message` is a JSON string containing a CDP-style message.
 */
interface CdpLogMessage {
  message: {
    method: string;
    params: {
      // For Tracing.dataCollected this is a single trace event.
      // Shape varies based on event phase ('ph').
      [key: string]: unknown;
    };
  };
}

/**
 * Subset of a memory dump trace event (phase 'v' or 'V').
 */
interface MemoryDumpEvent {
  ph: 'v' | 'V';
  pid: number;
  id?: string;
  // Chromium puts the dump GUID under different keys across versions.
  dump_guid?: string;
  args: {
    dumps?: {
      process_totals?: {[attr: string]: string};
      allocators?: {
        [path: string]: {
          attrs?: {
            [attr: string]: {value: string | number; units?: string};
          };
        };
      };
    };
    name?: string;
  };
  name?: string;
  cat?: string;
}

/**
 * Process metadata event ('M' phase, name 'process_name') used to identify
 * which pid corresponds to the renderer/browser/gpu/etc.
 */
interface ProcessMetadataEvent {
  ph: 'M';
  pid: number;
  name: string; // e.g. 'process_name'
  args: {name?: string; [key: string]: unknown};
}

interface WebDriverWithSendDevToolsCommand {
  sendDevToolsCommand?: (command: string, params: unknown) => Promise<unknown>;
}

/**
 * Parse a number that may be reported as a hex string (the convention used
 * for memory-infra `size`-style attributes) or as a plain number.
 *
 * Memory-infra also reports non-numeric *string-typed* attributes alongside
 * size-typed ones (e.g. `cc/tile_manager_*.memory_policy = "ALLOW_PREPAINT_ONLY"`).
 * Auto-discovery enumerates every attribute key it sees, so the extraction
 * path will be asked to parse those too. Rather than crashing the whole
 * benchmark when the first non-numeric attribute is hit, return `undefined`
 * so the caller can skip the tuple. The enumeration helper applies the
 * same parser to filter non-numeric attributes out of the discovered set
 * up front.
 */
function parseMaybeHex(value: string | number): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  // Chromium reports size attributes as lowercase hex with no `0x` prefix.
  const n = /^[0-9a-fA-F]+$/.test(value) ? parseInt(value, 16) : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build a map from pid -> Chromium process role based on the metadata events
 * in the trace log.
 */
function pidProcessRoles(
  events: Array<MemoryDumpEvent | ProcessMetadataEvent>
): Map<number, string> {
  const roles = new Map<number, string>();
  for (const ev of events) {
    if (ev.ph === 'M' && ev.name === 'process_name') {
      const role = (ev as ProcessMetadataEvent).args.name;
      if (typeof role === 'string') {
        roles.set(ev.pid, role.toLowerCase());
      }
    }
  }
  return roles;
}

/**
 * Normalise a Chromium-reported `process_name` to the role-string form
 * used as a stable key in {@link ResolvedMemoryMeasurement}. Currently
 * just lowercases the string; this is centralised so the probe phase and
 * the extraction code agree on the exact key.
 */
export function normaliseProcessRole(name: string): string {
  return name.toLowerCase();
}

function isRoleMatch(desiredRole: string, role: string | undefined): boolean {
  return role !== undefined && role === desiredRole;
}

/**
 * Read a value out of one memory dump event by allocator + attribute.
 * Returns `undefined` if this dump doesn't contain the path.
 */
function readAttribute(
  event: MemoryDumpEvent,
  allocator: string,
  attribute: string
): number | undefined {
  const dumps = event.args && event.args.dumps;
  if (dumps === undefined) {
    return undefined;
  }
  if (allocator === 'process_totals') {
    const v = dumps.process_totals?.[attribute];
    return v === undefined ? undefined : parseMaybeHex(v);
  }
  const a = dumps.allocators?.[allocator];
  if (a === undefined) {
    return undefined;
  }
  const attrEntry = a.attrs?.[attribute];
  if (attrEntry === undefined) {
    return undefined;
  }
  return parseMaybeHex(attrEntry.value);
}

/**
 * One discovered `(processRole, allocator, attribute)` tuple from a
 * captured memory dump. Returned by {@link enumerateMemoryDump} and used
 * by the runner's probe phase to synthesise
 * {@link ResolvedMemoryMeasurement} entries.
 */
export interface MemoryDumpCategory {
  processRole: string;
  allocator: string;
  attribute: string;
}

/**
 * Returns true if any segment of an allocator path looks like a
 * per-instance identifier whose value isn't stable across samples
 * (pointer address, UUID, mangled type hash) - i.e. the tuple cannot be
 * tracked across the run. The aggregate parent dump (without the
 * identifier segment) typically reports the sum and is comparable.
 */
function hasInstanceIdentifierSegment(allocator: string): boolean {
  for (const segment of allocator.split('/')) {
    // 12+ char pure hex string (optionally with leading underscores) -
    // covers shared_memory UUIDs (`<32hex>`), Blink GC mangled type IDs
    // (`__<12-16hex>`), and similar machine-generated identifiers. We
    // don't try to distinguish "stable hash" from "unstable UUID":
    // both are unreadable to humans, both produce hundreds-to-thousands
    // of sibling rows, and the aggregate parent dump is always the row
    // a human would want anyway. 12 chars is the smallest threshold
    // that catches all observed identifiers without colliding with
    // legitimate English-word-ish allocator segment names (the longest
    // hex-only English words like `feedback` are 8 chars).
    if (/^_*[0-9a-fA-F]{12,}$/.test(segment)) return true;
    // `_0x<hex>` raw pointer address suffix (e.g. `client_0x1`,
    // `cache_0x7fff12345abc`).
    if (/_0x[0-9a-fA-F]+$/.test(segment)) return true;
    // Bare `0x<hex>` segment - same idea as the suffix form but the
    // hex address occupies a whole `/`-separated segment (e.g.
    // `sqlite/Passwords_connection/0x465400EC9DC0`). Chromium's
    // dump providers append these as standalone child dumps under a
    // semantic parent.
    if (/^0x[0-9a-fA-F]+$/.test(segment)) return true;
    // `_<hex>:<hex>:<hex>:...` colon-separated UUID/mailbox identifier
    // (e.g. `mailbox_00:4F:65:5D:...`).
    if (/_[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){3,}/.test(segment)) return true;
  }
  return false;
}

/**
 * The set of memory-infra dump attributes tachometer tracks. Curated to
 * focus on "actual memory in bytes" - the question every memory
 * benchmark is asking - rather than the dozens of counters
 * (`object_count`, `alloc_count`, ...), pool bookkeeping
 * (`regular_pool_usage`, `brp_pool_largest_reservation`, ...), boolean
 * flags (`is_peak_rss_resettable`, `is_prepaint`), and derived rates
 * (`syscalls_per_minute`, `brp_quarantined_bytes_per_minute`) that
 * memory-infra also emits and that just add noise to a memory result
 * table.
 *
 * - `size`: the primary "bytes allocated for this dump" metric that
 *   every named allocator reports.
 * - `effective_size`: bytes attributed after sharing is split across
 *   owners (the "fair share" view of memory). Computed by Chromium's
 *   memory-dump graph processor during JSON export, so it appears in
 *   the per-process dump events for nodes that participate in sharing.
 * - `peak_resident_set_size`, `private_footprint_bytes`: process-level
 *   RSS-style attributes (in bytes) reported under `process_totals` on
 *   Chromium's supported platforms.
 * - `resident_set_bytes`: also tracked for forward/cross-browser
 *   compatibility, but current Chromium does NOT emit it under
 *   `process_totals` in the `Tracing.requestMemoryDump` trace path (the
 *   non-peak resident-set value is only exposed through a separate
 *   memory-instrumentation query API that tachometer does not use). It
 *   is harmless to keep in the tracked set: enumeration simply never
 *   discovers it from a live dump.
 */
/**
 * The set of memory-infra dump attributes tachometer tracks, exposed
 * as a sorted array for diagnostic output (see the
 * `--memory-categories-file` report). The internal set used by
 * {@link enumerateMemoryDump} is derived from this list.
 */
export const TRACKED_ATTRIBUTES_LIST: ReadonlyArray<string> = [
  'size',
  'effective_size',
  'peak_resident_set_size',
  'private_footprint_bytes',
  'resident_set_bytes',
];

const TRACKED_ATTRIBUTES: ReadonlySet<string> = new Set(
  TRACKED_ATTRIBUTES_LIST
);

/**
 * Enumerate every `(processRole, allocator, attribute)` tuple present in
 * a captured memory dump. Used by the runner's probe phase to discover
 * what categories to report. Includes `process_totals.*` as
 * `allocator='process_totals'`.
 *
 * Tuples without a known process role (i.e. no matching
 * `process_name` metadata event yet observed) are dropped, since they
 * cannot be addressed in later samples by a stable role key.
 *
 * Only attributes in {@link TRACKED_ATTRIBUTES} are enumerated. The
 * dozens of counters, pool bookkeeping, boolean flags, and derived
 * rates that memory-infra also emits are ignored - they aren't bytes
 * and don't answer a memory-cost question.
 *
 * When `options.maxAllocatorDepth` is set, allocators whose `/`-segment
 * count exceeds that value are skipped. Chromium memory-infra already
 * reports parent allocators as the sum of their children's roll-up
 * attributes, so dropping deeper paths usually preserves the
 * high-level picture while collapsing per-bucket / per-sub-arena
 * noise. `process_totals` is always depth 1 and is unaffected.
 */
export function enumerateMemoryDump(
  events: Array<MemoryDumpEvent | ProcessMetadataEvent>,
  options: {maxAllocatorDepth?: number} = {}
): MemoryDumpCategory[] {
  const maxDepth = options.maxAllocatorDepth;
  const dumps = events.filter(
    (e): e is MemoryDumpEvent => e.ph === 'v' || e.ph === 'V'
  );
  const roles = pidProcessRoles(events);

  const tuples = new Map<string, MemoryDumpCategory>();
  const addTuple = (
    processRole: string,
    allocator: string,
    attribute: string
  ) => {
    const key = `${processRole}\u0000${allocator}\u0000${attribute}`;
    if (!tuples.has(key)) {
      tuples.set(key, {processRole, allocator, attribute});
    }
  };

  for (const dump of dumps) {
    const role = roles.get(dump.pid);
    if (role === undefined) {
      continue;
    }
    const d = dump.args?.dumps;
    if (!d) continue;
    if (d.process_totals) {
      for (const [attr, value] of Object.entries(d.process_totals)) {
        if (!TRACKED_ATTRIBUTES.has(attr)) continue;
        // Only include numeric attributes - non-numeric ones (e.g. policy
        // enums) would crash the extraction path.
        if (parseMaybeHex(value) === undefined) continue;
        addTuple(role, 'process_totals', attr);
      }
    }
    for (const [allocator, a] of Object.entries(d.allocators ?? {})) {
      // Skip per-object instance dumps whose name embeds a hex address;
      // the address changes between samples so the tuple cannot be
      // tracked across the run. The aggregate parent dump (no `_0x`
      // suffix) reports the sum.
      if (hasInstanceIdentifierSegment(allocator)) continue;
      // Honor the max-depth cap by dropping deeper allocators outright.
      // Chromium reports the same roll-up attributes at every ancestor,
      // so the parent's row already covers the sum.
      if (maxDepth !== undefined && allocator.split('/').length > maxDepth) {
        continue;
      }
      for (const [attr, entry] of Object.entries(a.attrs ?? {})) {
        if (!TRACKED_ATTRIBUTES.has(attr)) continue;
        // Filter out non-numeric attribute values up front so the result
        // set is restricted to comparable scalars.
        if (parseMaybeHex(entry.value) === undefined) continue;
        addTuple(role, allocator, attr);
      }
    }
  }

  return [...tuples.values()].sort((a, b) => {
    if (a.processRole !== b.processRole) {
      return a.processRole < b.processRole ? -1 : 1;
    }
    if (a.allocator !== b.allocator) {
      return a.allocator < b.allocator ? -1 : 1;
    }
    if (a.attribute !== b.attribute) {
      return a.attribute < b.attribute ? -1 : 1;
    }
    return 0;
  });
}

/**
 * Drain entries from the `performance` log channel. Used to scoop up the
 * trace events emitted while waiting for a memory dump to complete. When
 * `accumulator` is supplied, drained entries are appended to it so the caller
 * can later persist them (e.g. write a `--trace` file).
 */
async function drainPerformanceLog(
  driver: webdriver.WebDriver,
  accumulator?: webdriver.logging.Entry[]
): Promise<webdriver.logging.Entry[]> {
  let all: webdriver.logging.Entry[] = [];
  // Loop until we get back an empty chunk to ensure we have everything.

  while (true) {
    const chunk = await driver.manage().logs().get('performance');
    if (chunk.length === 0) {
      break;
    }
    all = all.concat(chunk);
    if (accumulator !== undefined) {
      for (const entry of chunk) {
        accumulator.push(entry);
      }
    }
  }
  return all;
}

/**
 * How long, in total, we'll wait for a Chromium memory dump's trace events
 * to arrive after we triggered the dump. This is intentionally a hard cap
 * inside one call so the outer runner poll loop doesn't end up re-issuing
 * `Tracing.requestMemoryDump` repeatedly while a slow dump is in flight.
 */
const MEMORY_DUMP_TIMEOUT_MS = 5000;

/**
 * How frequently we'll poll the performance log channel waiting for dump
 * events after triggering a dump.
 */
const MEMORY_DUMP_POLL_INTERVAL_MS = 100;

/**
 * When `drainUntilQuiet` is enabled (the probe path), how many consecutive
 * empty drains we need to see after the first matching dump event before
 * we consider the dump complete. Empty drains are separated by
 * {@link MEMORY_DUMP_POLL_INTERVAL_MS}, so 3 empty drains means roughly
 * 300ms of quiet trace channel.
 */
const MEMORY_DUMP_QUIET_DRAINS = 3;

/**
 * A cache of one captured memory-infra dump. A single dump contains every
 * allocator's stats for every process, so when a spec has multiple memory
 * measurements (e.g. one for `v8/main/heap.size`, one for `blink_gc.size`)
 * we only need to trigger one dump and then read each metric out of the
 * same set of events. The runner allocates one of these per page attempt
 * and threads it through to {@link queryForMemory} via {@link measure}.
 */
export interface MemoryDumpCache {
  /**
   * All trace events observed while the dump was being collected. Includes
   * the `ph: 'v'` / `ph: 'V'` memory dump events and any `ph: 'M'` process
   * metadata events that arrived alongside them.
   */
  events?: Array<MemoryDumpEvent | ProcessMetadataEvent>;
  /**
   * The dump GUID returned by `Tracing.requestMemoryDump`. Used to filter
   * the trace events down to the dump we triggered.
   */
  dumpGuid?: string;
}

/**
 * Wrap a promise with a timeout. Resolves with the promise's value if
 * it completes within `timeoutMs`, or with `'timeout'` if not.
 * Used as a watchdog around Chrome DevTools Protocol commands sent via
 * `sendDevToolsCommand`, which can hang indefinitely if chromedriver
 * stalls between Chrome and the WebDriver client - without this, a
 * single hung command pins the whole benchmark run.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | 'timeout'> {
  let handle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    handle = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

/**
 * Maximum time we'll wait for a single `sendDevToolsCommand` call to
 * return. Chromium's `Tracing.requestMemoryDump` and
 * `HeapProfiler.collectGarbage` normally respond within a few hundred
 * milliseconds; if they don't, something has gone wrong (chromedriver
 * stalled, the renderer crashed, the trace pipeline is stuck), and
 * indefinite blocking just turns into a "silent hang" in the runner.
 * Bound the wait so the per-attempt retry loop can move on.
 */
const DEVTOOLS_COMMAND_TIMEOUT_MS = 10000;

/**
 * Trigger one memory-infra dump and return all observed trace events.
 * Returns `undefined` if no dump events arrived within the timeout.
 *
 * When `drainUntilQuiet` is set (the probe path uses this), the function
 * keeps polling the performance log after the first matching dump event
 * is observed, until the log goes quiet (no new entries for several poll
 * intervals) or the timeout fires. This ensures we observe every
 * process's dump event, not just the first one.
 */
async function captureMemoryDumpEvents(
  driver: webdriver.WebDriver,
  measurement: MemoryMeasurement | ResolvedMemoryMeasurement,
  options: {
    consumedPerfLog?: webdriver.logging.Entry[];
    timeoutMs?: number;
    drainUntilQuiet?: boolean;
    /**
     * Override for the watchdog around `sendDevToolsCommand` calls.
     * Defaults to {@link DEVTOOLS_COMMAND_TIMEOUT_MS}; tests pass a
     * short value so they can verify the watchdog without hanging for
     * 10 seconds.
     */
    devtoolsTimeoutMs?: number;
  }
): Promise<
  | {
      events: Array<MemoryDumpEvent | ProcessMetadataEvent>;
      dumpGuid: string | undefined;
    }
  | undefined
> {
  const driverWithCdp = driver as unknown as WebDriverWithSendDevToolsCommand;
  if (!driverWithCdp.sendDevToolsCommand) {
    throw new Error(
      'Memory measurement requires a Chromium-based browser ' +
        '(chrome or edge); this WebDriver does not expose sendDevToolsCommand.'
    );
  }

  const consumedPerfLog = options.consumedPerfLog;
  const devtoolsTimeoutMs =
    options.devtoolsTimeoutMs ?? DEVTOOLS_COMMAND_TIMEOUT_MS;

  const gcBefore = measurement.gcBefore !== false;
  if (gcBefore) {
    try {
      // Both GC calls go through the same watchdog. If chromedriver hangs
      // on either, we'd otherwise stall the whole sample. GC failures /
      // timeouts are non-fatal: we still want to take the dump.
      await withTimeout(
        driverWithCdp.sendDevToolsCommand('HeapProfiler.enable', {}),
        devtoolsTimeoutMs
      );
      await withTimeout(
        driverWithCdp.sendDevToolsCommand('HeapProfiler.collectGarbage', {}),
        devtoolsTimeoutMs
      );
    } catch {
      // GC failures are non-fatal: we still want to take the dump.
    }
  }

  // Drain any pending performance log entries so the dump we're about to
  // request is easier to locate. These predate the dump, so we forward them
  // to the accumulator too  they're still valid trace events.
  await drainPerformanceLog(driver, consumedPerfLog);

  const dumpResultOrTimeout = await withTimeout(
    driverWithCdp.sendDevToolsCommand('Tracing.requestMemoryDump', {
      deterministic: false,
      levelOfDetail: measurement.dumpLevel ?? 'detailed',
    }),
    devtoolsTimeoutMs
  );
  if (dumpResultOrTimeout === 'timeout') {
    // The DevTools `Tracing.requestMemoryDump` call itself hung. Returning
    // `undefined` lets the caller treat this attempt the same as a normal
    // dump-never-arrived timeout: the per-attempt retry loop in
    // `takeSamples` reloads the page and tries again, instead of pinning
    // Node forever waiting on a chromedriver pipe that's already stuck.
    return undefined;
  }
  const dumpResult = dumpResultOrTimeout as
    | {dumpGuid?: string; success?: boolean}
    | undefined;

  const dumpGuid =
    dumpResult && typeof dumpResult.dumpGuid === 'string'
      ? dumpResult.dumpGuid
      : undefined;

  // Poll the performance log until we see dump events matching our GUID,
  // or (in probe/drain-until-quiet mode) until the log goes quiet for a
  // few intervals, or we hit the internal timeout.
  //
  // We only retain memory-dump (`ph: 'v'` / `'V'`) and process metadata
  // (`ph: 'M'`, `name: 'process_name'`) events. With memory-infra trace
  // categories enabled alongside v8/blink/gc the perf log can deliver
  // tens of thousands of unrelated trace events per sample - keeping
  // them all in heap across an auto-sample run is what blows past 8 GB.
  const events: Array<MemoryDumpEvent | ProcessMetadataEvent> = [];
  const accumulateEvents = (entries: webdriver.logging.Entry[]) => {
    for (const entry of entries) {
      let parsed: CdpLogMessage;
      try {
        parsed = JSON.parse(entry.message);
      } catch {
        continue;
      }
      if (
        parsed.message?.method !== 'Tracing.dataCollected' ||
        !parsed.message.params
      ) {
        continue;
      }
      const params = parsed.message.params as unknown as
        | MemoryDumpEvent
        | ProcessMetadataEvent;
      // Drop everything that isn't a memory dump or a process_name
      // metadata event - those are the only events extraction and
      // enumeration look at.
      if (
        params.ph !== 'v' &&
        params.ph !== 'V' &&
        !(
          params.ph === 'M' &&
          (params as ProcessMetadataEvent).name === 'process_name'
        )
      ) {
        continue;
      }
      events.push(params);
    }
  };

  const deadline = Date.now() + (options.timeoutMs ?? MEMORY_DUMP_TIMEOUT_MS);
  let haveMatchingDump: boolean;
  let quietDrains = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, MEMORY_DUMP_POLL_INTERVAL_MS));
    const entries = await drainPerformanceLog(driver, consumedPerfLog);
    accumulateEvents(entries);
    if (dumpGuid !== undefined) {
      haveMatchingDump = events.some(
        (e) =>
          (e.ph === 'v' || e.ph === 'V') &&
          ((e as MemoryDumpEvent).id === dumpGuid ||
            (e as MemoryDumpEvent).dump_guid === dumpGuid)
      );
    } else {
      haveMatchingDump = events.some((e) => e.ph === 'v' || e.ph === 'V');
    }
    if (haveMatchingDump) {
      if (!options.drainUntilQuiet) {
        break;
      }
      // Probe path: after the first matching dump event, keep draining until
      // we see a few consecutive empty polls. That lets the trace channel
      // deliver dump events for every other process Chromium spawned.
      if (entries.length === 0) {
        quietDrains++;
        if (quietDrains >= MEMORY_DUMP_QUIET_DRAINS) {
          break;
        }
      } else {
        quietDrains = 0;
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
  }

  const hasAnyDump = events.some((e) => e.ph === 'v' || e.ph === 'V');
  if (!hasAnyDump) {
    return undefined;
  }
  return {events, dumpGuid};
}

/**
 * Pure metric extraction from a captured memory dump. Throws on
 * unrecoverable conditions (missing metric, wrong process when role
 * metadata is known); returns `undefined` only when there are simply no
 * matching dumps to read from.
 */
/**
 * Pure extraction of one resolved memory measurement from a captured dump.
 *
 * Missing-category policy:
 * - Process role observed in this dump but allocator/attribute absent
 *   for that role → return `0`. The allocator legitimately reported
 *   zero (or just did not report this attribute this sample).
 * - Process role NOT observed in this dump → return `0`. The dump
 *   itself arrived (so retrying won't help), but the process is gone.
 *   This happens routinely with Chromium's transient utility services
 *   (e.g. `service: quarantine.mojom.quarantine` is spawned for
 *   per-task Mark-of-the-Web checks on Windows and shuts down when
 *   the task completes). The process was alive during the probe, so
 *   the tuple is in the result set; at sample time it's gone, so the
 *   memory it consumed is `0`. We never want a transient service to
 *   exhaust the per-attempt retry budget and abort the whole run.
 * - No matching dump events at all → return `undefined`. This is the
 *   only legitimate retry signal (the dump request itself didn't
 *   complete, or trace events haven't arrived yet); reloading the
 *   page might unblock it.
 */
function extractMemoryMetric(
  captured: {
    events: Array<MemoryDumpEvent | ProcessMetadataEvent>;
    dumpGuid: string | undefined;
  },
  measurement: ResolvedMemoryMeasurement
): number | undefined {
  const valuesByRole = readPerRoleSum(
    captured,
    measurement.processRole,
    measurement.allocator,
    measurement.attribute
  );
  return valuesByRole;
}

/**
 * Sum the value of one allocator's attribute across every dump for
 * one process role. Returns:
 *
 * - `undefined` if the dump itself didn't arrive (caller should retry).
 * - `0` if the role is missing or the allocator/attribute is absent
 *   for the role (per bug-6 missing-category policy).
 * - The summed numeric value otherwise.
 *
 * Shared between {@link extractMemoryMetric} (single-tuple) and
 * {@link extractAggregatedMemoryMetric} (per-source loop) so both
 * paths agree on the missing-policy.
 */
function readPerRoleSum(
  captured: {
    events: Array<MemoryDumpEvent | ProcessMetadataEvent>;
    dumpGuid: string | undefined;
  },
  processRole: string,
  allocator: string,
  attribute: string
): number | undefined {
  const {events, dumpGuid} = captured;
  const allDumps = events.filter(
    (e): e is MemoryDumpEvent => e.ph === 'v' || e.ph === 'V'
  );
  let dumps = allDumps;
  if (dumpGuid !== undefined) {
    const matching = allDumps.filter(
      (e) => e.id === dumpGuid || e.dump_guid === dumpGuid
    );
    if (matching.length > 0) {
      dumps = matching;
    }
  }
  if (dumps.length === 0) {
    return undefined;
  }

  const roles = pidProcessRoles(events);
  const matchingDumps = dumps.filter((d) =>
    isRoleMatch(processRole, roles.get(d.pid))
  );

  if (matchingDumps.length === 0) {
    // Process role wasn't observed in this sample's dumps even though
    // the dump itself arrived. The process is gone - treat the tuple
    // as zero rather than retrying the whole page (retries won't bring
    // back a transient service). See "Missing-category policy" above.
    return 0;
  }

  let total = 0;
  let any = false;
  for (const dump of matchingDumps) {
    const v = readAttribute(dump, allocator, attribute);
    if (v !== undefined) {
      total += v;
      any = true;
    }
  }
  // Role's dumps were present but this allocator/attribute was absent
  // in every one of them - legitimate zero (or absent) result.
  return any ? total : 0;
}

/**
 * Pure extraction of an aggregated memory measurement from a captured
 * dump. Sums each `(processRole, allocator)` source's value of the
 * shared `attribute` and returns the total.
 *
 * Missing-source policy mirrors {@link extractMemoryMetric} per source:
 * - A source whose process role is gone contributes 0.
 * - A source whose allocator is absent contributes 0.
 * - If the dump itself didn't arrive, returns `undefined` so the
 *   caller's retry loop can reload the page. (We don't sum partial
 *   data; if the dump is missing we have nothing to sum.)
 */
function extractAggregatedMemoryMetric(
  captured: {
    events: Array<MemoryDumpEvent | ProcessMetadataEvent>;
    dumpGuid: string | undefined;
  },
  measurement: AggregatedMemoryMeasurement
): number | undefined {
  const {events} = captured;
  const allDumps = events.filter(
    (e): e is MemoryDumpEvent => e.ph === 'v' || e.ph === 'V'
  );
  if (allDumps.length === 0) {
    return undefined;
  }
  let total = 0;
  for (const source of measurement.sources) {
    const v = readPerRoleSum(
      captured,
      source.processRole,
      source.allocator,
      measurement.attribute
    );
    if (v === undefined) {
      // Dump didn't arrive at all - mirror single-tuple retry signal.
      return undefined;
    }
    total += v;
  }
  return total;
}

/**
 * Trigger a memory-infra dump via the Chrome DevTools Protocol and read
 * the requested resolved memory tuple out of it.
 *
 * Returns the value in bytes (possibly zero - see missing-category policy
 * on {@link extractMemoryMetric}), or `undefined` when no dump arrived
 * within the internal timeout or the resolved measurement's process role
 * isn't represented in the dump yet (callers may then retry on a fresh
 * page attempt).
 *
 * When `options.memoryDumpCache` is supplied, a single dump is shared
 * across all calls that use the same cache object. Only the first call
 * triggers `Tracing.requestMemoryDump`; subsequent calls extract their
 * metric from the cached events synchronously. The runner allocates one
 * cache per page attempt so that all auto-discovered memory measurements
 * on the same page only fire one dump per sample.
 */
export async function queryForMemory(
  driver: webdriver.WebDriver,
  measurement: ResolvedMemoryMeasurement | AggregatedMemoryMeasurement,
  options: {
    consumedPerfLog?: webdriver.logging.Entry[];
    /**
     * Maximum time, in milliseconds, to wait for dump trace events to
     * arrive after triggering the dump. Defaults to
     * {@link MEMORY_DUMP_TIMEOUT_MS}.
     */
    timeoutMs?: number;
    /**
     * Override for the watchdog around `sendDevToolsCommand` calls.
     * Defaults to {@link DEVTOOLS_COMMAND_TIMEOUT_MS}.
     */
    devtoolsTimeoutMs?: number;
    /**
     * If supplied, the captured dump events are cached on this object so
     * subsequent calls with the same cache skip the dump request entirely
     * and extract their metric from the cached events.
     */
    memoryDumpCache?: MemoryDumpCache;
  } = {}
): Promise<number | undefined> {
  const cache = options.memoryDumpCache;

  const extractFromCaptured = (captured: {
    events: Array<MemoryDumpEvent | ProcessMetadataEvent>;
    dumpGuid: string | undefined;
  }): number | undefined => {
    if (isAggregatedMemoryMeasurement(measurement)) {
      return extractAggregatedMemoryMetric(captured, measurement);
    }
    return extractMemoryMetric(captured, measurement);
  };

  // If we already captured a dump for this attempt, just read the metric.
  if (cache && cache.events !== undefined) {
    return extractFromCaptured({
      events: cache.events,
      dumpGuid: cache.dumpGuid,
    });
  }

  const captured = await captureMemoryDumpEvents(driver, measurement, {
    consumedPerfLog: options.consumedPerfLog,
    timeoutMs: options.timeoutMs,
    devtoolsTimeoutMs: options.devtoolsTimeoutMs,
  });
  if (captured === undefined) {
    return undefined;
  }

  if (cache) {
    cache.events = captured.events;
    cache.dumpGuid = captured.dumpGuid;
  }

  return extractFromCaptured(captured);
}

/**
 * Trigger a memory-infra dump, drain the trace channel until quiet, and
 * enumerate every `(processRole, allocator, attribute)` tuple present in
 * it. Used by the runner's probe phase to discover what categories to
 * report on for the rest of the run.
 *
 * Returns `undefined` if no dump arrived in time. The caller will surface
 * a clear error - probing should never silently produce zero categories.
 */
export async function probeMemoryCategories(
  driver: webdriver.WebDriver,
  measurement: MemoryMeasurement,
  options: {
    consumedPerfLog?: webdriver.logging.Entry[];
    timeoutMs?: number;
  } = {}
): Promise<MemoryDumpCategory[] | undefined> {
  const captured = await captureMemoryDumpEvents(driver, measurement, {
    consumedPerfLog: options.consumedPerfLog,
    timeoutMs: options.timeoutMs,
    drainUntilQuiet: true,
  });
  if (captured === undefined) {
    return undefined;
  }
  return enumerateMemoryDump(captured.events, {
    maxAllocatorDepth:
      measurement.maxAllocatorDepth ?? defaults.memoryDefaultMaxAllocatorDepth,
  });
}
// ----- end memory measurement -----------------------------------------------

/**
 * Return a good-enough label for the given measurement, to disambiguate cases
 * where there are multiple measurements on the same page.
 */
export function measurementName(measurement: RuntimeMeasurement): string {
  // Aggregated memory measurements are special-cased: they don't carry a
  // user-supplied `name` (the user names them via `sumAs`), and we want
  // a consistent `memory:sum:<name>` label that mirrors the
  // `memory:tuple:` format used for resolved memory rows. Check before
  // the generic `measurement.name` fallback below.
  if (
    measurement.mode === 'memory' &&
    isAggregatedMemoryMeasurement(measurement)
  ) {
    return `memory:sum:${measurement.sumAs}`;
  }
  if (measurement.name) {
    return measurement.name;
  }

  switch (measurement.mode) {
    case 'callback':
      return 'callback';
    case 'expression':
      return measurement.expression;
    case 'performance':
      return measurement.entryName === 'first-contentful-paint'
        ? 'fcp'
        : measurement.entryName;
    case 'memory':
      if (isResolvedMemoryMeasurement(measurement)) {
        return `memory:tuple:${measurement.processRole}:${measurement.allocator}.${measurement.attribute}`;
      }
      // Unresolved (pre-probe) memory measurements don't yet have a
      // tuple; show a generic name. Real result rows always carry the
      // resolved or aggregated form, so this branch is only hit for
      // debug/log output during the probe phase.
      return 'memory';
  }
  throwUnreachable(
    measurement,
    `Internal error: unknown measurement type ` + JSON.stringify(measurement)
  );
}

/**
 * Compute the `compareKey` for a resolved memory measurement. Use this
 * (rather than a hand-built string) anywhere the runner needs to set the
 * `compareKey` field so the format stays consistent with the label.
 */
/**
 * Compute the stats `compareKey` for a resolved (single-tuple) memory
 * measurement. The `memory:tuple:` prefix keeps these structurally
 * distinct from aggregate keys (see {@link memoryAggregateCompareKey})
 * and from any future stats-engine keys.
 */
export function memoryCompareKey(m: ResolvedMemoryMeasurement): string {
  return `memory:tuple:${m.processRole}:${m.allocator}.${m.attribute}`;
}

/**
 * Compute the stats `compareKey` for an aggregated memory measurement.
 * The `memory:sum:` prefix is reserved for aggregates - it cannot
 * collide with a `memory:tuple:` key even if a user picks a `sumAs`
 * that happens to look like a tuple identifier.
 */
export function memoryAggregateCompareKey(
  m: AggregatedMemoryMeasurement
): string {
  return `memory:sum:${m.sumAs}`;
}

/**
 * Compile a glob pattern into an anchored RegExp. Used by
 * {@link MemoryMeasurement.categories} to match probe-discovered
 * tuple IDs (`<processRole>:<allocator>.<attribute>`).
 *
 * Glob semantics: `*` matches any sequence of characters including
 * `:`, `/`, and `.`. All other characters are matched literally
 * (regex specials are escaped). The returned RegExp is anchored on
 * both ends so we always test the whole tuple ID.
 */
export function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexBody = escaped.replace(/\*/g, '.*');
  return new RegExp('^' + regexBody + '$');
}

/**
 * Build the full tuple identifier string used for glob matching:
 * `<processRole>:<allocator>.<attribute>`.
 */
export function categoryTupleId(t: {
  processRole: string;
  allocator: string;
  attribute: string;
}): string {
  return `${t.processRole}:${t.allocator}.${t.attribute}`;
}
