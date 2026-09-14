"use strict";

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const state = {
  allRows: [],   // every row read from disk, tagged with Machine/RunTimestamp/Benchmark/RunType
  rows: [],      // allRows narrowed by the Files filters (run type / benchmark / platform)
  columns: [],   // columns relevant to the current `rows`
};

const N_COLUMN_FILTERS = 6;
const SERIES_COLORS = [
  "var(--series-0)", "var(--series-1)", "var(--series-2)", "var(--series-3)",
  "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)",
];

// Synthetic columns we attach ourselves. "RunType" (not "Mode") on purpose:
// some benchmarks (e.g. Memhierarchy) have their own real "Mode" column
// (values like "permute", "random") and we must never clobber it.
const IDENTIFIER_COLUMNS = new Set(["Machine", "RunTimestamp", "Benchmark", "RunType"]);

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */
function naturalKey(v) {
  if (v === null || v === undefined || v === "") return [1, ""];
  const n = Number(v);
  if (!Number.isNaN(n)) return [0, n];
  return [1, String(v)];
}

function compareNatural(a, b) {
  const ka = naturalKey(a), kb = naturalKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[0] === 0) return ka[1] - kb[1];
  return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
}

function formatNumber(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  if (Number.isInteger(v)) return String(v);
  const rounded = Math.round(v * 1000) / 1000;
  return String(rounded);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Shared debounced entry point for render(), used by inputs that fire on
// every keystroke (column filter values, trim fields, etc).
const debouncedRender = debounce(() => render(), 200);

function parseCommaList(s) {
  return (s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function clampInt(v, min) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < min) return min;
  return n;
}

/* ------------------------------------------------------------------ */
/* Folder-name parsing: <platform>_<timestamp> or <platform>-omp_<ts>  */
/* Timestamp is anchored to a fixed shape so platform names that       */
/* themselves contain underscores (e.g. "fireflyk3_a100") still parse  */
/* correctly - we do NOT just split on the first underscore.           */
/* ------------------------------------------------------------------ */
const FOLDER_RE = /^(.+)_(\d{2}-\d{2}-\d{2}-\d{2}_\d{2}_\d{2})$/;
const OMP_SUFFIX = "-omp";

function parseFolderName(name) {
  const m = FOLDER_RE.exec(name);
  if (!m) return { platform: null, timestamp: "", mode: "seq" };
  const rawPlatform = m[1];
  const timestamp = m[2];
  if (rawPlatform.endsWith(OMP_SUFFIX)) {
    return { platform: rawPlatform.slice(0, -OMP_SUFFIX.length), timestamp, mode: "omp" };
  }
  return { platform: rawPlatform, timestamp, mode: "seq" };
}

/* ------------------------------------------------------------------ */
/* TSV parsing                                                         */
/* ------------------------------------------------------------------ */
function parseTSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const header = lines[0].split("\t").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t").map((c) => c.trim());
    const row = {};
    header.forEach((h, idx) => { row[h] = cells[idx] !== undefined ? cells[idx] : ""; });
    rows.push(row);
  }
  return rows;
}

function coerceNumericColumns(rows) {
  const columns = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => columns.add(k)));
  columns.forEach((col) => {
    if (IDENTIFIER_COLUMNS.has(col)) return;
    let allNumeric = true;
    let anyValue = false;
    for (const row of rows) {
      const v = row[col];
      if (v === undefined || v === "" || v === null) continue;
      anyValue = true;
      if (Number.isNaN(Number(v))) { allNumeric = false; break; }
    }
    if (anyValue && allNumeric) {
      rows.forEach((row) => {
        if (row[col] === undefined) return;
        row[col] = row[col] === "" ? null : Number(row[col]);
      });
    }
  });
}

function computeColumns(rows) {
  const seen = [];
  const set = new Set();
  rows.forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (!set.has(k)) { set.add(k); seen.push(k); }
    });
  });
  return seen;
}

/* ------------------------------------------------------------------ */
/* Files: folder picker (client-side, works on GitHub Pages too)       */
/* ------------------------------------------------------------------ */
function setStatus(msg, kind) {
  const line = el("loadStatus");
  line.textContent = msg;
  line.className = "status-line" + (kind ? " " + kind : "");
}

function renderChips(container, values, targetInput, onPick) {
  container.innerHTML = "";
  values.forEach((v) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = v;
    chip.addEventListener("click", () => {
      const current = parseCommaList(targetInput.value);
      if (!current.includes(v)) {
        current.push(v);
        targetInput.value = current.join(", ");
        (onPick || applyFileFilters)();
      }
    });
    container.appendChild(chip);
  });
}

async function readLogFile(file) {
  const parts = file.webkitRelativePath.split("/");
  if (parts.length < 2) return { error: `${file.name}: not inside a run folder` };
  const runFolder = parts[parts.length - 2];
  const parsedFolder = parseFolderName(runFolder);
  if (parsedFolder.platform === null) {
    return { error: `${runFolder}: folder name doesn't match <platform>[-omp]_<timestamp>` };
  }
  const benchmark = file.name.replace(/\.log$/, "");
  let text;
  try {
    text = await file.text();
  } catch (err) {
    return { error: `${file.webkitRelativePath}: ${err.message}` };
  }
  return rowsFromLogText(text, parsedFolder, benchmark, file.webkitRelativePath);
}

function rowsFromLogText(text, parsedFolder, benchmark, sourceLabel) {
  try {
    const rows = parseTSV(text).map((row) => ({
      ...row,
      Machine: parsedFolder.platform,
      RunTimestamp: parsedFolder.timestamp,
      Benchmark: benchmark,
      RunType: parsedFolder.mode,
    }));
    return { rows };
  } catch (err) {
    return { error: `${sourceLabel}: ${err.message}` };
  }
}

