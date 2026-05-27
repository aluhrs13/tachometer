/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from 'chai';
import {suite, suiteSetup, suiteTeardown, test} from 'mocha';

import {Config, makeConfig, parseAutoSampleConditions} from '../config.js';
import {parseFlags} from '../flags.js';

import {testData} from './test_helpers.js';

suite('makeConfig', function () {
  let prevCwd: string;

  suiteSetup(() => {
    prevCwd = process.cwd();
    process.chdir(testData);
  });

  suiteTeardown(() => {
    process.chdir(prevCwd);
  });

  async function checkConfig(argv: string[], expected: Config) {
    const actual = await makeConfig(parseFlags(argv));
    assert.deepEqual(actual, expected);
  }

  test('local file with all defaults', async () => {
    const argv = ['random-global.html'];
    const expected: Config = {
      mode: 'automatic',
      npmrc: '',
      sampleSize: 50,
      timeout: 3,
      root: '.',
      resolveBareModules: true,
      forceCleanNpmInstall: false,
      autoSampleConditions: {absolute: {ms: [], bytes: []}, relative: [0]},
      remoteAccessibleHost: '',
      jsonFile: '',
      legacyJsonFile: '',
      csvFileStats: '',
      csvFileRaw: '',
      githubCheck: undefined,
      benchmarks: [
        {
          browser: {
            headless: false,
            name: 'chrome',
            windowSize: {
              height: 768,
              width: 1024,
            },
          },
          measurement: [
            {
              mode: 'callback',
            },
          ],
          name: 'random-global.html',
          url: {
            kind: 'local',
            queryString: '',
            urlPath: '/random-global.html',
            version: undefined,
          },
        },
      ],
    };
    await checkConfig(argv, expected);
  });

  test('config file', async () => {
    const argv = ['--config=random-global.json'];
    const expected: Config = {
      mode: 'automatic',
      npmrc: '',
      sampleSize: 50,
      timeout: 3,
      root: testData,
      resolveBareModules: true,
      forceCleanNpmInstall: false,
      autoSampleConditions: {absolute: {ms: [], bytes: []}, relative: [0]},
      remoteAccessibleHost: '',
      jsonFile: '',
      legacyJsonFile: '',
      csvFileStats: '',
      csvFileRaw: '',
      // TODO(aomarks) Be consistent about undefined vs unset.
      githubCheck: undefined,
      benchmarks: [
        {
          browser: {
            headless: false,
            name: 'chrome',
            windowSize: {
              height: 768,
              width: 1024,
            },
          },
          measurement: [
            {
              mode: 'callback',
            },
          ],
          // TODO(aomarks) Why does this have a forward-slash?
          name: '/random-global.html',
          url: {
            kind: 'local',
            queryString: '',
            urlPath: '/random-global.html',
          },
        },
      ],
    };
    await checkConfig(argv, expected);
  });

  test('config file with --manual', async () => {
    const argv = ['--config=random-global.json', '--manual'];
    const expected: Config = {
      mode: 'manual',
      npmrc: '',
      sampleSize: 50,
      timeout: 3,
      root: testData,
      resolveBareModules: true,
      forceCleanNpmInstall: false,
      autoSampleConditions: {absolute: {ms: [], bytes: []}, relative: [0]},
      remoteAccessibleHost: '',
      jsonFile: '',
      legacyJsonFile: '',
      csvFileStats: '',
      csvFileRaw: '',
      githubCheck: undefined,
      benchmarks: [
        {
          browser: {
            headless: false,
            name: 'chrome',
            windowSize: {
              height: 768,
              width: 1024,
            },
          },
          measurement: [
            {
              mode: 'callback',
            },
          ],
          // TODO(aomarks) Why does this have a forward-slash?
          name: '/random-global.html',
          url: {
            kind: 'local',
            queryString: '',
            urlPath: '/random-global.html',
          },
        },
      ],
    };
    await checkConfig(argv, expected);
  });

  test('config file with output files and force clean install', async () => {
    const argv = [
      '--config=random-global.json',
      '--csv-file=stats.csv',
      '--csv-file-raw=raw.csv',
      '--json-file=out.json',
      '--force-clean-npm-install',
    ];
    const expected: Config = {
      mode: 'automatic',
      npmrc: '',
      csvFileStats: 'stats.csv',
      csvFileRaw: 'raw.csv',
      jsonFile: 'out.json',
      legacyJsonFile: '',
      forceCleanNpmInstall: true,

      sampleSize: 50,
      timeout: 3,
      root: testData,
      resolveBareModules: true,
      autoSampleConditions: {absolute: {ms: [], bytes: []}, relative: [0]},
      remoteAccessibleHost: '',
      // TODO(aomarks) Be consistent about undefined vs unset.
      githubCheck: undefined,
      benchmarks: [
        {
          browser: {
            headless: false,
            name: 'chrome',
            windowSize: {
              height: 768,
              width: 1024,
            },
          },
          measurement: [
            {
              mode: 'callback',
            },
          ],
          // TODO(aomarks) Why does this have a forward-slash?
          name: '/random-global.html',
          url: {
            kind: 'local',
            queryString: '',
            urlPath: '/random-global.html',
          },
        },
      ],
    };
    await checkConfig(argv, expected);
  });

  test('config file horizons is converted to autoSampleConditions', async () => {
    const argv = ['--config=deprecated-horizons.json'];
    const expected: Config = {
      mode: 'automatic',
      npmrc: '',
      csvFileStats: '',
      csvFileRaw: '',
      jsonFile: '',
      legacyJsonFile: '',
      forceCleanNpmInstall: false,

      sampleSize: 50,
      timeout: 3,
      root: testData,
      resolveBareModules: true,
      autoSampleConditions: {
        absolute: {ms: [], bytes: []},
        relative: [-0.1, 0, 0.1],
      },
      remoteAccessibleHost: '',
      // TODO(aomarks) Be consistent about undefined vs unset.
      githubCheck: undefined,
      benchmarks: [
        {
          browser: {
            headless: false,
            name: 'chrome',
            windowSize: {
              height: 768,
              width: 1024,
            },
          },
          measurement: [
            {
              mode: 'callback',
            },
          ],
          // TODO(aomarks) Why does this have a forward-slash?
          name: '/random-global.html',
          url: {
            kind: 'local',
            queryString: '',
            urlPath: '/random-global.html',
          },
        },
      ],
    };
    await checkConfig(argv, expected);
  });
});

