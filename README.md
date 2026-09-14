# Benchmark Dashboard (static, GitHub Pages ready)

A fully static, backend-free version of the dashboard. All parsing,
filtering, aggregation, and charting happens in the browser — nothing is
uploaded anywhere, and no server is required.

## Run it

Any of these work identically:

- **Just open it**: double-click `index.html`.
- **Local server** (only needed if your browser is picky about `file://`):
  `python3 -m http.server 8000`, then open http://localhost:8000
- **GitHub Pages**: push this folder's contents to a repo and enable
  Pages (Settings → Pages → deploy from the branch/folder containing
  `index.html`). That's it — no build step, no server code.

Click **Choose folder…** and pick the folder containing your run
subfolders (e.g. `sample_logs/` for a quick demo, or your real `logs/`).
Your browser will ask permission to read that folder — the files never
leave your machine.

## What's new in this version

- **Trimming never empties a group out.** If a "same experiment" group
  only has as many (or fewer) runs than you asked to trim — e.g.
  Trim low = 3 but only 3 repeats exist — trimming backs off so at
  least one value always survives, rather than leaving that chart point
  with nothing.
- **Column filter chips light up** when they're part of the current
  filter — whether you clicked them, typed the value manually, or it's
  matched by a `/regex/` you entered. The `Maximum`/`Minimum` chips
  light up the same way when that keyword is present.
- **Optional remote loading over HTTP(S)**: a "Manifest URL" field next
  to "Choose folder…" lets you load logs from a web server instead of
  your local disk. Point it at a small JSON file listing your `.log`
  paths (generate one with `tools/make_manifest.py`, included in this
  project) and click "Load from URL". Note: browsers cannot fetch
  `ftp://` URLs directly (all major browsers dropped FTP support) — if
  your logs live on an FTP server, expose the same folder over HTTP(S)
  (most FTP appliances can do this, or just copy the folder to any
  static web server) and the remote server needs to send CORS headers
  for the browser to be allowed to read it cross-origin.

## Previously added

- New "Same experiment = same" field (comma-separated columns, e.g.
  `Machine, Benchmark, N, Kernel, OMP_THREADS`) makes outlier trimming
  identity-aware: it only competes among rows sharing identical values
  for those columns, so a chart point that happens to mix multiple
  Kernels won't have its outliers cross-contaminated. Leave blank for
  the simpler whole-point trim.
- Column filter chips get much more room (~220px, scrollable) and show
  every distinct value — no more "+N more" cutoff.
- Regex column filters: a Values entry like `/ref/i` is tested as a
  regular expression against the cell's text.
- Default aggregation is `max`.
- Third table tab, "Plot data": plain tab-separated text, copyable,
  matching the Summary table without the `×N` annotations.
- `Maximum`/`Minimum` column-filter keywords resolve per benchmark (per
  log file), not globally.
- New aggregation: "error bars (avg ± stdev)".
- New Kind: "candlestick" (Q1–Q3 box, median line, min/max whiskers).
- Fixed platform-name parsing bug (`fireflyk3` vs `fireflyk3_a100`).
- The dashboard's own SEQ/OMP indicator is stored as **RunType**, not
  **Mode**, so benchmarks with their own real `Mode` column are left
  untouched.
- Larger legend above the chart, aggregation counts (`×N`), optional
  Y-value labels on points.

## Files

- `index.html`, `app.js`, `styles.css` — the entire app.
- `tools/make_manifest.py` — generates the `index.json` manifest needed
  for "Load from URL". Run it against your logs folder, then upload the
  folder (plus the generated `index.json`) to any HTTP(S) server.
- `sample_logs/` — small demo dataset to try the picker on immediately.

## Folder layout expected

```
logs/
  <platform>_<timestamp>/            SEQ run
    axpy.log
  <platform>-omp_<timestamp>/        OMP run
    fft.log                          extra OMP_THREADS column
```

Each `.log` file is a tab-separated table, header row first.
