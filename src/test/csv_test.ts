/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from 'chai';
import {suite, test} from 'mocha';

import {ConfigFile} from '../configfile.js';
import {formatCsvRaw, formatCsvStats} from '../csv.js';
import {fakeResults} from './test_helpers.js';

/**
 * It's hard to visually verify raw CSV output, so this lets us align the
 * columns visually, but then remove that padding before comparison.
 */
const removePadding = (readable: string): string =>
  readable
    .replace(/ *, */g, ',')
    .replace(/ *\n */gm, '\n')
    .trim() + '\n';

suite('csv', () => {
  test('stats: 2x2 matrix with quoting', async () => {
    const config: ConfigFile = {
      benchmarks: [
        {
          name: 'foo',
          url: 'http://example.com?foo',
        },
        {
          name: 'bar,baz',
          url: 'http://example.com?bar,baz',
        },
      ],
    };
    const results = await fakeResults(config);
    const actual = formatCsvStats(results);
    // The "long-form" CSV emits one row per benchmark (with the mean
    // columns populated) plus one row per pairwise comparison against a
    // peer in the same compareKey group.
    const expected = removePadding(`
   benchmark, mean min (ms), mean max (ms), vs benchmark, % change min, % change max, ms change min, ms change max
         foo,       8.56459,      11.43541,             ,             ,             ,              ,
         foo,              ,              ,    "bar,baz",  -58.02419%,  -41.97581%,    -12.02998,    -7.97002
    "bar,baz",      18.56459,      21.43541,             ,             ,             ,              ,
    "bar,baz",              ,              ,          foo,   67.90324%,  132.09676%,      7.97002,     12.02998
    `);
    assert.equal(actual, expected);
  });

  test('raw samples: 2x2 matrix with quoting', async () => {
    const config: ConfigFile = {
      sampleSize: 4,
      benchmarks: [
        {
          name: 'foo',
          url: 'http://example.com?foo',
        },
        {
          name: 'bar,baz',
          url: 'http://example.com?bar,baz',
        },
        {
          name: 'qux',
          url: 'http://example.com?qux',
        },
      ],
    };
    const results = await fakeResults(config);
    const actual = formatCsvRaw(results);
    const expected = removePadding(`
    foo, "bar,baz", qux
    5,   15,        25
    5,   15,        25
    15,  25,        35
    15,  25,        35
    `);
    assert.equal(actual, expected);
  });
});