// Shared tail end of both loading paths (local folder picker and remote
// URL manifest): given the per-file {rows|error} results, build
// state.allRows, report status, and hand off to the Files filters.
function ingestFileResults(results, fileCount) {
  const allRows = [];
  const skipped = [];
  results.forEach((result) => {
    if (result.error) skipped.push(result.error);
    else allRows.push(...result.rows);
  });

  if (!allRows.length) {
    setStatus(
      skipped.length ? `Couldn't parse any rows. First problem: ${skipped[0]}` : "Couldn't parse any rows.",
      "error"
    );
    return;
  }

  coerceNumericColumns(allRows);
  state.allRows = allRows;

  const platformCount = new Set(allRows.map((r) => r.Machine)).size;
  const benchmarkCount = new Set(allRows.map((r) => r.Benchmark)).size;
  setStatus(
    `Loaded ${allRows.length} rows from ${fileCount} file(s) \u00b7 ` +
    `${platformCount} platform(s) \u00b7 ${benchmarkCount} benchmark(s)` +
    (skipped.length ? ` \u00b7 ${skipped.length} file(s) skipped` : ""),
    "ok"
  );

  applyFileFilters();
}

async function handleFolderSelected(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  const logFiles = files.filter((f) => f.name.endsWith(".log"));
  if (!logFiles.length) {
    setStatus("No .log files found in that folder.", "error");
    return;
  }

  setStatus(`Reading ${logFiles.length} file(s)\u2026`);
  try {
    const parsed = await Promise.all(logFiles.map(readLogFile));
    ingestFileResults(parsed, logFiles.length);
  } catch (err) {
    setStatus(err.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* Files: optional remote loading over HTTP(S) via a JSON manifest     */
/*                                                                      */
/* Browsers dropped ftp:// support entirely, so a true FTP URL can't   */
/* be fetched from client-side JS. If your logs live on an FTP server, */
/* expose the same folder over HTTP(S) (many FTP servers/appliances    */
/* offer this, or just serve it with any static web server) and point */
/* this at a small JSON manifest listing the .log paths. The           */
/* tools/make_manifest.py script in this project generates that file.  */
/* ------------------------------------------------------------------ */
async function fetchLogFileFromUrl(baseUrl, relPath) {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length < 2) return { error: `${relPath}: not inside a run folder` };
  const runFolder = parts[parts.length - 2];
  const parsedFolder = parseFolderName(runFolder);
  if (parsedFolder.platform === null) {
    return { error: `${runFolder}: folder name doesn't match <platform>[-omp]_<timestamp>` };
  }
  const benchmark = parts[parts.length - 1].replace(/\.log$/, "");
  const url = baseUrl + relPath;
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    return { error: `${relPath}: ${err.message} (check the URL is reachable and sends CORS headers)` };
  }
  return rowsFromLogText(text, parsedFolder, benchmark, relPath);
}

async function loadFromUrl(manifestUrl) {
  if (!manifestUrl) {
    setStatus("Manifest URL is required.", "error");
    return;
  }
  setStatus("Fetching manifest\u2026");
  el("loadUrlBtn").disabled = true;
  try {
    let manifest;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      throw new Error(
        `Couldn't load manifest (${err.message}). If the server is FTP-only, browsers can't fetch ` +
        `ftp:// URLs directly - expose the folder over HTTP(S) instead. Also check CORS headers.`
      );
    }
    if (!manifest || !Array.isArray(manifest.files)) {
      throw new Error('Manifest must be JSON like {"files": ["platform_timestamp/bench.log", ...]}');
    }

    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
    setStatus(`Fetching ${manifest.files.length} file(s)\u2026`);
    const results = await Promise.all(manifest.files.map((relPath) => fetchLogFileFromUrl(base, relPath)));
    ingestFileResults(results, manifest.files.length);
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    el("loadUrlBtn").disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Files filters: run type / benchmark / platform (all client-side)    */
/* ------------------------------------------------------------------ */
function updateChipsFromAllRows(mode) {
  const subset = state.allRows.filter((r) => r.RunType === mode);
  const benchmarks = Array.from(new Set(subset.map((r) => r.Benchmark))).sort();
  const platforms = Array.from(new Set(subset.map((r) => r.Machine))).sort();
  renderChips(el("benchmarkChips"), benchmarks, el("benchmarks"), applyFileFilters);
  renderChips(el("platformChips"), platforms, el("platforms"), applyFileFilters);
}

function applyFileFilters() {
  if (!state.allRows.length) return;

  const mode = el("mode").value;
  const benchmarks = parseCommaList(el("benchmarks").value);
  const platforms = parseCommaList(el("platforms").value);

  let rows = state.allRows.filter((r) => r.RunType === mode);
  if (benchmarks.length) rows = rows.filter((r) => benchmarks.includes(r.Benchmark));
  if (platforms.length) rows = rows.filter((r) => platforms.includes(r.Machine));

  state.rows = rows;
  state.columns = computeColumns(rows);

  updateChipsFromAllRows(mode);
  populateColumnSelects();
  buildColumnFilterRows();
  el("chartEmpty").style.display = rows.length ? "none" : "flex";
  render();
}

/* ------------------------------------------------------------------ */
/* Plot filter selects                                                 */
/* ------------------------------------------------------------------ */
function pickDefault(cols, preferred, exclude) {
  exclude = exclude || [];
  for (const p of preferred) {
    if (cols.includes(p) && !exclude.includes(p)) return p;
  }
  const fallback = cols.find((c) => !exclude.includes(c));
  return fallback !== undefined ? fallback : cols[0];
}

function populateColumnSelects() {
  const cols = state.columns;
  const fillSelect = (selectEl, selected) => {
    const prior = selectEl.value;
    selectEl.innerHTML = "";
    cols.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      if (c === (cols.includes(prior) ? prior : selected)) opt.selected = true;
      selectEl.appendChild(opt);
    });
  };

  const xDefault = pickDefault(cols, ["N", "OMP_THREADS"]);
  const yDefault = pickDefault(cols, ["MFLOPs", "Micros"], [xDefault]);
  const seriesDefault = pickDefault(cols, ["Platform", "Machine", "Kernel"], [xDefault, yDefault]);

  fillSelect(el("xAxis"), xDefault);
  fillSelect(el("seriesCol"), seriesDefault);
  fillSelect(el("yAxis"), yDefault);
}

