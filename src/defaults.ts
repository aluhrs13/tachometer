/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as path from 'path';
import {BrowserName} from './browser.js';
import {LocalUrl, Measurement, RemoteUrl} from './types.js';

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
 * Default metric path used when the user opts into memory measurement via
 * `--measure=memory` without specifying a metric.
 */
export const memoryDefaultMetric = 'v8/main/heap.size';

/**
 * Which process to read the memory metric from by default.
 */
export const memoryDefaultProcess: 'renderer' | 'browser' | 'gpu' | 'all' =
  'renderer';

/**
 * Default dump level of detail requested via `Tracing.requestMemoryDump`.
 */
export const memoryDefaultDumpLevel: 'light' | 'detailed' = 'detailed';

/**
 * Whether to force a garbage collection before capturing a memory dump.
 */
export const memoryDefaultGcBefore = true;

export function measurement(url: LocalUrl | RemoteUrl): Measurement {
  if (url.kind === 'remote') {
    return {
      mode: 'performance',
      entryName: 'first-contentful-paint',
    };
  }
  return {mode: 'callback'};
}
