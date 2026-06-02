/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {BrowserConfig} from './browser.js';

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/**
 * A mapping from NPM package name to version specifier, as used in a
 * package.json's "dependencies" and "devDependencies".
 */
export interface PackageDependencyMap {
  [pkg: string]: string;
}

/**
 * Tachometer's extensions to the NPM "dependencies" field, which allows for
 * more advanced configurations.
 */
export interface ExtendedPackageDependencyMap {
  [pkg: string]: string | GitDependency;
}

/**
 * Configuration for cloning a Git repo at some ref with an optional package
 * sub-path for monorepos, for use as an NPM dependency.
 */
export interface GitDependency {
  kind: 'git';
  // The git repository to clone. Any valid `git clone <repository>` argument
  // (e.g. "git@github.com:webcomponents/polyfills.git").
  repo: string;
  // The branch, tag, or SHA to checkout (e.g. "master", "my-feature").
  ref: string;
  // For monorepos or other unusual file layouts, the path relative to the root
  // of the git repo where the "package.json" for the appropriate package can be
  // found (e.g. "packages/shadycss").
  subdir?: string;
  // Install, bootstrap, build, etc. commands to run before installing this
  // package as a dependency (e.g. ["npm install", "npm run build"]).
  setupCommands?: string[];
}

/**
 * The descriptor of a package version as specified by the --package-version
 * flag.
 */
export interface PackageVersion {
  label: string;
  dependencyOverrides: ExtendedPackageDependencyMap;
}

/** The subset of the format of an NPM package.json file we care about. */
export interface NpmPackageJson {
  private: boolean;
  dependencies: PackageDependencyMap;
}

/** The kinds of intervals we can measure (public/config-facing). */
export type Measurement =
  | CallbackMeasurement
  | PerformanceEntryMeasurement
  | ExpressionMeasurement
  | MemoryMeasurement
  | CpuMeasurement;

/**
 * The same union plus the internal {@link ResolvedMemoryMeasurement} and
 * {@link AggregatedMemoryMeasurement} forms that the runner produces
 * during the probe phase. This is the type that flows through the
 * sample-collection / stats / formatting pipeline after memory
 * expansion. It is intentionally *not* part of the public
 * {@link Measurement} union so that resolved/aggregated fields do not
 * leak into the generated config JSON schema.
 */
export type RuntimeMeasurement =
  | Measurement
  | ResolvedMemoryMeasurement
  | AggregatedMemoryMeasurement
  | ResolvedCpuMeasurement;

export interface MeasurementBase {
  name?: string;
  /**
   * Optional key used by the stats engine to group pairwise comparisons.
   * When set, {@link computeDifferences} only computes a difference between
   * two results whose `compareKey`s match. When unset (the default for all
   * non-memory measurements), the existing all-pairs comparison behavior is
   * preserved. Resolved memory measurements set this to
   * `memory:<processRole>:<allocator>.<attribute>` so each auto-discovered
   * category is only compared against the same category in other variants.
   */
  compareKey?: string;
}

/**
 * A category rule for the {@link MemoryMeasurement.categories} list.
 *
 * Each rule is either an `include` (which emits one row per matching
 * tuple, or one summed row when `sumAs` is set) or an `exclude` (which
 * removes matching tuples from the candidate set before any include
 * rule sees them). Patterns are globs over the full tuple identifier
 * `<processRole>:<allocator>.<attribute>`, where `*` matches any
 * sequence of characters (including `:`, `/`, and `.`).
 */
export type CategoryRule = CategoryIncludeRule | CategoryExcludeRule;

/**
 * Include rule. Matches a set of probe-discovered tuples and emits
 * them into the output table.
 *
 * - When `sumAs` is unset: each matching tuple becomes its own row
 *   (the same shape as default auto-discovery).
 * - When `sumAs` is set: matching tuples are summed into a single
 *   aggregated row named `sumAs`. All matched tuples must share the
 *   same attribute (you can't sum bytes-style `size` and
 *   bytes-style `effective_size` into a single number), and the
 *   matched allocator paths within a role must be disjoint (no
 *   parent-child overlap, which would double-count).
 * - `optional: true` opts a rule out of the default zero-match-is-an-
 *   error policy. Use for rules that may legitimately match nothing
 *   on some platforms or Chromium versions.
 */
