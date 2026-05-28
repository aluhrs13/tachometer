/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from 'chai';
import {suite, test} from 'mocha';

import {buildMemoryCategoriesReport} from '../runner.js';
import type {MemoryDumpCategory} from '../measure.js';

const tuple = (
  processRole: string,
  allocator: string,
  attribute: string
): MemoryDumpCategory => ({processRole, allocator, attribute});

const DEFAULTS = {
  maxAllocatorDepth: 3,
  trackedAttributes: [
    'size',
    'effective_size',
    'peak_resident_set_size',
    'private_footprint_bytes',
    'resident_set_bytes',
  ],
};

suite('buildMemoryCategoriesReport', () => {
  test('auto-discovery default: tupleRows is the discovered union', () => {
    const tuples = [
      tuple('renderer', 'v8', 'size'),
      tuple('renderer', 'malloc', 'size'),
      tuple('browser', 'malloc', 'size'),
    ];
    const report = buildMemoryCategoriesReport({
      perSpecProbes: [
        {specName: 'small', tuples},
        {specName: 'large', tuples},
      ],
      unionedTuples: tuples,
      rules: undefined,
      apply: undefined,
      ...DEFAULTS,
    });
    assert.equal(report.discovered.count, 3);
    assert.deepEqual(report.discovered.perSpec, {small: 3, large: 3});
    assert.deepEqual(report.discovered.tuples, [
      'browser:malloc.size',
      'renderer:malloc.size',
      'renderer:v8.size',
    ]);
    assert.isFalse(report.rules.configured);
    assert.deepEqual(report.rules.summary, {
      include: 0,
      exclude: 0,
      aggregate: 0,
    });
    assert.deepEqual(report.output.tupleRows, [
      'browser:malloc.size',
      'renderer:malloc.size',
      'renderer:v8.size',
    ]);
    assert.deepEqual(report.output.aggregateRows, []);
    assert.deepEqual(report.excludedByRule, []);
    assert.deepEqual(report.droppedNoMatch, []);
    assert.deepEqual(report.optionalRulesWithNoMatches, []);
  });

  test('include + sumAs + exclude + dropped (all rule kinds)', () => {
    const tuples = [
      tuple('renderer', 'v8', 'size'),
      tuple('renderer', 'malloc', 'size'),
      tuple('renderer', 'cc/tile_manager_0', 'size'),
      tuple('service: foo', 'malloc', 'size'),
      tuple('service: bar', 'malloc', 'size'),
    ];
    const rules = [
      {include: 'renderer:v8.size'},
      {exclude: 'renderer:cc/tile_manager_*'},
      {include: 'service: *:malloc.size', sumAs: 'all-services-malloc'},
    ];
    // Synthetic apply result that mirrors what applyCategoryRules
    // would produce. The report builder is pure - it doesn't re-run
    // the rules, just renders them.
    const apply = {
      expanded: [
        {
          mode: 'memory' as const,
          processRole: 'renderer',
          allocator: 'v8',
          attribute: 'size',
          compareKey: 'memory:tuple:renderer:v8.size',
        },
        {
          mode: 'memory' as const,
          sumAs: 'all-services-malloc',
          attribute: 'size',
          sources: [
            {processRole: 'service: bar', allocator: 'malloc'},
            {processRole: 'service: foo', allocator: 'malloc'},
          ],
          compareKey: 'memory:sum:all-services-malloc',
        },
      ],
      excludedByRule: [
        {
          pattern: 'renderer:cc/tile_manager_*',
          tuples: ['renderer:cc/tile_manager_0.size'],
        },
      ],
      optionalNoMatchPatterns: [],
      droppedNoMatch: ['renderer:malloc.size'],
    };
    const report = buildMemoryCategoriesReport({
      perSpecProbes: [{specName: 'only', tuples}],
      unionedTuples: tuples,
      rules,
      apply,
      ...DEFAULTS,
    });
    assert.isTrue(report.rules.configured);
    assert.deepEqual(report.rules.summary, {
      include: 2,
      exclude: 1,
      aggregate: 1,
    });
    assert.deepEqual(report.output.tupleRows, ['renderer:v8.size']);
    assert.deepEqual(report.output.aggregateRows, [
      {
        sumAs: 'all-services-malloc',
        rule: 'service: *:malloc.size',
        attribute: 'size',
        sources: ['service: bar:malloc.size', 'service: foo:malloc.size'],
      },
    ]);
    assert.deepEqual(report.excludedByRule, [
      {
        pattern: 'renderer:cc/tile_manager_*',
        tuples: ['renderer:cc/tile_manager_0.size'],
      },
    ]);
    assert.deepEqual(report.droppedNoMatch, ['renderer:malloc.size']);
  });

  test('optional rules with no matches are listed (not errors)', () => {
    const tuples = [tuple('renderer', 'v8', 'size')];
    const rules = [
      {include: 'renderer:v8.size'},
      {include: 'gpu:never-existed.size', optional: true},
    ];
    const apply = {
      expanded: [
        {
          mode: 'memory' as const,
          processRole: 'renderer',
          allocator: 'v8',
          attribute: 'size',
          compareKey: 'memory:tuple:renderer:v8.size',
        },
      ],
      excludedByRule: [],
      optionalNoMatchPatterns: ['gpu:never-existed.size'],
      droppedNoMatch: [],
    };
    const report = buildMemoryCategoriesReport({
      perSpecProbes: [{specName: 'one', tuples}],
      unionedTuples: tuples,
      rules,
      apply,
      ...DEFAULTS,
    });
    assert.deepEqual(report.optionalRulesWithNoMatches, [
      'gpu:never-existed.size',
    ]);
    assert.deepEqual(report.output.aggregateRows, []);
  });

  test('records per-spec discovery counts when specs differ', () => {
    const smallTuples = [
      tuple('renderer', 'v8', 'size'),
      tuple('renderer', 'malloc', 'size'),
    ];
    const largeTuples = [
      ...smallTuples,
      tuple('gpu process', 'malloc', 'size'),
    ];
    const union = largeTuples; // gpu is only in large but unioned across both.
    const report = buildMemoryCategoriesReport({
      perSpecProbes: [
        {specName: 'small', tuples: smallTuples},
        {specName: 'large', tuples: largeTuples},
      ],
      unionedTuples: union,
      rules: undefined,
      apply: undefined,
      ...DEFAULTS,
    });
    assert.equal(report.discovered.count, 3);
    assert.deepEqual(report.discovered.perSpec, {small: 2, large: 3});
  });

  test('records focused-default filter config for context', () => {
    const report = buildMemoryCategoriesReport({
      perSpecProbes: [],
      unionedTuples: [],
      rules: undefined,
      apply: undefined,
      maxAllocatorDepth: 5,
      trackedAttributes: ['size', 'object_count'],
    });
    assert.equal(report.config.maxAllocatorDepth, 5);
    assert.deepEqual(report.config.trackedAttributes, ['size', 'object_count']);
  });
});
