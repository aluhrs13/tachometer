/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as webdriver from 'selenium-webdriver';

import {Server} from './server.js';
import {
  Measurement,
  MemoryMeasurement,
  PerformanceEntryMeasurement,
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
  measurement: Measurement,
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
 */
function parseMaybeHex(value: string | number): number {
  if (typeof value === 'number') {
    return value;
  }
  // Chromium reports size attributes as lowercase hex with no `0x` prefix.
  const n = /^[0-9a-fA-F]+$/.test(value) ? parseInt(value, 16) : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Could not parse memory dump value: ${value}`);
  }
  return n;
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

function isRoleMatch(
  desired: 'renderer' | 'browser' | 'gpu' | 'all',
  role: string | undefined
): boolean {
  if (desired === 'all') {
    return true;
  }
  if (role === undefined) {
    return false;
  }
  // Chromium reports process_name values like "Renderer", "Browser",
  // "GPU Process". Normalise via simple substring matching.
  if (desired === 'renderer') {
    return role.includes('renderer');
  }
  if (desired === 'browser') {
    return role.includes('browser');
  }
  if (desired === 'gpu') {
    return role.includes('gpu');
  }
  return false;
}

/**
 * Read a metric out of one memory dump event by dotted path
 * (e.g. `v8/main/heap.size`, `process_totals.resident_set_bytes`).
 *
 * Returns `undefined` if this dump doesn't contain the path.
 */
function readMetric(
  event: MemoryDumpEvent,
  metric: string
): number | undefined {
  const dot = metric.lastIndexOf('.');
  if (dot === -1) {
    throw new Error(
      `Invalid memory metric "${metric}": expected "<allocator>.<attr>" ` +
        `or "process_totals.<attr>"`
    );
  }
  const allocator = metric.slice(0, dot);
  const attr = metric.slice(dot + 1);
  const dumps = event.args && event.args.dumps;
  if (dumps === undefined) {
    return undefined;
  }
  if (allocator === 'process_totals') {
    const v = dumps.process_totals?.[attr];
    return v === undefined ? undefined : parseMaybeHex(v);
  }
  const a = dumps.allocators?.[allocator];
  if (a === undefined) {
    return undefined;
  }
  const attrEntry = a.attrs?.[attr];
  if (attrEntry === undefined) {
    return undefined;
  }
  return parseMaybeHex(attrEntry.value);
}

/**
 * List the allocator paths visible across the supplied dump events, for use
 * in error messages.
 */
function availableAllocators(events: MemoryDumpEvent[]): string[] {
  const out = new Set<string>();
  for (const ev of events) {
    const dumps = ev.args?.dumps;
    if (!dumps) continue;
    if (dumps.process_totals) {
      out.add('process_totals');
    }
    for (const name of Object.keys(dumps.allocators ?? {})) {
      out.add(name);
    }
  }
  return [...out].sort();
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
  // eslint-disable-next-line no-constant-condition
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
 * Trigger one memory-infra dump and return all observed trace events.
 * Returns `undefined` if no dump events arrived within the timeout.
 */
async function captureMemoryDumpEvents(
  driver: webdriver.WebDriver,
  measurement: MemoryMeasurement,
  options: {
    consumedPerfLog?: webdriver.logging.Entry[];
    timeoutMs?: number;
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

  const gcBefore = measurement.gcBefore !== false;
  if (gcBefore) {
    try {
      await driverWithCdp.sendDevToolsCommand('HeapProfiler.enable', {});
      await driverWithCdp.sendDevToolsCommand(
        'HeapProfiler.collectGarbage',
        {}
      );
    } catch {
      // GC failures are non-fatal: we still want to take the dump.
    }
  }

  // Drain any pending performance log entries so the dump we're about to
  // request is easier to locate. These predate the dump, so we forward them
  // to the accumulator too  they're still valid trace events.
  await drainPerformanceLog(driver, consumedPerfLog);

  const dumpResult = (await driverWithCdp.sendDevToolsCommand(
    'Tracing.requestMemoryDump',
    {
      deterministic: false,
      levelOfDetail: measurement.dumpLevel ?? 'detailed',
    }
  )) as {dumpGuid?: string; success?: boolean} | undefined;

  const dumpGuid =
    dumpResult && typeof dumpResult.dumpGuid === 'string'
      ? dumpResult.dumpGuid
      : undefined;

  // Poll the performance log until we see dump events matching our GUID, or
  // we hit the internal timeout.
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
      events.push(
        parsed.message.params as unknown as
          | MemoryDumpEvent
          | ProcessMetadataEvent
      );
    }
  };

  const deadline = Date.now() + (options.timeoutMs ?? MEMORY_DUMP_TIMEOUT_MS);
  let haveMatchingDump = false;
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
      break;
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
function extractMemoryMetric(
  captured: {
    events: Array<MemoryDumpEvent | ProcessMetadataEvent>;
    dumpGuid: string | undefined;
  },
  measurement: MemoryMeasurement
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

  const desired = measurement.process ?? 'renderer';
  const roles = pidProcessRoles(events);

  const matchingDumps = dumps.filter((d) =>
    isRoleMatch(desired, roles.get(d.pid))
  );

  if (matchingDumps.length === 0) {
    // No process-role metadata available (which is common when Chromium
    // hasn't emitted process_name events yet). Fall back to all dumps so
    // we still return a sensible value.
    if (desired === 'renderer' && roles.size === 0) {
      // Best effort: pick the dump that actually has the metric.
      const fallback = dumps.find(
        (d) => readMetric(d, measurement.metric) !== undefined
      );
      if (fallback) {
        const v = readMetric(fallback, measurement.metric);
        if (v !== undefined) return v;
      }
    }
    throw new Error(
      `No memory dump found for process "${desired}". ` +
        `Known process roles: ${
          [...new Set(roles.values())].join(', ') || '<none>'
        }.`
    );
  }

  let total = 0;
  let found = false;
  for (const dump of matchingDumps) {
    const v = readMetric(dump, measurement.metric);
    if (v !== undefined) {
      total += v;
      found = true;
      if (desired !== 'all') {
        // For non-`all` selectors we only want the first matching process.
        return v;
      }
    }
  }
  if (!found) {
    throw new Error(
      `Memory metric "${measurement.metric}" not found in dump. ` +
        `Available top-level allocators: ${availableAllocators(
          matchingDumps
        ).join(', ')}.`
    );
  }
  return total;
}

/**
 * Trigger a memory-infra dump via the Chrome DevTools Protocol and read the
 * requested metric out of it.
 *
 * Returns the value in bytes, or `undefined` when no dump arrived within
 * the internal timeout (callers may then retry on a fresh page attempt).
 *
 * When `options.memoryDumpCache` is supplied, a single dump is shared
 * across all calls that use the same cache object. Only the first call
 * triggers `Tracing.requestMemoryDump`; subsequent calls extract their
 * metric from the cached events synchronously. The runner allocates one
 * cache per page attempt so that multiple memory measurements on the same
 * page only fire one dump per sample. Note that this also means the
 * `gcBefore` and `dumpLevel` settings on the *first* memory measurement
 * of the spec determine the dump's behaviour; settings on later
 * measurements are ignored for cached dumps (a single dump only has one
 * level of detail, and a single GC is semantically correct since all
 * metrics are read from the same moment in time).
 */
export async function queryForMemory(
  driver: webdriver.WebDriver,
  measurement: MemoryMeasurement,
  options: {
    consumedPerfLog?: webdriver.logging.Entry[];
    /**
     * Maximum time, in milliseconds, to wait for dump trace events to
     * arrive after triggering the dump. Defaults to
     * {@link MEMORY_DUMP_TIMEOUT_MS}.
     */
    timeoutMs?: number;
    /**
     * If supplied, the captured dump events are cached on this object so
     * subsequent calls with the same cache skip the dump request entirely
     * and extract their metric from the cached events.
     */
    memoryDumpCache?: MemoryDumpCache;
  } = {}
): Promise<number | undefined> {
  const cache = options.memoryDumpCache;

  // If we already captured a dump for this attempt, just read the metric.
  if (cache && cache.events !== undefined) {
    return extractMemoryMetric(
      {events: cache.events, dumpGuid: cache.dumpGuid},
      measurement
    );
  }

  const captured = await captureMemoryDumpEvents(driver, measurement, {
    consumedPerfLog: options.consumedPerfLog,
    timeoutMs: options.timeoutMs,
  });
  if (captured === undefined) {
    return undefined;
  }

  if (cache) {
    cache.events = captured.events;
    cache.dumpGuid = captured.dumpGuid;
  }

  return extractMemoryMetric(captured, measurement);
}
// ----- end memory measurement -----------------------------------------------

/**
 * Return a good-enough label for the given measurement, to disambiguate cases
 * where there are multiple measurements on the same page.
 */
export function measurementName(measurement: Measurement): string {
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
      return `memory:${measurement.metric}`;
  }
  throwUnreachable(
    measurement,
    `Internal error: unknown measurement type ` + JSON.stringify(measurement)
  );
}