/* ------------------------------------------------------------------ */
/* Column filters (up to 6): value chips + Maximum/Minimum keyword     */
/* ------------------------------------------------------------------ */
function buildColumnFilterRows() {
  const container = el("columnFilters");
  const previous = readColumnFiltersRaw();
  container.innerHTML = "";
  for (let i = 0; i < N_COLUMN_FILTERS; i++) {
    const block = document.createElement("div");
    block.className = "col-filter-block";

    const row = document.createElement("div");
    row.className = "col-filter-row";

    const colSelect = document.createElement("select");
    colSelect.className = "cf-col";
    colSelect.dataset.index = i;
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "(none)";
    colSelect.appendChild(blank);
    state.columns.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      colSelect.appendChild(opt);
    });

    const valInput = document.createElement("input");
    valInput.type = "text";
    valInput.className = "cf-val";
    valInput.placeholder = "value1, value2, or Maximum";
    valInput.dataset.index = i;

    if (previous[i] && state.columns.includes(previous[i].column)) {
      colSelect.value = previous[i].column;
      valInput.value = previous[i].values;
    }

    const chips = document.createElement("div");
    chips.className = "cf-chips";
    chips.dataset.index = i;

    colSelect.addEventListener("change", () => { updateColumnFilterChips(i); render(); });
    valInput.addEventListener("input", () => { refreshChipActiveStates(i); debouncedRender(); });

    row.appendChild(colSelect);
    row.appendChild(valInput);
    block.appendChild(row);
    block.appendChild(chips);
    container.appendChild(block);

    if (colSelect.value) updateColumnFilterChips(i);
  }
}

function updateColumnFilterChips(index) {
  const colSelect = document.querySelector(`.cf-col[data-index="${index}"]`);
  const valInput = document.querySelector(`.cf-val[data-index="${index}"]`);
  const chipsContainer = document.querySelector(`.cf-chips[data-index="${index}"]`);
  if (!colSelect || !valInput || !chipsContainer) return;
  chipsContainer.innerHTML = "";
  const col = colSelect.value;
  if (!col) return;

  const appendValue = (value) => {
    const current = parseCommaList(valInput.value);
    if (!current.includes(value)) {
      current.push(value);
      valInput.value = current.join(", ");
      refreshChipActiveStates(index);
      render();
    }
  };

  ["Maximum", "Minimum"].forEach((kw) => {
    const chip = document.createElement("span");
    chip.className = "chip chip-keyword";
    chip.textContent = kw;
    chip.dataset.chipValue = kw;
    chip.addEventListener("click", () => appendValue(kw));
    chipsContainer.appendChild(chip);
  });

  const values = Array.from(new Set(
    state.rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== "")
  )).sort(compareNatural);

  values.forEach((v) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = String(v);
    chip.dataset.chipValue = String(v);
    chip.addEventListener("click", () => appendValue(String(v)));
    chipsContainer.appendChild(chip);
  });

  refreshChipActiveStates(index);
}

// Lights up chips that are currently "included" by the filter's Values
// field - either listed explicitly, or matched by a /regex/ token, or
// (for the Maximum/Minimum chips) that keyword being present.
function refreshChipActiveStates(index) {
  const valInput = document.querySelector(`.cf-val[data-index="${index}"]`);
  const chipsContainer = document.querySelector(`.cf-chips[data-index="${index}"]`);
  if (!valInput || !chipsContainer) return;

  const tokens = parseCommaList(valInput.value);
  const literal = new Set();
  const regexes = [];
  let hasMax = false, hasMin = false;
  tokens.forEach((tok) => {
    if (isRegexToken(tok)) {
      const re = tokenToRegex(tok);
      if (re) regexes.push(re);
      return;
    }
    const lower = tok.toLowerCase();
    if (lower === "maximum" || lower === "max") hasMax = true;
    else if (lower === "minimum" || lower === "min") hasMin = true;
    else literal.add(tok);
  });

  chipsContainer.querySelectorAll(".chip").forEach((chip) => {
    const val = chip.dataset.chipValue;
    let active = false;
    if (chip.classList.contains("chip-keyword")) {
      active = (val === "Maximum" && hasMax) || (val === "Minimum" && hasMin);
    } else {
      active = literal.has(val) || regexes.some((re) => re.test(val));
    }
    chip.classList.toggle("chip-active", active);
  });
}

function readColumnFiltersRaw() {
  const cols = Array.from(document.querySelectorAll(".cf-col"));
  const vals = Array.from(document.querySelectorAll(".cf-val"));
  const filters = [];
  for (let i = 0; i < cols.length; i++) {
    filters.push({ column: cols[i].value, values: vals[i] ? vals[i].value : "" });
  }
  return filters;
}

function columnExtreme(rows, column, which) {
  let best = null;
  for (const row of rows) {
    const v = Number(row[column]);
    if (Number.isNaN(v)) continue;
    if (best === null) best = v;
    else if (which === "max" && v > best) best = v;
    else if (which === "min" && v < best) best = v;
  }
  return best;
}

function cellMatches(cellValue, allowed) {
  if (cellValue === null || cellValue === undefined) return false;
  const cellStr = String(cellValue).trim();
  const cellNum = Number(cellValue);
  return allowed.some((a) => {
    if (a === cellStr) return true;
    const aNum = Number(a);
    return !Number.isNaN(aNum) && !Number.isNaN(cellNum) && aNum === cellNum;
  });
}

// A token of the form /pattern/flags is treated as a regular expression
// tested against the cell's string value (e.g. /ref/i matches any
// Kernel containing "ref", case-insensitively). Note: since values are
// comma-separated, a regex containing a literal comma isn't supported -
// give it its own Column filter row instead.
function isRegexToken(tok) {
  return tok.length > 2 && /^\/.*\/[a-zA-Z]*$/.test(tok);
}

function tokenToRegex(tok) {
  const lastSlash = tok.lastIndexOf("/");
  const pattern = tok.slice(1, lastSlash);
  const flags = tok.slice(lastSlash + 1);
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    return null;
  }
}

