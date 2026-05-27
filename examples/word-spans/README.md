# word-spans benchmark

Compares two pages that contain the same 50,000 words:

- [`plain.html`](./plain.html) — words rendered as a single text node.
- [`wrapped.html`](./wrapped.html) — each word wrapped in a
  `<span class="word">` element. The number of words can be overridden
  with `?n=NUMBER` (default 50,000).

Both pages build their DOM synchronously inside a `<script>` tag and set
`window.tachometerResult = performance.now()` so tachometer can use the
`expression` measurement to capture the build time.

## Configs

### [`tachometer.json`](./tachometer.json) — plain vs wrapped (50k words)

Measures three things per page:

1. `build-time` — milliseconds spent constructing the DOM.
2. `v8-heap` — V8 main heap size, in bytes (`v8/main/heap.size`).
3. `malloc` — process malloc size, in bytes (`malloc.size`).

`autoSampleConditions` is set to `["1%", "+100KiB"]`. Thanks to the
unit-aware partitioning, the `1%` condition applies to all results
while `+100KiB` applies only to the two memory results — it does not
incorrectly affect the timing result.

### [`scale.json`](./scale.json) — 1k vs 200k words (validation)

Compares `wrapped.html?n=1000` against `wrapped.html?n=200000` to verify
that memory measurement happens **after** the DOM has been built. With
200× more elements we expect to see a massive memory delta; if the dump
fired before the script ran, the two pages would look the same.

Empirical results on Chrome 148 (sample size 25, headless):

| Metric            | n=1,000 | n=200,000 | ratio |
| ----------------- | ------- | --------- | ----- |
| `build-time`      | 15 ms   | 322 ms    |  21×  |
| `v8/main/heap`    | 1.17 MB | 2.66 MB   |  2.3× |
| **`blink_gc`**    | **2.14 MB** | **120.15 MB** | **56×** |
| `partition_alloc/allocated_objects` | 0.49 MB | 5.28 MB | 10.7× |

The huge `blink_gc.size` delta confirms the dump captures the constructed
DOM (Oilpan manages DOM nodes in modern Chromium). The relatively flat
`v8/main/heap.size` is expected: the JS only allocates a handful of
local variables, and JS-side DOM wrappers are not retained unless JS
references them.

**Lesson:** pick the metric that matches what you are testing. For
DOM-heavy comparisons use `blink_gc.size`; for pure-JS heap behaviour
use `v8/main/heap.size`.

## Run

From the repository root:

```sh
node bin/tach.js --config examples/word-spans/tachometer.json
node bin/tach.js --config examples/word-spans/scale.json
```

Requires Chrome to be installed locally. Memory measurement is
Chromium-only (`chrome` or `edge`).
