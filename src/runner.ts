/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import fsExtra from 'fs-extra';
import * as webdriver from 'selenium-webdriver';

import ProgressBar from 'progress';
import ansi from 'ansi-escape-sequences';

import {jsonOutput, legacyJsonOutput} from './json-output.js';
import {
  browserSignature,
  makeDriver,
  openAndSwitchToNewTab,
} from './browser.js';
import {
  categoryTupleId,
  compileGlob,
  cpuCompareKey,
  enableCpuMetrics,
  captureCpuMetrics,
  measure,
  measurementName,
  memoryAggregateCompareKey,
  memoryCompareKey,
  probeMemoryCategories,
  TRACKED_ATTRIBUTES_LIST,
} from './measure.js';
import type {
  CpuMetricsCache,
  MemoryDumpCache,
  MemoryDumpCategory,
} from './measure.js';
import {
  cpuDefaultMetrics,
  memoryDefaultCategories,
  memoryDefaultMaxAllocatorDepth,
} from './defaults.js';
import {
  AggregatedMemoryMeasurement,
  BenchmarkResult,
  BenchmarkSpec,
  CategoryExcludeRule,
  CategoryIncludeRule,
  CategoryRule,
  isTimingMeasurement,
  isUnresolvedCpuMeasurement,
  isUnresolvedMemoryMeasurement,
  MemoryMeasurement,
  ResolvedCpuMeasurement,
  ResolvedMemoryMeasurement,
  unitForMeasurement,
} from './types.js';
import {formatCsvStats, formatCsvRaw} from './csv.js';
import {
  ResultStatsWithDifferences,
  autoSampleConditionsResolved,
  summaryStats,
  computeDifferences,
} from './stats.js';
import {
  verticalTermResultTable,
  horizontalTermResultTable,
  verticalHtmlResultTable,
  horizontalHtmlResultTable,
  automaticResultTable,
  spinner,
  benchmarkOneLiner,
} from './format.js';
import {Config} from './config.js';
import * as github from './github.js';
import {Server, Session} from './server.js';
import {specUrl} from './specs.js';
import {wait} from './util.js';
import * as pathlib from 'path';

interface Browser {
  name: string;
  driver: webdriver.WebDriver;
  initialTabHandle: string;
}

export class Runner {
  private readonly config: Config;
  private readonly specs: BenchmarkSpec[];
  private readonly servers: Map<BenchmarkSpec, Server>;
  private readonly browsers = new Map<string, Browser>();
  private readonly bar: ProgressBar;
  private readonly results = new Map<BenchmarkSpec, BenchmarkResult[]>();
  /**
   * Captured during {@link probeMemoryAndExpand} for the optional
   * `--memory-categories-file` output. `undefined` when no spec has
   * a memory measurement. Always computed when there's a memory
   * measurement, regardless of whether the user asked for the file -
   * the bookkeeping is cheap and lets us keep the call site simple.
   */
  private memoryCategoriesReport?: MemoryCategoriesReport;

  /**
   * How many times we will load a page and try to collect all measurements
   * before fully failing.
   */
  private readonly maxAttempts = 3;

  /**
   * Maximum milliseconds we will wait for all measurements to be collected per
   * attempt before reloading and trying a new attempt.
   */
  private readonly attemptTimeout = 10000;

  /**
   * How many milliseconds we will wait between each poll for measurements.
   */
  private readonly pollTime = 50;

  private completeGithubCheck?: (markdown: string) => void;
  private hitTimeout = false;

  constructor(config: Config, servers: Map<BenchmarkSpec, Server>) {
    this.config = config;
    this.specs = config.benchmarks;
    this.servers = servers;
    this.bar = new ProgressBar('[:bar] :status', {
      total: this.specs.length * (config.sampleSize + /** warmup */ 1),
      width: 58,
    });
  }

  async run(): Promise<Array<ResultStatsWithDifferences> | undefined> {
    await this.launchBrowsers();
    if (this.config.githubCheck !== undefined) {
      this.completeGithubCheck = await github.createCheck(
        this.config.githubCheck
      );
    }
    console.log('Running benchmarks\n');
    await this.probeMemoryAndExpand();
    this.expandCpuMeasurements();
    await this.warmup();
    await this.takeMinimumSamples();
    await this.takeAdditionalSamples();
    await this.closeBrowsers();
    const results = this.makeResults();
    await this.outputResults(results);
    return results;
  }

  /**
   * For every spec that declares an unresolved `mode:'memory'` measurement,
   * load the page once, capture one memory-infra dump (drained until
   * quiet), and enumerate every `(processRole, allocator, attribute)`
   * tuple present. The discovered tuples are unioned across all such
   * specs and then each spec's measurement array is rewritten **in place**
   * (preserving its object identity, which is used as the
   * `results` map key) so that subsequent warmup / sampling iterates over
   * the concrete resolved measurements.
   *
   * This intentionally runs before {@link warmup} so that no
   * unresolved memory measurement ever reaches the per-sample collection
   * loop in {@link takeSamples}.
   */
  /**
   * Statically expand every unresolved `mode:'cpu'` measurement into one
   * {@link ResolvedCpuMeasurement} per metric in {@link cpuDefaultMetrics},
   * rewriting each spec's `measurement` array **in place** (preserving the
   * spec object identity that keys the `results` map, mirroring
   * {@link probeMemoryAndExpand}).
   *
   * Unlike memory, no page load / probe is needed: the curated CPU metrics
   * are always emitted by Chromium's performance agent once
   * `Performance.enable` succeeds, so the metric set is known statically.
   * Each expanded entry carries its `compareKey` so the stats engine only
   * compares a metric against the same metric across variants.
   */
  private expandCpuMeasurements() {
    for (const spec of this.specs) {
      for (let i = 0; i < spec.measurement.length; i++) {
        const unresolved = spec.measurement[i];
        if (!isUnresolvedCpuMeasurement(unresolved)) {
          continue;
        }
        const expanded: ResolvedCpuMeasurement[] = cpuDefaultMetrics.map(
          (metric) => ({
            mode: 'cpu',
            metric,
            name: unresolved.name,
            compareKey: cpuCompareKey({mode: 'cpu', metric}),
          })
        );
        spec.measurement.splice(i, 1, ...expanded);
        // Skip past the entries we just inserted.
        i += expanded.length - 1;
      }
    }
  }