// Maximum/Minimum are resolved PER BENCHMARK (per log file), not globally,
// so plotting axpy.log + gemm.log together and filtering "N: Maximum"
// keeps each benchmark's own largest N rather than one global max.
function buildColumnFilterPredicate(column, rawValues, baseRows) {
  const tokens = parseCommaList(rawValues);
  const literalTokens = [];
  const keywords = [];
  const regexes = [];
  tokens.forEach((tok) => {
    if (isRegexToken(tok)) {
      const re = tokenToRegex(tok);
      if (re) regexes.push(re);
      return;
    }
    const lower = tok.toLowerCase();
    if (lower === "maximum" || lower === "max") keywords.push("max");
    else if (lower === "minimum" || lower === "min") keywords.push("min");
    else literalTokens.push(tok);
  });

  let perBenchmarkExtreme = null;
  if (keywords.length) {
    perBenchmarkExtreme = new Map();
    const byBenchmark = new Map();
    baseRows.forEach((r) => {
      if (!byBenchmark.has(r.Benchmark)) byBenchmark.set(r.Benchmark, []);
      byBenchmark.get(r.Benchmark).push(r);
    });
    byBenchmark.forEach((benchRows, benchmark) => {
      keywords.forEach((which) => {
        const v = columnExtreme(benchRows, column, which);
        if (v !== null) perBenchmarkExtreme.set(benchmark + "|" + which, v);
      });
    });
  }

  return function matches(row) {
    if (literalTokens.length && cellMatches(row[column], literalTokens)) return true;
    if (regexes.length) {
      const cellStr = row[column] === null || row[column] === undefined ? "" : String(row[column]);
      if (regexes.some((re) => re.test(cellStr))) return true;
    }
    if (keywords.length) {
      const rowNum = Number(row[column]);
      if (!Number.isNaN(rowNum)) {
        for (const which of keywords) {
          const extreme = perBenchmarkExtreme.get(row.Benchmark + "|" + which);
          if (extreme !== undefined && rowNum === extreme) return true;
        }
      }
    }
    return false;
  };
}

function applyColumnFilters(rows) {
  const raw = readColumnFiltersRaw().filter((f) => f.column && f.values.trim());
  if (!raw.length) return rows;
  const predicates = raw.map((f) => buildColumnFilterPredicate(f.column, f.values, rows));
  return rows.filter((row) => predicates.every((pred) => pred(row)));
}

/* ------------------------------------------------------------------ */
/* Outlier trimming (shared by both pivot builders)                    */
/*                                                                      */
/* Trimming only competes within rows that share the same value for    */
/* every column listed in `groupCols` (user-configurable) - so it only */
/* discards repeated-RUN noise (e.g. different RunTimestamp) rather    */
/* than mixing together rows that are actually different experiments   */
/* (e.g. different Kernel) just because they landed in the same        */
/* X/series pivot cell. Leave groupCols empty to trim across the whole */
/* cell regardless of any other column (the simpler, coarser mode).    */
/* ------------------------------------------------------------------ */
// Trims low smallest + high largest, but NEVER removes the last
// surviving value. If low+high would empty the group out entirely (or
// exceed it), trimming is capped so exactly one value always remains -
// the low side is honored first, then the high side gets whatever
// budget is left. This alternating-removal formulation gives identical
// results to a plain symmetric slice in the normal (non-degenerate)
// case, and only differs by keeping one extra value when over-trimmed.
function trimOutliers(values, low, high) {
  if (low <= 0 && high <= 0) return values;
  const sorted = [...values].sort((a, b) => a - b);
  let lo = 0, hi = sorted.length;
  let remainingLow = low, remainingHigh = high;
  while ((remainingLow > 0 || remainingHigh > 0) && (hi - lo) > 1) {
    if (remainingLow > 0 && (hi - lo) > 1) { lo++; remainingLow--; }
    if (remainingHigh > 0 && (hi - lo) > 1) { hi--; remainingHigh--; }
  }
  return sorted.slice(lo, hi);
}

function experimentIdentityKey(row, groupCols) {
  if (!groupCols.length) return "__all__";
  return groupCols.map((c) => {
    const v = row[c];
    return v === undefined || v === null ? "" : String(v);
  }).join("\u0002");
}

function trimRowsByIdentity(rows, yAxis, low, high, groupCols) {
  const valid = rows.filter((r) => !Number.isNaN(Number(r[yAxis])));
  if (low <= 0 && high <= 0) return valid.map((r) => Number(r[yAxis]));
  const byIdentity = new Map();
  valid.forEach((r) => {
    const key = experimentIdentityKey(r, groupCols);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(Number(r[yAxis]));
  });
  let result = [];
  byIdentity.forEach((values) => { result = result.concat(trimOutliers(values, low, high)); });
  return result;
}

function groupRawRows(rows, xAxis, seriesCol) {
  const groups = new Map();
  const xValsSet = new Set();
  const seriesValsSet = new Set();
  for (const row of rows) {
    const xv = row[xAxis];
    const sv = row[seriesCol];
    if (xv === null || xv === undefined || xv === "") continue;
    if (sv === null || sv === undefined || sv === "") continue;
    const key = xv + "\u0001" + sv;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
    xValsSet.add(xv);
    seriesValsSet.add(sv);
  }
  const xVals = Array.from(xValsSet).sort(compareNatural);
  const seriesVals = Array.from(seriesValsSet).sort(compareNatural);
  return { groups, xVals, seriesVals };
}

function computeStats(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  let std = 0;
  if (n > 1) {
    const variance = arr.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (n - 1);
    std = Math.sqrt(variance);
  }
  return { mean, std, min: Math.min(...arr), max: Math.max(...arr), n };
}

function quantileSorted(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

function computeBoxStats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    min: sorted[0],
    q1: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    q3: quantileSorted(sorted, 0.75),
    max: sorted[sorted.length - 1],
    n: sorted.length,
  };
}