export interface CategoryIncludeRule {
  include: string;
  sumAs?: string;
  optional?: boolean;
}

/**
 * Exclude rule. Drops matching tuples from the candidate set before
 * any include rule is evaluated. Order of `exclude` rules doesn't
 * matter; they're applied as a single filter pass.
 */
export interface CategoryExcludeRule {
  exclude: string;
}

export interface CallbackMeasurement extends MeasurementBase {
  mode: 'callback';
}

export interface PerformanceEntryMeasurement extends MeasurementBase {
  mode: 'performance';
  entryName: string;
}

export interface ExpressionMeasurement extends MeasurementBase {
  mode: 'expression';
  expression: string;
}

/**
 * Capture all memory values via Chromium's memory-infra tracing.
 *
 * This is the user-facing (unresolved) form. Tachometer triggers one
 * `Tracing.requestMemoryDump` per sample and auto-discovers every
 * `(processRole, allocator, attribute)` tuple present in the dump. At
 * warmup time, each unresolved `MemoryMeasurement` is expanded into N
 * {@link ResolvedMemoryMeasurement} entries (one per tuple discovered
 * across the union of probes from every spec).
 */
export interface MemoryMeasurement extends MeasurementBase {
  mode: 'memory';
  /**
   * Level of detail to request in the memory dump. Defaults to `detailed`.
   */
  dumpLevel?: 'light' | 'detailed';
  /**
   * Whether to force a garbage collection before capturing the dump. Defaults
   * to `true` to stabilize numbers.
   */
  gcBefore?: boolean;
  /**
   * Maximum allocator-path depth to enumerate, where depth is the number
   * of `/`-separated segments in the allocator name (e.g. `malloc` has
   * depth 1, `malloc/partitions` has depth 2,
   * `malloc/partitions/allocator/buckets/bucket_0000016` has depth 5).
   * Tuples whose allocator exceeds this depth are dropped at probe
   * time; Chromium memory-infra already reports parent allocators as
   * the sum of their children's `size`/`effective_size`/etc., so the
   * roll-up still appears in the result table - just at the configured
   * depth instead of as a forest of per-bucket sub-rows.
   *
   * Defaults to `3`, which keeps every top-level subsystem
   * (`malloc`, `blink_gc`, `v8`, `partition_alloc`, `cc`, ...) plus
   * its top-level categories (`v8/main/heap`, `malloc/partitions`,
   * `blink_objects/<TypeName>`, ...) while dropping the per-bucket and
   * per-sub-arena breakdowns that account for ~65% of rows on a
   * typical `detailed` dump. Pass a very large number (e.g. `99`) to
   * effectively disable the cap.
   */
  maxAllocatorDepth?: number;
}

/**
 * Internal expansion of one `{include: pattern, sumAs: name}` rule into
 * an aggregated row that sums a fixed set of probe-discovered tuples.
 * Synthesised by the runner during the probe phase and not part of
 * the public configuration API.
 *
 * All sources share the same {@link attribute} (enforced by the
 * runner); the per-sample value is the sum of `readAttribute` over
 * each source applied to the same dump cache.
 */
export interface AggregatedMemoryMeasurement extends MeasurementBase {
  mode: 'memory';
  /**
   * User-supplied aggregate name from the rule's `sumAs` field.
   * Used to derive both the displayed row label
   * (`memory:sum:<sumAs>`) and the stats `compareKey`.
   */
  sumAs: string;
  /**
   * The single attribute that every source shares. Sources are added
   * from `dumps.allocators[allocator].attrs[attribute]` of every
   * matching dump.
   */
  attribute: string;
  /**
   * The set of `(processRole, allocator)` pairs whose values are
   * summed per sample. Resolved once at probe time and reused for
   * every recorded sample.
   */
  sources: Array<{processRole: string; allocator: string}>;
  dumpLevel?: 'light' | 'detailed';
  gcBefore?: boolean;
}

/**
 * Internal expansion of a {@link MemoryMeasurement} into one concrete
 * `(processRole, allocator, attribute)` tuple. These are synthesised by
 * the runner during the probe phase and are not part of the public
 * configuration API.
 */
