# word-spans benchmark

Compares two pages that contain the same 50,000 words:

- [`plain.html`](./plain.html) — words rendered as a single text node.
- [`wrapped.html`](./wrapped.html) — each word wrapped in a
  `<span class="word">` element.

Both pages build their DOM synchronously inside a `<script>` tag and set
`window.tachometerResult = performance.now()` so tachometer can use the
`expression` measurement to capture the build time.

The config measures three things per page:

1. `build-time` — milliseconds spent constructing the DOM.
2. `v8-heap` — V8 main heap size, in bytes (`v8/main/heap.size`).
3. `malloc` — process malloc size, in bytes (`malloc.size`).

`autoSampleConditions` is set to `["1%", "+100KiB"]`, so tachometer will
keep sampling until the relative difference is resolved at 1% _and_ the
absolute memory difference is resolved at the 100 KiB boundary. Thanks
to the unit-aware partitioning, the `1%` condition applies to all
results while `+100KiB` applies only to the two memory results — it does
not incorrectly affect the timing result.

## Run

From the repository root:

```sh
node bin/tach.js --config examples/word-spans/tachometer.json
```

Requires Chrome to be installed locally. Memory measurement is
Chromium-only (`chrome` or `edge`).