  private async probeMemoryAndExpand() {
    const {specs, servers, browsers, config} = this;

    // Collect specs that have an unresolved memory entry alongside the
    // matching position in their `measurement` array.
    const probeTargets: Array<{
      spec: BenchmarkSpec;
      memoryIndex: number;
    }> = [];
    for (const spec of specs) {
      const memoryIndex = spec.measurement.findIndex(
        isUnresolvedMemoryMeasurement
      );
      if (memoryIndex >= 0) {
        probeTargets.push({spec, memoryIndex});
      }
    }

    if (probeTargets.length === 0) {
      return;
    }

    type Tuple = MemoryDumpCategory;
    const tupleKey = (t: Tuple) =>
      `${t.processRole}\u0000${t.allocator}\u0000${t.attribute}`;

    const unionedTuples = new Map<string, Tuple>();
    const perSpecProbes: Array<{specName: string; tuples: Tuple[]}> = [];

    for (const {spec, memoryIndex} of probeTargets) {
      const unresolved = spec.measurement[memoryIndex];
      if (!isUnresolvedMemoryMeasurement(unresolved)) {
        // Defensive; shouldn't happen since we just found this index.
        continue;
      }

      const url = specUrl(spec, servers, config);
      const browser = browsers.get(browserSignature(spec.browser));
      if (browser === undefined) {
        throw new Error(
          `Internal error: no browser for spec ${spec.name} during memory probe`
        );
      }
      const {driver, initialTabHandle} = browser;

      await openAndSwitchToNewTab(driver, spec.browser);
      try {
        await driver.get(url);
        const tuples = await probeMemoryCategories(driver, unresolved);
        if (tuples === undefined) {
          throw new Error(
            `Failed to capture a memory-infra dump while probing for ` +
              `benchmark "${spec.name}". The dump never arrived within ` +
              `the internal timeout. Check that the browser is Chromium-` +
              `based and that memory-infra tracing is enabled.`
          );
        }
        if (tuples.length === 0) {
          // The probe succeeded but the dump contained no categories
          // with a known process role. This is unusual - log and continue
          // so the run can still complete (the spec will just produce no
          // memory results).
          console.warn(
            `Memory probe for "${spec.name}" enumerated zero categories. ` +
              `The dump arrived but no process_name metadata was present.`
          );
        }
        perSpecProbes.push({specName: spec.name, tuples});
        for (const t of tuples) {
          unionedTuples.set(tupleKey(t), t);
        }
      } finally {
        // Drop the probe tab and return to the initial blank tab, mirroring
        // takeSamples' cleanup.
        try {
          await driver.close();
        } catch {
          // Best effort.
        }
        try {
          await driver.switchTo().window(initialTabHandle);
        } catch {
          // Best effort.
        }
      }
    }

    // Sort the union deterministically for stable result ordering.
    const sortedTuples = [...unionedTuples.values()].sort((a, b) => {
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

    // Apply the curated rule list baked into tachometer
    // (`memoryDefaultCategories` in src/defaults.ts). It's hard-coded
    // - not user-overridable - so every benchmark in every repo gets
    // the same focused, comparable row set without per-config
    // bikeshedding.
    const bakedCategories = [...memoryDefaultCategories];
    const applyResult = applyCategoryRules(sortedTuples, bakedCategories);
    const expanded = applyResult.expanded;

    // Build the diagnostic report (always, since it's cheap). It's
    // only written to disk if `--memory-categories-file` is set, but
    // the bookkeeping is the same either way.
    this.memoryCategoriesReport = buildMemoryCategoriesReport({
      perSpecProbes,
      unionedTuples: sortedTuples,
      rules: bakedCategories,
      apply: applyResult,
      maxAllocatorDepth:
        (probeTargets[0]?.spec.measurement[probeTargets[0].memoryIndex] as
          | MemoryMeasurement
          | undefined)?.maxAllocatorDepth ?? memoryDefaultMaxAllocatorDepth,
      trackedAttributes: [...TRACKED_ATTRIBUTES_LIST],
    });

    // Rewrite each target spec's measurement array in place. We must NOT
    // replace the BenchmarkSpec object itself, because `results` is keyed
    // by spec identity. Each spec gets a fresh copy of the (identical)
    // expanded list so `pendingMeasurements` Sets in `takeSamples` use
    // distinct object identities and don't collide between specs.
    for (const {spec, memoryIndex} of probeTargets) {
      const unresolved = spec.measurement[memoryIndex];
      if (!isUnresolvedMemoryMeasurement(unresolved)) {
        continue;
      }
      const perSpec = expanded.map((entry) => ({
        ...entry,
        dumpLevel: unresolved.dumpLevel,
        gcBefore: unresolved.gcBefore,
      }));
      // Replace the unresolved entry with the expanded list in place.
      spec.measurement.splice(memoryIndex, 1, ...perSpec);
    }
  }

  private async launchBrowsers() {
    for (const {browser} of this.specs) {
      const sig = browserSignature(browser);
      if (this.browsers.has(sig)) {
        continue;
      }
      this.bar.tick(0, {status: `launching ${browser.name}`});
      // It's important that we execute each benchmark iteration in a new tab.
      // At least in Chrome, each tab corresponds to process which shares some
      // amount of cached V8 state which can cause significant measurement
      // effects. There might even be additional interaction effects that
      // would require an entirely new browser to remove, but experience in
      // Chrome so far shows that new tabs are neccessary and sufficient.
      const driver = await makeDriver(browser);
      const tabs = await driver.getAllWindowHandles();
      // We'll always launch new tabs from this initial blank tab.
      const initialTabHandle = tabs[0];
      this.browsers.set(sig, {name: browser.name, driver, initialTabHandle});
    }
  }

  private async closeBrowsers() {
    // Close the browsers by closing each of their last remaining tabs.
    await Promise.all(
      [...this.browsers.values()].map(({driver}) => driver.close())
    );
  }

  /**
   * Do one throw-away run per benchmark to warm up our server (especially
   * when expensive bare module resolution is enabled), and the browser.
   */
  private async warmup() {
    const {specs, bar} = this;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (
        spec.browser.trace !== undefined &&
        spec.browser.trace.writeLogs !== false
      ) {
        await fsExtra.mkdirp(spec.browser.trace.logDir);
      }

      bar.tick(0, {
        status: `warmup ${i + 1}/${specs.length} ${benchmarkOneLiner(spec)}`,
      });
      await this.takeSamples(spec, 'warmup');
      bar.tick(1);
    }
  }

  private recordSamples(spec: BenchmarkSpec, newResults: BenchmarkResult[]) {
    let specResults = this.results.get(spec);
    if (specResults === undefined) {
      specResults = [];
      this.results.set(spec, specResults);
    }

    // This function is called once per page per sample. The first time this
    // function is called for a page, that result object becomes our "primary"
    // one. On subsequent calls, we accrete the additional sample data into this
    // primary one. The other fields are always the same, so we can just ignore
    // them after the first call.

    // TODO(aomarks) The other fields (user agent, bytes sent, etc.) only need
    // to be collected on the first run of each page, so we could do that in the
    // warmup phase, and then function would only need to take sample data,
    // since it's a bit confusing how we throw away a bunch of fields after the
    // first call.
    for (const newResult of newResults) {
      const primary = specResults[newResult.measurementIndex];
      if (primary === undefined) {
        specResults[newResult.measurementIndex] = newResult;
      } else {
        primary.millis.push(...newResult.millis);
      }
    }
  }

  private async takeMinimumSamples() {
    // Always collect our minimum number of samples.
    const {config, specs, bar} = this;
    const numRuns = specs.length * config.sampleSize;
    const maxLength = config.sampleSize.toString().length;
    let run = 0;
    for (let sample = 0; sample < config.sampleSize; sample++) {
      const sampleLabel = `sample-${sample
        .toString()
        .padStart(maxLength, '0')}`;

      for (const spec of specs) {
        bar.tick(0, {
          status: `${++run}/${numRuns} ${benchmarkOneLiner(spec)}`,
        });
        this.recordSamples(spec, await this.takeSamples(spec, sampleLabel));
        if (bar.curr === bar.total - 1) {
          // Note if we tick with 0 after we've completed, the status is
          // rendered on the next line for some reason.
          bar.tick(1, {status: 'done'});
        } else {
          bar.tick(1);
        }
      }
    }
  }

  private async takeAdditionalSamples() {
    const {config, specs} = this;
    if (config.timeout <= 0) {
      return;
    }
    console.log();
    const timeoutMs = config.timeout * 60 * 1000; // minutes -> millis
    const startMs = Date.now();
    let run = 0;
    let sample = 0;
    let elapsed = 0;
    while (true) {
      if (
        autoSampleConditionsResolved(
          this.makeResults(),
          config.autoSampleConditions
        )
      ) {
        console.log();
        break;
      }
      if (elapsed >= timeoutMs) {
        this.hitTimeout = true;
        break;
      }
      // Run batches of 10 additional samples at a time for more presentable
      // sample sizes, and to nudge sample sizes up a little.
      for (let i = 0; i < 10; i++) {
        sample++;
        for (const spec of specs) {
          run++;
          elapsed = Date.now() - startMs;
          const remainingSecs = Math.max(
            0,
            Math.round((timeoutMs - elapsed) / 1000)
          );
          const mins = Math.floor(remainingSecs / 60);
          const secs = remainingSecs % 60;
          process.stderr.write(
            `\r${spinner[run % spinner.length]} Auto-sample ${sample} ` +
              `(timeout in ${mins}m${secs}s)` +
              ansi.erase.inLine(0)
          );

          const sampleLabel = `auto-sample-${sample
            .toString()
            .padStart(2, '0')}`;
          this.recordSamples(spec, await this.takeSamples(spec, sampleLabel));
        }
      }
    }
  }

  private async takeSamples(
    spec: BenchmarkSpec,
    sampleLabel: string
  ): Promise<BenchmarkResult[]> {
    const {servers, config, browsers} = this;

    let server;
    if (spec.url.kind === 'local') {
      server = servers.get(spec);
      if (server === undefined) {
        throw new Error('Internal error: no server for spec');
      }
    }

    const url = specUrl(spec, servers, config);
    const {driver, initialTabHandle} = browsers.get(
      browserSignature(spec.browser)
    )!;

    let session: Session;
    let pendingMeasurements;
    let measurementResults: number[];
    // Performance-log entries that were consumed by measurements during this
    // attempt (currently only memory measurements drain the log). We hand
    // these to `capturePerfTraces` so they survive when `--trace` and
    // `--measure=memory` are used together.
    //
    // When trace-file writing is off (the common case for `--measure=memory`
    // without `--trace`) we leave this `undefined` so `drainPerformanceLog`
    // skips its accumulator path entirely. Each performance-log entry is a
    // JSON-stringified CDP frame that can be tens to hundreds of KB for a
    // detailed memory-infra dump; with hundreds of events per sample across
    // an auto-sample run, keeping them all in heap pushed Node past its
    // default 8 GB ceiling on large workloads.
    const writeTraceLogs =
      spec.browser.trace !== undefined &&
      spec.browser.trace.writeLogs !== false;
    let consumedPerfLog: webdriver.logging.Entry[] | undefined = writeTraceLogs
      ? []
      : undefined;
    // Shared between all memory measurements in this attempt so that one
    // Tracing.requestMemoryDump is issued per sample even if the spec asks
    // for multiple memory metrics (one dump contains every allocator).
    let memoryDumpCache: MemoryDumpCache = {};
    // Shared between all cpu measurements in this attempt. The baseline is
    // captured once after navigation and the end snapshot once after the
    // timing companion(s) complete; every per-metric cpu row reads its
    // delta from this one pair of snapshots.
    let cpuMetricsCache: CpuMetricsCache = {};
    // Whether this spec has any cpu measurement, gating the per-attempt
    // Performance.enable + baseline capture.
    const hasCpu = spec.measurement.some((m) => m.mode === 'cpu');

    // We'll try N attempts per page. Within each attempt, we'll try to collect
    // all of the measurements by polling. If we hit our per-attempt timeout
    // before collecting all measurements, we'll move onto the next attempt
    // where we reload the whole page and start from scratch. If we hit our max
    // attempts, we'll throw.
    for (let pageAttempt = 1; ; pageAttempt++) {
      // New attempt. Reset all measurements and results.
      pendingMeasurements = new Set(spec.measurement);
      measurementResults = [];
      consumedPerfLog = writeTraceLogs ? [] : undefined;
      memoryDumpCache = {};
      cpuMetricsCache = {};
      await openAndSwitchToNewTab(driver, spec.browser);
      await driver.get(url);
      if (hasCpu) {
        // Enable CPU-time metrics and capture the baseline counter
        // snapshot. We do this *after* navigation: an about:blank -> page
        // navigation can swap the renderer process (resetting the
        // cumulative counters), so post-navigation is the only point we
        // know we're on the final renderer. `enableCpuMetrics` throws on
        // platforms where thread-time metrics are unsupported - that fires
        // here on the first attempt, failing the run fast and clearly.
        await enableCpuMetrics(driver);
        cpuMetricsCache.baseline = await captureCpuMetrics(driver);
      }
      for (
        let waited = 0;
        pendingMeasurements.size > 0 && waited <= this.attemptTimeout;
        waited += this.pollTime
      ) {
        // TODO(aomarks) You don't have to wait in callback mode!
        await wait(this.pollTime);
        // Pass 1: every non-cpu measurement (timing + memory). These define
        // their own completion; cpu is a companion that snapshots only once
        // they're done.
        for (
          let measurementIndex = 0;
          measurementIndex < spec.measurement.length;
          measurementIndex++
        ) {
          const measurement = spec.measurement[measurementIndex];
          if (measurement.mode === 'cpu') {
            continue;
          }
          if (measurementResults[measurementIndex] !== undefined) {
            // Already collected this measurement on this attempt.
            continue;
          }
          const result = await measure(
            driver,
            measurement,
            server,
            consumedPerfLog,
            memoryDumpCache,
            cpuMetricsCache
          );
          if (result !== undefined) {
            measurementResults[measurementIndex] = result;
            pendingMeasurements.delete(measurement);
          }
        }
        // Pass 2: cpu measurements, but only once no *timing* measurement is
        // still pending. This guarantees the cpu `end` snapshot is taken on
        // the same poll tick the timing companion resolves, regardless of
        // the order measurements appear in the array. (Memory measurements
        // are not part of this gate, and a cpu spec is validated to never
        // contain a memory measurement.)
        const timingPending = [...pendingMeasurements].some(
          isTimingMeasurement
        );
        if (!timingPending) {
          for (
            let measurementIndex = 0;
            measurementIndex < spec.measurement.length;
            measurementIndex++
          ) {
            const measurement = spec.measurement[measurementIndex];
            if (measurement.mode !== 'cpu') {
              continue;
            }
            if (measurementResults[measurementIndex] !== undefined) {
              continue;
            }
            const result = await measure(
              driver,
              measurement,
              server,
              consumedPerfLog,
              memoryDumpCache,
              cpuMetricsCache
            );
            if (result !== undefined) {
              measurementResults[measurementIndex] = result;
              pendingMeasurements.delete(measurement);
            }
          }
        }
      }

      await this.capturePerfTraces(
        spec,
        driver,
        sampleLabel,
        consumedPerfLog ?? []
      );

      // Close the active tab (but not the whole browser, since the
      // initial blank tab is still open).
      await driver.close();
      await driver.switchTo().window(initialTabHandle);

      if (server !== undefined) {
        session = server.endSession();
      }

      if (pendingMeasurements.size === 0 || pageAttempt >= this.maxAttempts) {
        break;
      }

      console.log(
        `\n\nFailed ${pageAttempt}/${this.maxAttempts} times ` +
          `to get measurement(s) ${spec.name}` +
          (spec.measurement.length > 1
            ? ` [${[...pendingMeasurements].map(measurementName).join(', ')}]`
            : '') +
          ` in ${spec.browser.name} from ${url}. Retrying.`
      );
    }

    if (pendingMeasurements.size > 0) {
      console.log();
      throw new Error(
        `\n\nFailed ${this.maxAttempts}/${this.maxAttempts} times ` +
          `to get measurement(s) ${spec.name}` +
          (spec.measurement.length > 1
            ? ` [${[...pendingMeasurements].map(measurementName).join(', ')}]`
            : '') +
          ` in ${spec.browser.name} from ${url}`
      );
    }

    return spec.measurement.map((measurement, measurementIndex) => ({
      name:
        spec.measurement.length === 1
          ? spec.name
          : `${spec.name} [${measurementName(measurement)}]`,
      measurement,
      measurementIndex: measurementIndex,
      queryString: spec.url.kind === 'local' ? spec.url.queryString : '',
      version:
        spec.url.kind === 'local' && spec.url.version !== undefined
          ? spec.url.version.label
          : '',
      millis: [measurementResults[measurementIndex]],
      unit: unitForMeasurement(measurement),
      bytesSent: session ? session.bytesSent : 0,
      browser: spec.browser,
      userAgent: session ? session.userAgent : '',
    }));
  }

  async capturePerfTraces(
    spec: BenchmarkSpec,
    driver: webdriver.WebDriver,
    sampleLabel: string,
    alreadyConsumed: webdriver.logging.Entry[] = []
  ) {
    if (
      spec.browser.trace === undefined ||
      spec.browser.trace.writeLogs === false
    ) {
      return;
    }

    // Start from any entries that were already drained from the performance
    // log by a measurement (e.g. memory). Those entries are unavailable for a
    // second `logs().get('performance')` call, so without this the trace file
    // would be missing all events that arrived during the measurement window.
    let perfEntries: webdriver.logging.Entry[] = [...alreadyConsumed];
    let newPerfEntries: webdriver.logging.Entry[];
    do {
      newPerfEntries = await driver.manage().logs().get('performance');
      perfEntries = perfEntries.concat(newPerfEntries);
    } while (newPerfEntries.length > 0);

    const logDir = spec.browser.trace.logDir;
    await fsExtra.writeFile(
      pathlib.join(logDir, `log-${sampleLabel}.json`),
      // Convert perf logs into a format about:tracing can parse
      '[\n' +
        perfEntries
          .map((e) => JSON.parse(e.message).message)
          .filter((log) => log.method === 'Tracing.dataCollected')
          .map((log) => JSON.stringify(log.params))
          .join(',\n') +
        '\n]',
      'utf8'
    );
  }

  makeResults() {
    const resultStats = [];
    for (const results of this.results.values()) {
      for (let r = 0; r < results.length; r++) {
        const result = results[r];
        resultStats.push({result, stats: summaryStats(result.millis)});
      }
    }
    return computeDifferences(resultStats);
  }

  private async outputResults(withDifferences: ResultStatsWithDifferences[]) {
    const {config, hitTimeout} = this;
    console.log();

    // With auto-discovered memory measurements, a single run can produce
    // tens of thousands of result rows (variants x discovered tuples). The
    // terminal table library can't lay out that many rows in reasonable
    // time, and even if it could, the output would be unreadable. We
    // always write the full result set to the configured JSON / CSV /
    // legacy / HTML outputs, but for the terminal table we only render
    // the rows where some peer comparison shows the largest absolute
    // change. The rest are still in the on-disk artifacts.
    const TERMINAL_RENDER_LIMIT = 50;
    const truncated = withDifferences.length > TERMINAL_RENDER_LIMIT;
    let renderedResults: ResultStatsWithDifferences[] = withDifferences;
    if (truncated) {
      const interestingness = (r: ResultStatsWithDifferences): number => {
        let max = 0;
        for (const diff of r.differences.values()) {
          const absMax = Math.max(
            Math.abs(diff.absolute.low),
            Math.abs(diff.absolute.high)
          );
          if (absMax > max) max = absMax;
        }
        return max;
      };
      renderedResults = [...withDifferences]
        .sort((a, b) => interestingness(b) - interestingness(a))
        .slice(0, TERMINAL_RENDER_LIMIT);
    }

    const {fixed, unfixed} = automaticResultTable(withDifferences);
    // Render the fixed table using the full set (it just shows shared
    // dimensions like browser version, so it doesn't get bigger with
    // more rows).
    console.log(horizontalTermResultTable(fixed));
    // Render only a subset of rows in the unfixed table to keep the
    // terminal output manageable. The closures inside `unfixed.dimensions`
    // were built against the full `withDifferences` array so that peer
    // lookups via the sparse `differences` Map's indices still resolve
    // correctly even when only some rows are actually rendered.
    const truncatedTable = truncated
      ? {dimensions: unfixed.dimensions, results: renderedResults}
      : unfixed;
    console.log(verticalTermResultTable(truncatedTable));

    if (truncated) {
      console.log(
        ansi.format(
          `[bold yellow]{NOTE} Showing the ${TERMINAL_RENDER_LIMIT} ` +
            `result rows with the largest absolute changes; ` +
            `${withDifferences.length - TERMINAL_RENDER_LIMIT} ` +
            `more rows are available in the JSON / CSV outputs.`
        )
      );
    }

    if (hitTimeout === true) {
      console.log(
        ansi.format(
          `[bold red]{NOTE} Hit ${config.timeout} minute auto-sample timeout` +
            ` trying to resolve condition(s)`
        )
      );
      console.log(
        'Consider a longer --timeout or different --auto-sample-conditions'
      );
    }

    if (config.jsonFile) {
      const json = await jsonOutput(withDifferences);
      await fsExtra.writeJSON(config.jsonFile, json, {spaces: 2});
    }

    // TOOD(aomarks) Remove this in next major version.
    if (config.legacyJsonFile) {
      const json = await legacyJsonOutput(withDifferences.map((s) => s.result));
      await fsExtra.writeJSON(config.legacyJsonFile, json);
    }

    if (config.csvFileStats) {
      await fsExtra.writeFile(
        config.csvFileStats,
        formatCsvStats(withDifferences)
      );
    }
    if (config.csvFileRaw) {
      await fsExtra.writeFile(config.csvFileRaw, formatCsvRaw(withDifferences));
    }

    if (
      config.memoryCategoriesFile &&
      this.memoryCategoriesReport !== undefined
    ) {
      await fsExtra.writeJSON(
        config.memoryCategoriesFile,
        this.memoryCategoriesReport,
        {spaces: 2}
      );
    }

    if (this.completeGithubCheck !== undefined) {
      const markdown =
        horizontalHtmlResultTable(fixed) +
        '\n' +
        verticalHtmlResultTable(unfixed);
      await this.completeGithubCheck(markdown);
    }
  }
}

/**
 * Apply a `MemoryMeasurement.categories` rule list to a sorted set of
 * probe-discovered tuples. Returns the expanded list of resolved /
 * aggregated measurement entries that should replace the unresolved
 * `mode:'memory'` entry in every spec.
 *
 * Filter-then-emit semantics: every `exclude` rule applies first to
 * the candidate set; then each `include` rule scans the filtered set
 * and emits one resolved row per match (or one aggregated row when
 * `sumAs` is set).
 *
 * Throws on:
 * - `include` matching zero tuples (unless the rule is `optional`).
 * - `sumAs` with mixed attributes (can't sum bytes-style `size` with
 *   bytes-style `effective_size`).
 * - `sumAs` whose matched allocators have parent-child overlap
 *   within a role (would double-count).
 * - Duplicate `sumAs` names across rules.
 */
/**
 * Apply a `MemoryMeasurement.categories` rule list to a sorted set of
 * probe-discovered tuples. Returns both the expanded list of resolved /
 * aggregated measurement entries that should replace the unresolved
 * `mode:'memory'` entry in every spec AND bookkeeping for the optional
 * memory-categories report (which tuples were dropped, which excludes
 * matched, etc.).
 *
 * Filter-then-emit semantics: every `exclude` rule applies first to
 * the candidate set; then each `include` rule scans the filtered set
 * and emits one resolved row per match (or one aggregated row when
 * `sumAs` is set).
 *
 * Throws on:
 * - `include` matching zero tuples (unless the rule is `optional`).
 * - `sumAs` with mixed attributes (can't sum bytes-style `size` with
 *   bytes-style `effective_size`).
 * - `sumAs` whose matched allocators have parent-child overlap
 *   within a role (would double-count).
 * - Duplicate `sumAs` names across rules.
 */
export interface CategoryApplyResult {
  /** The measurement entries to splice into each spec. */
  expanded: Array<ResolvedMemoryMeasurement | AggregatedMemoryMeasurement>;
  /**
   * Per-`exclude`-rule list of tuples that the pattern matched. Each
   * tuple id is the `<role>:<allocator>.<attribute>` string. Sorted.
   */
  excludedByRule: Array<{pattern: string; tuples: string[]}>;
  /**
   * `include` rules that matched zero tuples but were `optional: true`
   * so they were silently skipped. Just the include patterns, for
   * surfacing in the report as a hint to the user.
   */
  optionalNoMatchPatterns: string[];
  /**
   * Sorted union of every probe-discovered tuple id that:
   * - was not removed by any `exclude` rule, AND
   * - did not match any `include` rule (after filtering).
   *
   * The bucket the user most often wants to read - "what am I
   * missing?". Empty when `categories` is unset (every tuple becomes
   * a tuple row by default).
   */
  droppedNoMatch: string[];
}

function applyCategoryRules(
  tuples: MemoryDumpCategory[],
  rules: CategoryRule[]
): CategoryApplyResult {
  // Validate `sumAs` uniqueness up front.
  const seenSumAs = new Set<string>();
  for (const rule of rules) {
    if ('include' in rule && rule.sumAs !== undefined) {
      if (seenSumAs.has(rule.sumAs)) {
        throw new Error(
          `Duplicate \`sumAs\` name in memory \`categories\`: ` +
            `"${rule.sumAs}". Each aggregate rule must have a unique name.`
        );
      }
      seenSumAs.add(rule.sumAs);
    }
  }

  // Filter pass: apply every exclude rule to the candidate set.
  // Track per-rule matches for the report.
  const excludeRules = rules.filter(
    (r): r is CategoryExcludeRule => 'exclude' in r
  );
  const excludedByRule: Array<{pattern: string; tuples: string[]}> = [];
  const excludedTupleIds = new Set<string>();
  for (const rule of excludeRules) {
    const rx = compileGlob(rule.exclude);
    const matched = tuples
      .filter((t) => rx.test(categoryTupleId(t)))
      .map((t) => categoryTupleId(t))
      .sort();
    excludedByRule.push({pattern: rule.exclude, tuples: matched});
    for (const id of matched) excludedTupleIds.add(id);
  }
  const candidates = tuples.filter(
    (t) => !excludedTupleIds.has(categoryTupleId(t))
  );

  // Include pass: each rule emits zero or more entries.
  const emitted: Array<
    ResolvedMemoryMeasurement | AggregatedMemoryMeasurement
  > = [];
  const emittedTupleKeys = new Set<string>(); // dedupe bare-include tuple rows
  const optionalNoMatchPatterns: string[] = [];
  // Track which candidate tuples got picked up by some include rule (as
  // a tuple row OR as a source for an aggregate). Anything left over
  // after the include pass goes to `droppedNoMatch`.
  const includedTupleIds = new Set<string>();
  const includeRules = rules.filter(
    (r): r is CategoryIncludeRule => 'include' in r
  );
  for (const rule of includeRules) {
    const rx = compileGlob(rule.include);
    const matches = candidates.filter((t) => rx.test(categoryTupleId(t)));
    if (matches.length === 0) {
      if (rule.optional) {
        optionalNoMatchPatterns.push(rule.include);
        continue;
      }
      throw new Error(
        `Memory category rule include="${rule.include}" matched zero ` +
          `probe-discovered tuples. Set \`optional: true\` if this is ` +
          `intentional, or fix the pattern.`
      );
    }
    for (const m of matches) {
      includedTupleIds.add(categoryTupleId(m));
    }
    if (rule.sumAs !== undefined) {
      // Aggregation: enforce single-attribute and no parent-child overlap.
      const attrs = new Set(matches.map((m) => m.attribute));
      if (attrs.size > 1) {
        throw new Error(
          `Memory category rule \`sumAs: "${rule.sumAs}"\` matched ` +
            `multiple attributes (${[...attrs].sort().join(', ')}). ` +
            `Aggregates must match a single attribute - the sum of, ` +
            `say, \`size\` and \`effective_size\` is not a meaningful ` +
            `number. Narrow the pattern (e.g. append \`.size\`).`
        );
      }
      const attribute = matches[0].attribute;
      // Check for parent-child overlap WITHIN each role independently.
      // A parent/child pair across different roles is fine because the
      // dumps come from different processes.
      const byRole = new Map<string, string[]>();
      for (const m of matches) {
        let list = byRole.get(m.processRole);
        if (list === undefined) {
          list = [];
          byRole.set(m.processRole, list);
        }
        list.push(m.allocator);
      }
      for (const [role, allocs] of byRole) {
        for (const a of allocs) {
          for (const b of allocs) {
            if (a === b) continue;
            if (b.startsWith(a + '/')) {
              throw new Error(
                `Memory category rule \`sumAs: "${rule.sumAs}"\` matched ` +
                  `both a parent allocator and a descendant for ` +
                  `process role "${role}" (parent: "${a}", child: ` +
                  `"${b}"). Memory-infra reports the parent as the sum ` +
                  `of its children, so including both would double-count. ` +
                  `Narrow the pattern (e.g. exclude the parent or the ` +
                  `child sub-tree).`
              );
            }
          }
        }
      }
      const agg: AggregatedMemoryMeasurement = {
        mode: 'memory',
        sumAs: rule.sumAs,
        attribute,
        sources: matches
          .map((m) => ({processRole: m.processRole, allocator: m.allocator}))
          .sort((x, y) => {
            if (x.processRole !== y.processRole) {
              return x.processRole < y.processRole ? -1 : 1;
            }
            return x.allocator < y.allocator ? -1 : 1;
          }),
        compareKey: memoryAggregateCompareKey({
          mode: 'memory',
          sumAs: rule.sumAs,
          attribute,
          sources: [],
        }),
      };
      emitted.push(agg);
    } else {
      // Bare include: emit one resolved row per match, deduped.
      for (const m of matches) {
        const key = `${m.processRole}\u0000${m.allocator}\u0000${m.attribute}`;
        if (emittedTupleKeys.has(key)) continue;
        emittedTupleKeys.add(key);
        const resolved: ResolvedMemoryMeasurement = {
          mode: 'memory',
          processRole: m.processRole,
          allocator: m.allocator,
          attribute: m.attribute,
          compareKey: memoryCompareKey({
            mode: 'memory',
            processRole: m.processRole,
            allocator: m.allocator,
            attribute: m.attribute,
          }),
        };
        emitted.push(resolved);
      }
    }
  }

  // Whatever's left in `candidates` after include matching is the
  // "dropped" bucket - tuples the probe discovered, that survived
  // every `exclude`, but didn't match any `include`.
  const droppedNoMatch = candidates
    .map((t) => categoryTupleId(t))
    .filter((id) => !includedTupleIds.has(id))
    .sort();

  return {
    expanded: emitted,
    excludedByRule,
    optionalNoMatchPatterns,
    droppedNoMatch,
  };
}

/**
 * The on-disk shape of `--memory-categories-file`. A diagnostic
 * artifact intended for humans iterating on their `categories`
 * config; intentionally NOT keyed off the compareKey strings that the
 * main stats output uses (those are an implementation detail).
 *
 * See the "Memory > User-defined categories" section of the README
 * for how to read this file and adjust a config based on it.
 */
export interface MemoryCategoriesReport {
  /**
   * The focused-default filters that ran before user `categories`
   * rules. Useful context for "why is X not in `discovered`?".
   */
  config: {
    maxAllocatorDepth: number;
    trackedAttributes: string[];
  };
  /**
   * What memory-infra emitted during the probe phase, after the
   * focused-default filters but before any user `categories` rules.
   */
  discovered: {
    /** Size of the union across every spec's probe. */
    count: number;
    /**
     * Per-spec discovery counts (spec name → count). Lets the user
     * see e.g. "renderer on large.html discovered 158 tuples vs
     * small.html's 142".
     */
    perSpec: Record<string, number>;
    /** Sorted union of every discovered tuple's ID. */
    tuples: string[];
  };
  /** Whether the user supplied `categories` rules at all. */
  rules: {
    configured: boolean;
    /** Shape counts of the rule list. All zero when `configured: false`. */
    summary: {
      include: number;
      exclude: number;
      aggregate: number;
    };
  };
  /** What the rule application produced (or default auto-discovery). */
  output: {
    /** Tuple-form result rows (`memory:tuple:` compareKey prefix). */
    tupleRows: string[];
    /** Aggregate result rows (`memory:sum:` compareKey prefix). */
    aggregateRows: Array<{
      sumAs: string;
      rule: string;
      attribute: string;
      /** Sorted source tuple IDs that contribute to the sum. */
      sources: string[];
    }>;
  };
  /**
   * Tuples removed by `exclude` rules. Per-rule for sanity-checking
   * patterns; all empty when no `exclude` rules were declared.
   */
  excludedByRule: Array<{pattern: string; tuples: string[]}>;
  /**
   * Tuples that survived `exclude` filtering but matched no `include`
   * rule. The bucket the user most often wants to read - "what am I
   * missing?". Empty when `categories` is unset (every tuple becomes
   * a tuple row by default).
   */
  droppedNoMatch: string[];
  /**
   * `include` patterns with `optional: true` that matched zero
   * probe-discovered tuples. Informational - they were silently
   * skipped, but listing them here flags potential typos or
   * platform/version drift.
   */
  optionalRulesWithNoMatches: string[];
}

/**
 * Synthesise the diagnostic JSON written to
 * `--memory-categories-file`. Pure function so it's easy to unit-test
 * with synthetic probe data.
 */
export function buildMemoryCategoriesReport(args: {
  /** Probe-time per-spec tuple lists, in probe order. */
  perSpecProbes: Array<{specName: string; tuples: MemoryDumpCategory[]}>;
  /** The union of probed tuples, sorted. */
  unionedTuples: MemoryDumpCategory[];
  /** The category rules the user declared (`undefined` if none). */
  rules: CategoryRule[] | undefined;
  /** The result of {@link applyCategoryRules}, or `undefined` for auto-discovery. */
  apply: CategoryApplyResult | undefined;
  /** Focused-default filters (always recorded for context). */
  maxAllocatorDepth: number;
  trackedAttributes: string[];
}): MemoryCategoriesReport {
  const ruleList = args.rules ?? [];
  const summary = {
    include: 0,
    exclude: 0,
    aggregate: 0,
  };
  for (const r of ruleList) {
    if ('include' in r) {
      summary.include++;
      if (r.sumAs !== undefined) summary.aggregate++;
    } else {
      summary.exclude++;
    }
  }

  let tupleRows: string[];
  let aggregateRows: MemoryCategoriesReport['output']['aggregateRows'];
  let excludedByRule: MemoryCategoriesReport['excludedByRule'];
  let droppedNoMatch: string[];
  let optionalRulesWithNoMatches: string[];

  if (args.apply === undefined) {
    // Default auto-discovery: every discovered tuple becomes a row.
    tupleRows = args.unionedTuples.map((t) => categoryTupleId(t)).sort();
    aggregateRows = [];
    excludedByRule = [];
    droppedNoMatch = [];
    optionalRulesWithNoMatches = [];
  } else {
    tupleRows = args.apply.expanded
      .filter((e): e is ResolvedMemoryMeasurement => 'allocator' in e)
      .map((e) => `${e.processRole}:${e.allocator}.${e.attribute}`)
      .sort();
    // Pair each aggregated entry with its originating rule (matched
    // by sumAs name, which we've already validated as unique).
    const aggByName = new Map<string, AggregatedMemoryMeasurement>();
    for (const e of args.apply.expanded) {
      if ('sources' in e) aggByName.set(e.sumAs, e);
    }
    aggregateRows = ruleList
      .filter((r): r is CategoryIncludeRule => 'include' in r && !!r.sumAs)
      .map((r) => {
        const agg = aggByName.get(r.sumAs!);
        if (agg === undefined) {
          // Aggregate rule matched zero tuples and was optional;
          // skip in the output rows (it's listed in
          // optionalRulesWithNoMatches instead).
          return undefined;
        }
        return {
          sumAs: agg.sumAs,
          rule: r.include,
          attribute: agg.attribute,
          sources: agg.sources
            .map((s) => `${s.processRole}:${s.allocator}.${agg.attribute}`)
            .sort(),
        };
      })
      .filter(
        (
          x
        ): x is {
          sumAs: string;
          rule: string;
          attribute: string;
          sources: string[];
        } => x !== undefined
      );
    excludedByRule = args.apply.excludedByRule;
    droppedNoMatch = args.apply.droppedNoMatch;
    optionalRulesWithNoMatches = args.apply.optionalNoMatchPatterns;
  }

  const perSpec: Record<string, number> = {};
  for (const p of args.perSpecProbes) {
    perSpec[p.specName] = p.tuples.length;
  }

  return {
    config: {
      maxAllocatorDepth: args.maxAllocatorDepth,
      trackedAttributes: args.trackedAttributes,
    },
    discovered: {
      count: args.unionedTuples.length,
      perSpec,
      tuples: args.unionedTuples.map((t) => categoryTupleId(t)).sort(),
    },
    rules: {
      configured: args.rules !== undefined,
      summary,
    },
    output: {
      tupleRows,
      aggregateRows,
    },
    excludedByRule,
    droppedNoMatch,
    optionalRulesWithNoMatches,
  };
}