export interface ResolvedMemoryMeasurement extends MeasurementBase {
  mode: 'memory';
  /**
   * Chromium-reported `process_name`, lowercased (e.g. `renderer`,
   * `browser`, `gpu process`, `utility: network service`). When multiple
   * processes share the same role, their values are summed.
   */
  processRole: string;
  /**
   * Allocator path, e.g. `v8/main/heap`, `malloc`,
   * `partition_alloc/allocated_objects`, or the special `process_totals`
   * pseudo-allocator.
   */
  allocator: string;
  /**
   * Attribute on the allocator, e.g. `size`, `effective_size`,
   * `resident_set_bytes`.
   */
  attribute: string;
  dumpLevel?: 'light' | 'detailed';
  gcBefore?: boolean;
}

/**
 * Returns true if a measurement has been resolved (i.e. expanded by the
 * probe phase) and so carries a concrete process role, allocator, and
 * attribute.
 */
export function isResolvedMemoryMeasurement(
  m: RuntimeMeasurement
): m is ResolvedMemoryMeasurement {
  return (
    m.mode === 'memory' &&
    typeof (m as ResolvedMemoryMeasurement).processRole === 'string' &&
    typeof (m as ResolvedMemoryMeasurement).allocator === 'string' &&
    typeof (m as ResolvedMemoryMeasurement).attribute === 'string'
  );
}

/**
 * Returns true if a memory measurement is the unresolved (user-supplied)
 * form: `mode:'memory'` but without the resolved-tuple or aggregated
 * fields. These need to be expanded by the probe phase before sampling.
 */
export function isUnresolvedMemoryMeasurement(
  m: RuntimeMeasurement
): m is MemoryMeasurement {
  return (
    m.mode === 'memory' &&
    !isResolvedMemoryMeasurement(m) &&
    !isAggregatedMemoryMeasurement(m)
  );
}

/**
 * Returns true if a memory measurement is in the aggregated form (sum
 * of multiple `(processRole, allocator)` sources sharing one
 * attribute) produced by the probe phase from a category rule with
 * `sumAs`.
 */
export function isAggregatedMemoryMeasurement(
  m: RuntimeMeasurement
): m is AggregatedMemoryMeasurement {
  return (
    m.mode === 'memory' &&
    typeof (m as AggregatedMemoryMeasurement).sumAs === 'string' &&
    Array.isArray((m as AggregatedMemoryMeasurement).sources)
  );
}

/**
 * Returns true if a memory measurement is ready for per-sample
 * extraction - either a single-tuple resolved form or a multi-source
 * aggregated form. Anything else (an unresolved measurement that
 * somehow reached the sample loop) is a programmer error.
 */
export function isReadyMemoryMeasurement(
  m: RuntimeMeasurement
): m is ResolvedMemoryMeasurement | AggregatedMemoryMeasurement {
  return isResolvedMemoryMeasurement(m) || isAggregatedMemoryMeasurement(m);
}

/**
 * Capture main-thread renderer CPU time via Chromium's CDP
 * `Performance.getMetrics` (enabled with `timeDomain: 'threadTicks'`).
 *
 * This is the user-facing (unresolved) form. CPU is a *companion*
 * measurement: it has no completion signal of its own and snapshots its
 * `end` value when the spec's timing measurement (callback / fcp /
 * global) completes. A spec containing a `mode:'cpu'` measurement must
 * therefore also contain at least one timing measurement. At warmup
 * time each unresolved `CpuMeasurement` is expanded into one
 * {@link ResolvedCpuMeasurement} per metric in
 * {@link cpuDefaultMetrics}.
 *
 * The reported values are **main renderer thread CPU only** - they
 * exclude web/service workers, the compositor/raster threads, the GPU
 * process, the network service, and every other process. The sub-metrics
 * overlap (e.g. `ScriptDuration` is part of `TaskDuration`) and are NOT
 * additive.
 */
export interface CpuMeasurement extends MeasurementBase {
  mode: 'cpu';
}

