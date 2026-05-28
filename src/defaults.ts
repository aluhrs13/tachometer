/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as path from 'path';
import {BrowserName} from './browser.js';
import {CategoryRule, LocalUrl, Measurement, RemoteUrl} from './types.js';

export const windowWidth = 1024;
export const windowHeight = 768;
export const root = '.';
export const browserName: BrowserName = 'chrome';
export const headless = false;
export const sampleSize = 50;
export const timeout = 3;
export const autoSampleConditions = ['0%'] as const;
export const mode = 'automatic';
export const resolveBareModules = true;
export const forceCleanNpmInstall = false;
export const measurementExpression = 'window.tachometerResult';
export const traceLogDir = path.join(process.cwd(), 'logs');
export const traceCategories = [
  'blink',
  'blink.user_timing',
  'v8',
  'v8.execute',
  'disabled-by-default-v8.compile',
  // Seems to sometimes cause errors in Chrome's about:tracing
  // "disabled-by-default-v8.cpu_profiler",
  'disabled-by-default-v8.gc',
  'disabled-by-default-v8.turbofan',
];

/**
 * Tracing categories that must be enabled for Chromium's memory-infra
 * subsystem to emit memory dump events.
 */
export const memoryTraceCategories = [
  'disabled-by-default-memory-infra',
];

/**
 * Default dump level of detail requested via `Tracing.requestMemoryDump`.
 */
export const memoryDefaultDumpLevel: 'light' | 'detailed' = 'detailed';

/**
 * Whether to force a garbage collection before capturing a memory dump.
 */
export const memoryDefaultGcBefore = true;

/**
 * Default cap on the allocator-path depth tachometer enumerates.
 *
 * Depth 3 keeps every top-level subsystem (`malloc`, `blink_gc`, `v8`,
 * `partition_alloc`, `cc`, ...) and its top-level categories
 * (`v8/main/heap`, `malloc/partitions`, `blink_objects/<TypeName>`,
 * ...) while dropping the per-bucket and per-sub-arena breakdowns
 * that account for ~65% of rows on a typical `detailed` dump on a
 * real page. Users can override per-measurement via the
 * `maxAllocatorDepth` field on a {@link MemoryMeasurement}.
 */
export const memoryDefaultMaxAllocatorDepth = 3;

/**
 * The curated set of memory-infra categories tachometer reports for
 * every `mode: "memory"` measurement. Hard-coded (not user-configurable)
 * so every benchmark in every repo gets the same focused, comparable
 * row set without per-config bikeshedding.
 *
 * Each rule is processed by {@link applyCategoryRules} - bare `include`
 * rules emit one row per matching tuple, `sumAs` rules roll matches
 * into one summed row, and `optional: true` rules don't error when
 * they match zero tuples (e.g. process-totals attributes that some
 * platforms don't report, or service processes that don't exist on
 * a given run).
 *
 * Renderer rows are the bytes-level breakdown of the page's own
 * process. Browser rows use the synthetic `global` aggregator that
 * memory-infra emits for the whole process, giving one row per
 * attribute. Service processes (NetworkService, StorageService,
 * TracingService) each get one row per attribute, summed across
 * every top-level allocator the service exposes - per-mojom-service
 * breakdowns are useful, but the per-allocator-within-a-service
 * breakdown is noise for most benchmarks. Process-totals RSS
 * attributes give an OS-level baseline.
 *
 * If you find this list misses a category you care about for a
 * specific benchmark, look at the
 * `--memory-categories-file` diagnostic report's `droppedNoMatch`
 * list to see what's available and propose a change to this constant.
 */