/* ------------------------------------------------------------------ */
/* Pivot: line / points / bars (min / max / avg / errorbars)           */
/* ------------------------------------------------------------------ */
function buildPivot(rows, xAxis, seriesCol, yAxis, agg, trimLow, trimHigh, trimGroupCols) {
  const { groups, xVals, seriesVals } = groupRawRows(rows, xAxis, seriesCol);

  const matrix = [], counts = [], stdMatrix = [];
  xVals.forEach((xv) => {
    const valueRow = [], countRow = [], stdRow = [];
    seriesVals.forEach((sv) => {
      const cellRows = groups.get(xv + "\u0001" + sv) || [];
      const arr = trimRowsByIdentity(cellRows, yAxis, trimLow, trimHigh, trimGroupCols);
      if (!arr.length) { valueRow.push(null); countRow.push(0); stdRow.push(0); return; }
      const stats = computeStats(arr);
      let value;
      if (agg === "min") value = stats.min;
      else if (agg === "max") value = stats.max;
      else value = stats.mean; // avg or errorbars
      valueRow.push(value);
      countRow.push(stats.n);
      stdRow.push(stats.std);
    });
    matrix.push(valueRow);
    counts.push(countRow);
    stdMatrix.push(stdRow);
  });

  return { xVals, seriesVals, matrix, counts, stdMatrix };
}

/* ------------------------------------------------------------------ */
/* Pivot: candlestick (quartiles, always uses the full trimmed sample)  */
/* ------------------------------------------------------------------ */
function buildBoxPivot(rows, xAxis, seriesCol, yAxis, trimLow, trimHigh, trimGroupCols) {
  const { groups, xVals, seriesVals } = groupRawRows(rows, xAxis, seriesCol);
  const boxStats = xVals.map((xv) =>
    seriesVals.map((sv) => {
      const cellRows = groups.get(xv + "\u0001" + sv) || [];
      const arr = trimRowsByIdentity(cellRows, yAxis, trimLow, trimHigh, trimGroupCols);
      if (!arr.length) return null;
      return computeBoxStats(arr);
    })
  );
  return { xVals, seriesVals, boxStats };
}

/* ------------------------------------------------------------------ */
/* Chart (hand-rolled SVG, no external charting lib)                   */
/* ------------------------------------------------------------------ */
function niceTicks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(step0)));
  const residual = step0 / magnitude;
  let step;
  if (residual > 5) step = 10 * magnitude;
  else if (residual > 2) step = 5 * magnitude;
  else if (residual > 1) step = 2 * magnitude;
  else step = magnitude;

  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  return { ticks, niceMin, niceMax };
}