/**
 * Internal expansion of a {@link CpuMeasurement} into one concrete
 * `Performance.getMetrics` metric (e.g. `TaskDuration`,
 * `ScriptDuration`). Synthesised by the runner before sampling and not
 * part of the public configuration API.
 */
export interface ResolvedCpuMeasurement extends MeasurementBase {
  mode: 'cpu';
  /**
   * The `Performance.getMetrics` metric name this row reports, e.g.
   * `TaskDuration`. The per-sample value is
   * `(end - baseline) * 1000` milliseconds of main-thread CPU.
   */
  metric: string;
}

/**
 * Returns true if a cpu measurement has been resolved (expanded) and so
 * carries a concrete metric name.
 */
export function isResolvedCpuMeasurement(
  m: RuntimeMeasurement
): m is ResolvedCpuMeasurement {
  return (
    m.mode === 'cpu' && typeof (m as ResolvedCpuMeasurement).metric === 'string'
  );
}

/**
 * Returns true if a cpu measurement is the unresolved (user-supplied)
 * form: `mode:'cpu'` without a concrete `metric`. These must be expanded
 * before sampling.
 */
export function isUnresolvedCpuMeasurement(
  m: RuntimeMeasurement
): m is CpuMeasurement {
  return m.mode === 'cpu' && !isResolvedCpuMeasurement(m);
}

/**
 * Returns true if a measurement is a "timing" measurement - one that
 * signals when a benchmark has finished its work (callback, an FCP /
 * performance entry, or a polled global expression). CPU measurements
 * are companions that snapshot when all timing measurements in their
 * spec complete; memory and cpu modes are not timing measurements.
 */
export function isTimingMeasurement(m: RuntimeMeasurement): boolean {
  return (
    m.mode === 'callback' ||
    m.mode === 'performance' ||
    m.mode === 'expression'
  );
}

export type CommandLineMeasurements =
  | 'callback'
  | 'fcp'
  | 'global'
  | 'memory'
  | 'cpu';

export const measurements = new Set<string>([
  'callback',
  'fcp',
  'global',
  'memory',
  'cpu',
]);

/**
 * The unit a sample value is expressed in.
 */
export type Unit = 'ms' | 'bytes';

/**
 * Derive the natural unit for a given measurement.
 */
export function unitForMeasurement(measurement: RuntimeMeasurement): Unit {
  return measurement.mode === 'memory' ? 'bytes' : 'ms';
}

/** A specification of a benchmark to run. */
export interface BenchmarkSpec {
  url: LocalUrl | RemoteUrl;
  /**
   * The list of measurements collected from this spec. May contain
   * unresolved {@link MemoryMeasurement} entries when first constructed;
   * the runner expands those into one or more
   * {@link ResolvedMemoryMeasurement} entries during the probe phase
   * before any recorded samples are taken.
   */
  measurement: RuntimeMeasurement[];
  name: string;
  browser: BrowserConfig;
}

export interface LocalUrl {
  kind: 'local';
  version?: PackageVersion;
  urlPath: string;
  queryString: string;
}

export interface RemoteUrl {
  kind: 'remote';
  url: string;
}

// Note: sync with client/src/index.ts
export interface BenchmarkResponse {
  millis: number;
}

/**
 * Benchmark results for a particular measurement on a particular page, across
 * all samples.
 */
export interface BenchmarkResult {
  /**
   * Label for this result. When there is more than one per page, this will
   * contain both the page and measurement labels as "page [measurement]".
   */
  name: string;
  /**
   * The measurement that produced this result
   */
  measurement: RuntimeMeasurement;
  /**
   * A single page can return multiple measurements. The offset into the array
   * of measurements in the spec that this particular result corresponds to.
   */
  measurementIndex: number;
  /**
   * Millisecond measurements for each sample.
   *
   * NOTE: despite the name, when {@link unit} is `'bytes'` this array holds
   * byte values. The name is kept for backward compatibility.
   */
  millis: number[];
  /**
   * The unit the {@link millis} values are expressed in. Derived from
   * {@link measurement.mode}: `'bytes'` for memory measurements, `'ms'`
   * otherwise.
   */
  unit: Unit;
  queryString: string;
  version: string;
  browser: BrowserConfig;
  userAgent: string;
  bytesSent: number;
}