export const memoryDefaultCategories: ReadonlyArray<CategoryRule> = [
  // Renderer: one row per top-level subsystem per attribute.
  // Memory-infra reports each parent allocator as the sum of its
  // children's roll-up attributes, so picking the parent tuple
  // directly already gives a per-subsystem aggregate without an
  // explicit sumAs. The `exclude: renderer:*/*` rule explicitly
  // drops the depth-2+ children from the candidate set so they show
  // up in `excludedByRule` (intentionally rolled into their parent)
  // rather than `droppedNoMatch` (unknown / unhandled).
  {exclude: 'renderer:*/*'},
  {include: 'renderer:blink_gc.size', optional: true},
  {include: 'renderer:blink_gc.effective_size', optional: true},
  {include: 'renderer:blink_objects.size', optional: true},
  {include: 'renderer:blink_objects.effective_size', optional: true},
  {include: 'renderer:cc.size', optional: true},
  {include: 'renderer:cc.effective_size', optional: true},
  {include: 'renderer:global.size', optional: true},
  {include: 'renderer:global.effective_size', optional: true},
  {include: 'renderer:malloc.size', optional: true},
  {include: 'renderer:malloc.effective_size', optional: true},
  {include: 'renderer:partition_alloc.size', optional: true},
  {include: 'renderer:partition_alloc.effective_size', optional: true},
  {include: 'renderer:skia.size', optional: true},
  {include: 'renderer:skia.effective_size', optional: true},
  {include: 'renderer:v8.size', optional: true},
  {include: 'renderer:v8.effective_size', optional: true},
  // Renderer: OS-level RSS, when the platform reports it.
  {
    include: 'renderer:process_totals.peak_resident_set_size',
    optional: true,
  },
  {
    include: 'renderer:process_totals.private_footprint_bytes',
    optional: true,
  },

  // Browser process: one row per attribute, summed across every
  // top-level allocator. The `exclude: browser:*/*` rule drops
  // depth-2+ tuples from the candidate set before the sumAs picks
  // up the parents - memory-infra reports parent allocators as the
  // sum of their children, so depth-1 already covers everything and
  // including the children would double-count.
  {exclude: 'browser:*/*'},
  {
    include: 'browser:*.size',
    sumAs: 'browser-size',
    optional: true,
  },
  {
    include: 'browser:*.effective_size',
    sumAs: 'browser-effective-size',
    optional: true,
  },
  // Browser: OS-level RSS, when the platform reports it.
  {
    include: 'browser:process_totals.peak_resident_set_size',
    optional: true,
  },
  {
    include: 'browser:process_totals.private_footprint_bytes',
    optional: true,
  },

  // Service processes (NetworkService, StorageService,
  // TracingService): one row per (service, attribute), summed across
  // every top-level allocator that service exposes. The
  // `exclude: ...:*/*` rule drops depth-2+ tuples from the candidate
  // set before the sumAs picks up the parents - memory-infra reports
  // parent allocators as the sum of their children, so depth-1
  // already covers everything and including the children would
  // double-count. The aggregates are `optional: true` because some
  // services don't start during a short benchmark run; missing
  // services just produce no row instead of erroring.
  {exclude: 'service: network.mojom.networkservice:*/*'},
  {
    include: 'service: network.mojom.networkservice:*.size',
    sumAs: 'network-service-size',
    optional: true,
  },
  {
    include: 'service: network.mojom.networkservice:*.effective_size',
    sumAs: 'network-service-effective-size',
    optional: true,
  },
  {
    include:
      'service: network.mojom.networkservice:process_totals.peak_resident_set_size',
    optional: true,
  },
  {
    include:
      'service: network.mojom.networkservice:process_totals.private_footprint_bytes',
    optional: true,
  },
  {exclude: 'service: storage.mojom.storageservice:*/*'},
  {
    include: 'service: storage.mojom.storageservice:*.size',
    sumAs: 'storage-service-size',
    optional: true,
  },
  {
    include: 'service: storage.mojom.storageservice:*.effective_size',
    sumAs: 'storage-service-effective-size',
    optional: true,
  },
  {
    include:
      'service: storage.mojom.storageservice:process_totals.peak_resident_set_size',
    optional: true,
  },
  {
    include:
      'service: storage.mojom.storageservice:process_totals.private_footprint_bytes',
    optional: true,
  },
  {exclude: 'service: tracing.mojom.tracingservice:*/*'},
  {
    include: 'service: tracing.mojom.tracingservice:*.size',
    sumAs: 'tracing-service-size',
    optional: true,
  },
  {
    include: 'service: tracing.mojom.tracingservice:*.effective_size',
    sumAs: 'tracing-service-effective-size',
    optional: true,
  },
  {
    include:
      'service: tracing.mojom.tracingservice:process_totals.peak_resident_set_size',
    optional: true,
  },
  {
    include:
      'service: tracing.mojom.tracingservice:process_totals.private_footprint_bytes',
    optional: true,
  },

  // GPU process: one row per top-level subsystem per attribute,
  // mirroring the renderer pattern. The `exclude: gpu process:*/*`
  // rule drops depth-2+ children so they show up in
  // `excludedByRule` instead of `droppedNoMatch`; the depth-1
  // parents already roll those children up. All rules are
  // `optional: true` because GPU subsystems can vary by build /
  // platform / scene state.
  {exclude: 'gpu process:*/*'},
  {include: 'gpu process:cc.size', optional: true},
  {include: 'gpu process:cc.effective_size', optional: true},
  {include: 'gpu process:gpu.size', optional: true},
  {include: 'gpu process:gpu.effective_size', optional: true},
  {include: 'gpu process:malloc.size', optional: true},
  {include: 'gpu process:malloc.effective_size', optional: true},
  {include: 'gpu process:shared_memory.size', optional: true},
  {include: 'gpu process:shared_memory.effective_size', optional: true},
  {
    include: 'gpu process:process_totals.peak_resident_set_size',
    optional: true,
  },
  {
    include: 'gpu process:process_totals.private_footprint_bytes',
    optional: true,
  },
];

export function measurement(url: LocalUrl | RemoteUrl): Measurement {
  if (url.kind === 'remote') {
    return {
      mode: 'performance',
      entryName: 'first-contentful-paint',
    };
  }
  return {mode: 'callback'};
}