suite('parseAutoSampleConditions', function () {
  test('0ms', () => {
    assert.deepEqual(parseAutoSampleConditions(['0ms']), {
      absolute: {ms: [0], bytes: []},
      relative: [],
    });
  });

  test('0.1ms', () => {
    assert.deepEqual(parseAutoSampleConditions(['0.1ms']), {
      absolute: {ms: [-0.1, 0.1], bytes: []},
      relative: [],
    });
  });

  test('+0.1ms', () => {
    assert.deepEqual(parseAutoSampleConditions(['+0.1ms']), {
      absolute: {ms: [0.1], bytes: []},
      relative: [],
    });
  });

  test('-0.1ms', () => {
    assert.deepEqual(parseAutoSampleConditions(['-0.1ms']), {
      absolute: {ms: [-0.1], bytes: []},
      relative: [],
    });
  });

  test('0ms,0.1,1ms', () => {
    assert.deepEqual(parseAutoSampleConditions(['0ms', '0.1ms', '1ms']), {
      absolute: {ms: [-1, -0.1, 0, 0.1, 1], bytes: []},
      relative: [],
    });
  });

  test('0%', () => {
    assert.deepEqual(parseAutoSampleConditions(['0%']), {
      absolute: {ms: [], bytes: []},
      relative: [0],
    });
  });

  test('1%', () => {
    assert.deepEqual(parseAutoSampleConditions(['1%']), {
      absolute: {ms: [], bytes: []},
      relative: [-0.01, 0.01],
    });
  });

  test('+1%', () => {
    assert.deepEqual(parseAutoSampleConditions(['+1%']), {
      absolute: {ms: [], bytes: []},
      relative: [0.01],
    });
  });

  test('-1%', () => {
    assert.deepEqual(parseAutoSampleConditions(['-1%']), {
      absolute: {ms: [], bytes: []},
      relative: [-0.01],
    });
  });

  test('0%,1%,10%', () => {
    assert.deepEqual(parseAutoSampleConditions(['0%', '1%', '10%']), {
      absolute: {ms: [], bytes: []},
      relative: [-0.1, -0.01, 0, 0.01, 0.1],
    });
  });

  test('0ms,0.1ms,1ms,0%,1%,10%', () => {
    assert.deepEqual(
      parseAutoSampleConditions(['0ms', '0.1ms', '1ms', '0%', '1%', '10%']),
      {
        absolute: {ms: [-1, -0.1, 0, 0.1, 1], bytes: []},
        relative: [-0.1, -0.01, 0, 0.01, 0.1],
      }
    );
  });

  test('throws on nonsense', () => {
    assert.throws(() => parseAutoSampleConditions(['sailboat']));
  });

  test('throws on ambiguous unit', () => {
    assert.throws(() => parseAutoSampleConditions(['4']));
  });

  test('byte units: B, KiB, MiB, GiB', () => {
    assert.deepEqual(parseAutoSampleConditions(['0B']), {
      absolute: {ms: [], bytes: [0]},
      relative: [],
    });
    assert.deepEqual(parseAutoSampleConditions(['+10KiB']), {
      absolute: {ms: [], bytes: [10 * 1024]},
      relative: [],
    });
    assert.deepEqual(parseAutoSampleConditions(['1MiB']), {
      absolute: {ms: [], bytes: [-1024 * 1024, 1024 * 1024]},
      relative: [],
    });
    assert.deepEqual(parseAutoSampleConditions(['2GiB']), {
      absolute: {
        ms: [],
        bytes: [-2 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024],
      },
      relative: [],
    });
    assert.deepEqual(parseAutoSampleConditions(['-1KiB', '+1KiB', '1%']), {
      absolute: {ms: [], bytes: [-1024, 1024]},
      relative: [-0.01, 0.01],
    });
  });

  test('mixed ms and byte conditions are partitioned by unit', () => {
    assert.deepEqual(parseAutoSampleConditions(['0.1ms', '+1KiB']), {
      absolute: {ms: [-0.1, 0.1], bytes: [1024]},
      relative: [],
    });
  });
});
