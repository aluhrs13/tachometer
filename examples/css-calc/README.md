# css-calc benchmark

Compares two stylesheets that produce visually identical layouts:

- [`tokens.html`](./tokens.html) declares **10 distinct CSS custom
  properties** (`--space-1` through `--space-10`) and each `.item-N`
  rule references them directly.
- [`calc.html`](./calc.html) declares **1 base CSS custom property**
  (`--space`) and each `.item-N` rule uses `calc(var(--space) * N)` to
  derive the equivalent spacing values.

Each page builds 5,000 items (DOM-generated, distributed across 10
class variants), and each variant sets 5 spacing properties — so the
browser resolves roughly 25,000 spacing expressions per page.

## What this is asking

Is it cheaper to maintain a fixed set of named tokens, or to derive
spacing values from a single base via `calc()`? The `tokens` version
trades a larger declaration list for a simpler style-resolution path.
The `calc` version has a smaller declaration list but every applied
declaration is a `CalcValue` tree that must be evaluated.

## Measurements

- `build-time` — DOM construction duration in ms, measured by the
  page's own `performance.now()`. This excludes style/layout/paint.
- `total-time` — total time from script start to **after** the first
  paint commits, in ms. This is the one that actually exercises
  `calc()` (style resolution evaluates calc trees).
- `process-memory` — `malloc.size` on the renderer process, in bytes.
  Used here as a portable proxy for "total process memory" because
  `process_totals.resident_set_bytes` is not reported on Windows.

Both pages signal completion via double `requestAnimationFrame`, so the
memory measurement is captured **after** the first paint commit. See
[`../word-spans/README.md`](../word-spans/README.md) for why that
matters.

## Observed results

Chrome 148 headless, sample size 60, on a single Windows machine:

| Metric                     | tokens   | calc     | Δ     |
| -------------------------- | -------- | -------- | ----- |
| `build-time` (DOM only)    | 4.94 ms  | 4.94 ms  | 0%    |
| `total-time` (incl. paint) | 63.04 ms | 63.16 ms | +0.2% |
| `process-memory`           | 8.29 MiB | 7.47 MiB | −10%  |

**At this scale (5,000 items, ~25,000 spacing applications) there is no
measurable performance difference between the two approaches.** The
total-time delta sits well within noise. The memory trend slightly
favours `calc` — probably because the stylesheet declares 10× fewer
distinct `CSSPrimitiveValue` constants — but the absolute size is
small. Pick whichever is easier to maintain; you will not see a
runtime cost from `calc()` for this kind of design-token use.

## Run

```sh
node bin/tach.js --config examples/css-calc/tachometer.json
```

Or with a JSON file for the HTML report:

```sh
node bin/tach.js --config examples/css-calc/tachometer.json \
  --json-file=css-calc.json
node scripts/json-to-html.mjs css-calc.json
```

Requires Chrome to be installed locally.