function svgEl(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

function computeXLayout(xVals, opts, plotW, margin, forceEqual) {
  let xNumeric = opts.xType === "numeric" && !forceEqual;
  let xNums = [];
  if (xNumeric) {
    xNums = xVals.map((v) => Number(v));
    if (xNums.some((n) => Number.isNaN(n))) xNumeric = false;
  }
  let xPos, bandWidth;
  if (xNumeric) {
    let xMin = Math.min(...xNums), xMax = Math.max(...xNums);
    if (xMin === xMax) { xMin -= 1; xMax += 1; }
    const xPad = (xMax - xMin) * 0.06;
    const xDomainMin = xMin - xPad, xDomainMax = xMax + xPad;
    xPos = xNums.map((n) => margin.left + ((n - xDomainMin) / (xDomainMax - xDomainMin)) * plotW);
    bandWidth = plotW / xVals.length;
  } else {
    bandWidth = plotW / xVals.length;
    xPos = xVals.map((_, i) => margin.left + (i + 0.5) * bandWidth);
  }
  return { xNumeric, xPos, bandWidth };
}

function drawAxes(g, xVals, xPos, xNumeric, bandWidth, margin, plotW, plotH, height, yScale, yDomainMin, yDomainMax, xAxisLabel, yAxisLabel) {
  const { ticks } = niceTicks(yDomainMin, yDomainMax, 5);
  ticks.forEach((t) => {
    if (t < yDomainMin - 1e-9 || t > yDomainMax + 1e-9) return;
    const y = yScale(t);
    g.appendChild(svgEl("line", { class: "grid-line", x1: margin.left, x2: margin.left + plotW, y1: y, y2: y }));
    const label = svgEl("text", { class: "axis-label", x: margin.left - 8, y: y + 3, "text-anchor": "end" });
    label.textContent = formatNumber(t);
    g.appendChild(label);
  });

  g.appendChild(svgEl("line", { class: "axis-line", x1: margin.left, x2: margin.left, y1: margin.top, y2: margin.top + plotH }));
  g.appendChild(svgEl("line", { class: "axis-line", x1: margin.left, x2: margin.left + plotW, y1: margin.top + plotH, y2: margin.top + plotH }));

  if (xNumeric) {
    xVals.forEach((v, i) => {
      const label = svgEl("text", { class: "axis-label", x: xPos[i], y: margin.top + plotH + 18, "text-anchor": "middle" });
      label.textContent = formatNumber(Number(v));
      g.appendChild(label);
    });
  } else {
    const avgCharWidth = 6.4;
    const needsRotation = xVals.some((v) => String(v).length * avgCharWidth > bandWidth * 0.85);
    xVals.forEach((v, i) => {
      const label = svgEl("text", needsRotation
        ? { class: "axis-label", x: xPos[i], y: margin.top + plotH + 16, "text-anchor": "end", transform: `rotate(-32 ${xPos[i]} ${margin.top + plotH + 16})` }
        : { class: "axis-label", x: xPos[i], y: margin.top + plotH + 18, "text-anchor": "middle" });
      label.textContent = String(v);
      g.appendChild(label);
    });
  }

  const xTitle = svgEl("text", { class: "axis-title", x: margin.left + plotW / 2, y: height - 6, "text-anchor": "middle" });
  xTitle.textContent = xAxisLabel;
  g.appendChild(xTitle);

  const yTitle = svgEl("text", { class: "axis-title", x: 0, y: 0, "text-anchor": "middle", transform: `translate(16 ${margin.top + plotH / 2}) rotate(-90)` });
  yTitle.textContent = yAxisLabel;
  g.appendChild(yTitle);
}

function renderChart(pivot, opts) {
  const svg = el("chart");
  svg.innerHTML = "";
  const { xVals, seriesVals, matrix, counts, stdMatrix } = pivot;
  if (!xVals.length || !seriesVals.length) return;

  const width = 900, height = 460;
  const margin = { top: 20, right: 24, bottom: 92, left: 68 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let flat = [];
  matrix.forEach((row, xi) => row.forEach((v, si) => {
    if (v === null) return;
    flat.push(v);
    if (opts.errorbars) {
      const std = stdMatrix[xi][si];
      flat.push(v - std, v + std);
    }
  }));
  if (!flat.length) return;
  let yMin = Math.min(...flat), yMax = Math.max(...flat);
  if (opts.kind === "bars") yMin = Math.min(0, yMin);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  const yDomainMin = opts.kind === "bars" ? yMin : yMin - pad;
  const yDomainMax = yMax + pad + (opts.showLabels ? (yMax - yMin) * 0.08 : 0);

  const yScale = (v) => margin.top + plotH - ((v - yDomainMin) / (yDomainMax - yDomainMin)) * plotH;

  const forceEqual = opts.kind === "bars";
  const { xNumeric, xPos, bandWidth } = computeXLayout(xVals, opts, plotW, margin, forceEqual);

  const g = svgEl("g", {});
  svg.appendChild(g);
  drawAxes(g, xVals, xPos, xNumeric, bandWidth, margin, plotW, plotH, height, yScale, yDomainMin, yDomainMax, opts.xAxis, opts.yAxis);

  const colorFor = (i) => SERIES_COLORS[i % SERIES_COLORS.length];

  const addValueLabel = (x, y, value) => {
    if (!opts.showLabels || value === null) return;
    const label = svgEl("text", { class: "axis-label", x, y: y - 8, "text-anchor": "middle" });
    label.textContent = formatNumber(value);
    g.appendChild(label);
  };

  const drawErrorBar = (x, meanVal, std, color) => {
    if (!std) return;
    const yTop = yScale(meanVal + std), yBot = yScale(meanVal - std);
    const capW = 7;
    g.appendChild(svgEl("line", { x1: x, x2: x, y1: yTop, y2: yBot, stroke: color, "stroke-width": 1.5 }));
    g.appendChild(svgEl("line", { x1: x - capW / 2, x2: x + capW / 2, y1: yTop, y2: yTop, stroke: color, "stroke-width": 1.5 }));
    g.appendChild(svgEl("line", { x1: x - capW / 2, x2: x + capW / 2, y1: yBot, y2: yBot, stroke: color, "stroke-width": 1.5 }));
  };

  const tipText = (sv, xv, v, n, std) =>
    `${sv} \u2014 ${xv}: ${formatNumber(v)}` + (opts.errorbars ? ` \u00b1 ${formatNumber(std)}` : "") + ` (n=${n})`;

  if (opts.kind === "bars") {
    const clusterWidth = bandWidth * 0.72;
    const barWidth = clusterWidth / seriesVals.length;
    const y0 = yScale(0);
    seriesVals.forEach((sv, si) => {
      xVals.forEach((xv, xi) => {
        const v = matrix[xi][si];
        if (v === null) return;
        const n = counts[xi][si];
        const std = stdMatrix[xi][si];
        const yv = yScale(v);
        const rectY = Math.min(y0, yv);
        const rectH = Math.max(Math.abs(y0 - yv), 0.5);
        const rectX = xPos[xi] - clusterWidth / 2 + si * barWidth;
        const rect = svgEl("rect", { x: rectX, y: rectY, width: Math.max(barWidth - 1.5, 1), height: rectH, fill: colorFor(si) });
        rect.appendChild(svgEl("title", {})).textContent = tipText(sv, xv, v, n, std);
        g.appendChild(rect);
        const cx = rectX + barWidth / 2;
        if (opts.errorbars) drawErrorBar(cx, v, std, "var(--ink)");
        addValueLabel(cx, yv, v);
      });
    });
  } else {
    seriesVals.forEach((sv, si) => {
      const points = xVals.map((xv, xi) => ({
        x: xPos[xi], y: matrix[xi][si], xv, n: counts[xi][si], std: stdMatrix[xi][si],
      })).filter((p) => p.y !== null);

      if (opts.kind === "line" && points.length > 1) {
        let segment = [points[0]];
        const segments = [segment];
        for (let i = 1; i < points.length; i++) {
          const prevIdx = xVals.indexOf(points[i - 1].xv);
          const curIdx = xVals.indexOf(points[i].xv);
          if (curIdx === prevIdx + 1) segment.push(points[i]);
          else { segment = [points[i]]; segments.push(segment); }
        }
        segments.forEach((seg) => {
          if (seg.length < 2) return;
          const d = seg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${yScale(p.y)}`).join(" ");
          g.appendChild(svgEl("path", { d, fill: "none", stroke: colorFor(si), "stroke-width": 2 }));
        });
      }

      points.forEach((p) => {
        const cy = yScale(p.y);
        const circle = svgEl("circle", { cx: p.x, cy, r: opts.kind === "points" ? 4.5 : 3.5, fill: colorFor(si) });
        circle.appendChild(svgEl("title", {})).textContent = tipText(sv, p.xv, p.y, p.n, p.std);
        g.appendChild(circle);
        if (opts.errorbars) drawErrorBar(p.x, p.y, p.std, colorFor(si));
        addValueLabel(p.x, cy, p.y);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Candlestick chart                                                    */
/* ------------------------------------------------------------------ */
function renderCandlestickChart(pivot, opts) {
  const svg = el("chart");
  svg.innerHTML = "";
  const { xVals, seriesVals, boxStats } = pivot;
  if (!xVals.length || !seriesVals.length) return;

  const width = 900, height = 460;
  const margin = { top: 20, right: 24, bottom: 92, left: 68 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let flat = [];
  boxStats.forEach((row) => row.forEach((s) => { if (s) flat.push(s.min, s.max); }));
  if (!flat.length) return;
  let yMin = Math.min(...flat), yMax = Math.max(...flat);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  const yDomainMin = yMin - pad, yDomainMax = yMax + pad;
  const yScale = (v) => margin.top + plotH - ((v - yDomainMin) / (yDomainMax - yDomainMin)) * plotH;

  const { xNumeric, xPos, bandWidth } = computeXLayout(xVals, opts, plotW, margin, true);

  const g = svgEl("g", {});
  svg.appendChild(g);
  drawAxes(g, xVals, xPos, xNumeric, bandWidth, margin, plotW, plotH, height, yScale, yDomainMin, yDomainMax, opts.xAxis, opts.yAxis);

  const colorFor = (i) => SERIES_COLORS[i % SERIES_COLORS.length];
  const clusterWidth = bandWidth * 0.72;
  const boxWidth = clusterWidth / seriesVals.length;

  seriesVals.forEach((sv, si) => {
    xVals.forEach((xv, xi) => {
      const s = boxStats[xi][si];
      if (!s) return;
      const color = colorFor(si);
      const cx = xPos[xi] - clusterWidth / 2 + si * boxWidth + boxWidth / 2;
      const capW = boxWidth * 0.5;
      const boxW = boxWidth * 0.82;

      g.appendChild(svgEl("line", { x1: cx, x2: cx, y1: yScale(s.max), y2: yScale(s.min), stroke: color, "stroke-width": 1.5 }));
      g.appendChild(svgEl("line", { x1: cx - capW / 2, x2: cx + capW / 2, y1: yScale(s.max), y2: yScale(s.max), stroke: color, "stroke-width": 1.5 }));
      g.appendChild(svgEl("line", { x1: cx - capW / 2, x2: cx + capW / 2, y1: yScale(s.min), y2: yScale(s.min), stroke: color, "stroke-width": 1.5 }));

      const rectY = yScale(s.q3), rectH = Math.max(yScale(s.q1) - yScale(s.q3), 1);
      const rect = svgEl("rect", {
        x: cx - boxW / 2, y: rectY, width: boxW, height: rectH,
        fill: color, "fill-opacity": 0.22, stroke: color, "stroke-width": 1.5,
      });
      rect.appendChild(svgEl("title", {})).textContent =
        `${sv} \u2014 ${xv}: median ${formatNumber(s.median)}, Q1 ${formatNumber(s.q1)}, Q3 ${formatNumber(s.q3)}, ` +
        `min ${formatNumber(s.min)}, max ${formatNumber(s.max)} (n=${s.n})`;
      g.appendChild(rect);

      const medY = yScale(s.median);
      g.appendChild(svgEl("line", { x1: cx - boxW / 2, x2: cx + boxW / 2, y1: medY, y2: medY, stroke: color, "stroke-width": 2.2 }));

      if (opts.showLabels) {
        const label = svgEl("text", { class: "axis-label", x: cx, y: medY - 8, "text-anchor": "middle" });
        label.textContent = formatNumber(s.median);
        g.appendChild(label);
      }
    });
  });
}

function renderLegend(seriesVals, seriesColLabel) {
  const legend = el("legend");
  legend.innerHTML = "";
  seriesVals.forEach((sv, i) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = SERIES_COLORS[i % SERIES_COLORS.length];
    item.appendChild(swatch);
    const text = document.createElement("span");
    text.textContent = String(sv);
    item.appendChild(text);
    legend.appendChild(item);
  });
  legend.title = seriesColLabel;
}

/* ------------------------------------------------------------------ */
/* Tables + Plot data tab                                               */
/* ------------------------------------------------------------------ */
function renderSummaryTable(pivot, xAxis, showErrorbars) {
  const table = el("summaryTable");
  table.innerHTML = "";
  const { xVals, seriesVals, matrix, counts, stdMatrix } = pivot;
  if (!xVals.length) { table.innerHTML = "<tr><td>No matching data.</td></tr>"; return; }

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th")).textContent = xAxis;
  seriesVals.forEach((sv) => {
    const th = document.createElement("th");
    th.textContent = String(sv);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  xVals.forEach((xv, xi) => {
    const tr = document.createElement("tr");
    const th = document.createElement("td");
    th.textContent = String(xv);
    th.style.fontWeight = "600";
    tr.appendChild(th);
    seriesVals.forEach((sv, si) => {
      const td = document.createElement("td");
      const v = matrix[xi][si];
      const n = counts[xi][si];
      td.textContent = formatNumber(v);
      if (v !== null && showErrorbars) {
        const stdSpan = document.createElement("span");
        stdSpan.className = "cell-count";
        stdSpan.textContent = ` \u00b1${formatNumber(stdMatrix[xi][si])}`;
        td.appendChild(stdSpan);
      }
      if (v !== null && n > 1) {
        const countSpan = document.createElement("span");
        countSpan.className = "cell-count";
        countSpan.textContent = `\u00d7${n}`;
        td.appendChild(countSpan);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function renderSummaryTableBox(pivot, xAxis) {
  const table = el("summaryTable");
  table.innerHTML = "";
  const { xVals, seriesVals, boxStats } = pivot;
  if (!xVals.length) { table.innerHTML = "<tr><td>No matching data.</td></tr>"; return; }

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th")).textContent = xAxis;
  seriesVals.forEach((sv) => {
    const th = document.createElement("th");
    th.textContent = String(sv);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  xVals.forEach((xv, xi) => {
    const tr = document.createElement("tr");
    const th = document.createElement("td");
    th.textContent = String(xv);
    th.style.fontWeight = "600";
    tr.appendChild(th);
    seriesVals.forEach((sv, si) => {
      const td = document.createElement("td");
      const s = boxStats[xi][si];
      if (s) {
        td.textContent = `${formatNumber(s.median)} [${formatNumber(s.q1)}\u2013${formatNumber(s.q3)}]`;
        const extra = document.createElement("span");
        extra.className = "cell-count";
        extra.textContent = `(${formatNumber(s.min)}\u2013${formatNumber(s.max)}, n=${s.n})`;
        td.appendChild(document.createElement("br"));
        td.appendChild(extra);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function buildPlotDataTSV(xAxis, xVals, seriesVals, cellText) {
  const header = [xAxis, ...seriesVals.map(String)].join("\t");
  const lines = [header];
  xVals.forEach((xv, xi) => {
    const cells = seriesVals.map((sv, si) => cellText(xi, si));
    lines.push([String(xv), ...cells].join("\t"));
  });
  return lines.join("\n");
}

function renderPlotData(pivot, xAxis) {
  const { xVals, seriesVals, matrix } = pivot;
  const text = xVals.length
    ? buildPlotDataTSV(xAxis, xVals, seriesVals, (xi, si) => {
        const v = matrix[xi][si];
        return v === null ? "" : formatNumber(v);
      })
    : "";
  el("plotDataText").value = text;
}

function renderPlotDataBox(pivot, xAxis) {
  const { xVals, seriesVals, boxStats } = pivot;
  const text = xVals.length
    ? buildPlotDataTSV(xAxis, xVals, seriesVals, (xi, si) => {
        const s = boxStats[xi][si];
        return s ? formatNumber(s.median) : "";
      })
    : "";
  el("plotDataText").value = text;
}

const RAW_TABLE_LIMIT = 500;

function renderRawTable(rows) {
  const table = el("rawTable");
  table.innerHTML = "";
  if (!rows.length) { table.innerHTML = "<tr><td>No matching data.</td></tr>"; return; }

  const cols = state.columns;
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  cols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.slice(0, RAW_TABLE_LIMIT).forEach((row) => {
    const tr = document.createElement("tr");
    cols.forEach((c) => {
      const td = document.createElement("td");
      const v = row[c];
      td.textContent = v === null || v === undefined ? "" : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  if (rows.length > RAW_TABLE_LIMIT) {
    const note = document.createElement("caption");
    note.style.captionSide = "bottom";
    note.style.textAlign = "left";
    note.style.padding = "6px 10px";
    note.style.color = "var(--ink-soft)";
    note.textContent = `Showing first ${RAW_TABLE_LIMIT} of ${rows.length} rows.`;
    table.appendChild(note);
  }
}

/* ------------------------------------------------------------------ */
/* Main render                                                          */
/* ------------------------------------------------------------------ */
function updateControlAvailability(kind) {
  const xType = el("xType");
  const agg = el("agg");
  xType.disabled = kind === "bars" || kind === "candlestick";
  xType.title = xType.disabled ? "Bars/candlestick always use equally-spaced positions" : "";
  agg.disabled = kind === "candlestick";
  agg.title = agg.disabled ? "Candlestick always shows the full quartile spread, not an aggregate" : "";
}

function render() {
  if (!state.columns.length) return;

  const kind = el("kind").value;
  updateControlAvailability(kind);

  const xAxis = el("xAxis").value;
  const seriesCol = el("seriesCol").value;
  const yAxis = el("yAxis").value;
  const agg = el("agg").value;
  const xType = el("xType").value;
  const showLabels = el("showLabels").checked;
  const trimLow = clampInt(el("trimLow").value, 0);
  const trimHigh = clampInt(el("trimHigh").value, 0);
  const trimGroupCols = parseCommaList(el("trimGroupCols").value);

  const filteredRows = applyColumnFilters(state.rows);
  let seriesCount = 0;
  let xCount = 0;

  if (kind === "candlestick") {
    const pivot = buildBoxPivot(filteredRows, xAxis, seriesCol, yAxis, trimLow, trimHigh, trimGroupCols);
    renderCandlestickChart(pivot, { xAxis, yAxis, xType, showLabels });
    renderLegend(pivot.seriesVals, seriesCol);
    renderSummaryTableBox(pivot, xAxis);
    renderPlotDataBox(pivot, xAxis);
    seriesCount = pivot.seriesVals.length;
    xCount = pivot.xVals.length;
  } else {
    const pivot = buildPivot(filteredRows, xAxis, seriesCol, yAxis, agg, trimLow, trimHigh, trimGroupCols);
    renderChart(pivot, { xAxis, yAxis, kind, xType, showLabels, errorbars: agg === "errorbars" });
    renderLegend(pivot.seriesVals, seriesCol);
    renderSummaryTable(pivot, xAxis, agg === "errorbars");
    renderPlotData(pivot, xAxis);
    seriesCount = pivot.seriesVals.length;
    xCount = pivot.xVals.length;
  }

  renderRawTable(filteredRows);

  el("mainTitle").textContent = `${yAxis} vs ${xAxis} by ${seriesCol}`;
  el("mainMeta").textContent =
    `${filteredRows.length} of ${state.rows.length} rows \u00b7 ${seriesCount} series \u00b7 ${el("mode").value.toUpperCase()}`;
  el("chartEmpty").style.display = xCount ? "none" : "flex";
}

/* ------------------------------------------------------------------ */
/* Wiring                                                               */
/* ------------------------------------------------------------------ */
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      el("summaryTableWrap").classList.toggle("hidden", tab !== "summary");
      el("plotDataWrap").classList.toggle("hidden", tab !== "plotdata");
      el("rawTableWrap").classList.toggle("hidden", tab !== "raw");
    });
  });
}

function setupCopyButton() {
  el("copyPlotDataBtn").addEventListener("click", async () => {
    const text = el("plotDataText").value;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const ta = el("plotDataText");
      ta.select();
      document.execCommand("copy");
    }
    const btn = el("copyPlotDataBtn");
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1200);
  });
}

function init() {
  setupTabs();
  setupCopyButton();
  buildColumnFilterRows();

  el("chooseFolderBtn").addEventListener("click", () => el("folderInput").click());
  el("folderInput").addEventListener("change", handleFolderSelected);
  el("loadUrlBtn").addEventListener("click", () => loadFromUrl(el("manifestUrl").value.trim()));
  el("manifestUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadFromUrl(el("manifestUrl").value.trim());
  });

  el("mode").addEventListener("change", applyFileFilters);
  el("benchmarks").addEventListener("input", debounce(applyFileFilters, 250));
  el("platforms").addEventListener("input", debounce(applyFileFilters, 250));

  ["agg", "kind", "xType", "xAxis", "seriesCol", "yAxis", "showLabels"].forEach((id) => {
    el(id).addEventListener("change", render);
  });
  ["trimLow", "trimHigh"].forEach((id) => {
    el(id).addEventListener("input", debounce(render, 250));
  });
  el("trimGroupCols").addEventListener("input", debounce(render, 250));
}

document.addEventListener("DOMContentLoaded", init);
