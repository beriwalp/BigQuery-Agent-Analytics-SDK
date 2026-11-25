// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Headless smoke test for dashboards/power_bi/copilot/app.js.
//
// Usage: node tests/power_bi_copilot_smoke.js dashboards/power_bi/copilot/app.js
//
// Boots the app against a minimal DOM stub built from the element ids in
// index.html, then drives it through prompts, SQL generation, import, and CSV
// export. Exits non-zero with a list of failures.
'use strict';

// Zone-less UTC timestamps must not shift with the browser's time zone, so run
// in a zone west of UTC where a late-evening event would move to the next day.
process.env.TZ = 'America/Los_Angeles';

const fs = require('fs');
const path = require('path');

const appPath = path.resolve(process.argv[2]);
const html = fs.readFileSync(path.join(path.dirname(appPath), 'index.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

class StubElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => ((on === undefined ? !classes.has(c) : on) ?
                              classes.add(c) :
                              classes.delete(c)),
    };
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  fire(type, extra) {
    const event = Object.assign({preventDefault() {}, target: this}, extra || {});
    (this.listeners[type] || []).forEach((fn) => fn(event));
  }
  // One stable child per selector, so code that renders into
  // card.querySelector('.vis-body') can be inspected afterwards.
  querySelector(selector) {
    this.queried = this.queried || {};
    if (!this.queried[selector]) {
      this.queried[selector] = new StubElement();
      created.push(this.queried[selector]);
    }
    return this.queried[selector];
  }
  // Returns stub elements for the tags in innerHTML that match a simple
  // selector (tag, .class, [attr], and :not(.class)), with their data-*
  // attributes, so the app's event binding runs and tests can fire them.
  querySelectorAll(selector) {
    const m = selector.match(/^(\w+)?((?:\.[\w-]+|\[[\w-]+\])*)(?::not\(\.([\w-]+)\))?$/);
    if (!m) return [];
    const [, tag, rest, notClass] = m;
    const classes = [...(rest || '').matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
    const attrs = [...(rest || '').matchAll(/\[([\w-]+)\]/g)].map((x) => x[1]);
    const found = [];
    for (const t of this.innerHTML.matchAll(/<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
      const attrMap = Object.fromEntries([...t[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)]
          .map((a) => [a[1], a[2] ?? '']));
      const cls = (attrMap.class || '').split(/\s+/);
      if (tag && t[1] !== tag) continue;
      if (!classes.every((c) => cls.includes(c))) continue;
      if (!attrs.every((a) => a in attrMap)) continue;
      if (notClass && cls.includes(notClass)) continue;
      const el = new StubElement();
      for (const [k, v] of Object.entries(attrMap)) {
        if (k.startsWith('data-')) {
          el.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] =
              v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                  .replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
        }
      }
      found.push(el);
    }
    this.matched = (this.matched || []).concat(found);
    return found;
  }
  appendChild(child) {
    return child;
  }
  getBoundingClientRect() {
    return {width: 10, height: 10};
  }
  requestSubmit() {
    this.fire('submit');
  }
  focus() {}
  click() {}
}

// Every element the app creates or queries, for checks on rendered charts.
const created = [];
const els = Object.fromEntries(ids.map((id) => [id, new StubElement(id)]));
els.slicerDate.value = '30';
const missing = new Set();
const downloads = [];

global.document = {
  documentElement: {setAttribute() {}},
  getElementById(id) {
    if (!els[id]) {
      missing.add(id);
      els[id] = new StubElement(id);
    }
    return els[id];
  },
  querySelectorAll: () => [],
  createElement: () => {
    const el = new StubElement();
    created.push(el);
    return el;
  },
};
global.window = {matchMedia: () => ({matches: false}), innerWidth: 1280, innerHeight: 800};
global.Blob = class {
  constructor(parts) {
    downloads.push(parts.join(''));
  }
};
Object.assign(URL, {createObjectURL: () => 'blob:stub', revokeObjectURL() {}});

require(appPath);

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

check(missing.size === 0, `app.js reads missing element ids: ${[...missing].join(', ')}`);
check(/kpi-card/.test(els.kpiGrid.innerHTML), 'the default page renders KPI cards');
check(els.pageTitle.textContent === 'Agent Activity Overview', 'default page title');

const prompts = [
  ['Show p95 LLM latency and time to first token by model', 'Latency'],
  ['Token usage and cache hit rate by agent', 'Token Consumption & Caching'],
  ['Which tools fail most, with recent error messages', 'Errors'],
  ['Tool usage: tool calls by agent and the tool mix', 'Tool Usage'],
  ['Compare events by event type as a pie', 'Events by Event type'],
  ['Overview of sessions and users for the last 7 days', 'Agent Activity Overview'],
];
for (const [prompt, title] of prompts) {
  els.promptInput.value = prompt;
  els.promptForm.fire('submit');
  check(els.pageTitle.textContent === title,
      `"${prompt}" built "${els.pageTitle.textContent}", want "${title}"`);
  check(!/NaN|undefined/.test(els.kpiGrid.innerHTML + els.smartNarrative.innerHTML),
      `"${prompt}" renders NaN or undefined`);
}
check(els.slicerDate.value === '7', '"last 7 days" sets the window slicer');

els.btnShowSql.fire('click');
const sql = els.sqlModalCode.textContent;
check(sql.includes('CREATE TEMP TABLE events AS'), 'SQL creates the temp table');
check(sql.includes('FROM `your-project.your_dataset.agent_events`'), 'SQL reads the table');
check(sql.includes('INTERVAL 7 DAY'), 'SQL uses the selected window');
check(sql.includes('DECLARE window_end DATE'),
    'SQL anchors the window on the newest day with data, like the page');
check(/GROUP BY period/.test(sql), 'KPI SQL returns the previous window too');
els.tableIdInput.value = 'bad`; DROP TABLE x; --.a.b';
els.tableIdInput.fire('input');
check(els.tableIdError.textContent !== '', 'an invalid table id shows an error');
check(els.sqlModalCode.textContent === '' && els.btnCopySql.disabled === true,
    'an invalid table id clears the SQL and disables Copy SQL');

const quotedAgent = 'o\'brien\\agent';
els.importText.value = JSON.stringify([
  {
    timestamp: '2026-07-16T10:00:00Z', event_type: 'LLM_RESPONSE', agent: quotedAgent,
    session_id: 's1', user_id: 'u1',
    latency_ms: {total_ms: 1200, time_to_first_token_ms: 300},
    attributes: {model: 'm1', usage_metadata: {prompt_token_count: 100,
      cached_content_token_count: 40, total_token_count: 150}},
  },
  {
    timestamp: '1784196000', event_type: 'TOOL_ERROR',
    agent: '<img src=x onerror=alert(1)>', session_id: 's2', user_id: 'u2',
    content: '{"tool":"run_query"}', latency_ms: '{"total_ms": 900}',
    status: 'ERROR', error_message: 'boom, "quoted"',
  },
  {event_type: 'LLM_RESPONSE'},
]);
els.btnApplyImport.fire('click');
check(/Loaded 2 rows; skipped 1/.test(els.importStatus.textContent),
    `import status: ${els.importStatus.textContent}`);
check(!els.slicerAgent.innerHTML.includes('<img'), 'agent names are escaped in the slicer');

els.slicerAgent.fire('change', {target: {value: quotedAgent}});
els.tableIdInput.value = 'my-project.my_dataset.agent_events';
els.btnShowSql.fire('click');
check(els.sqlModalCode.textContent.includes('agent = \'o\\\'brien\\\\agent\''),
    'agent names are escaped as SQL string literals');

els.slicerAgent.fire('change', {target: {value: 'ALL'}});
els.btnExportCsv.fire('click');
const csv = downloads[downloads.length - 1];
check(csv.includes('"boom, ""quoted"""'), 'CSV export quotes fields per RFC 4180');
els.importText.value = csv;
els.btnApplyImport.fire('click');
check(/Loaded 2 rows\./.test(els.importStatus.textContent),
    `CSV export re-imports: ${els.importStatus.textContent}`);

// Returns the rows of a CSV export as objects keyed by header.
const csvRows = (text) => {
  const [header, ...lines] = text.split('\r\n');
  const cols = header.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
};

// Formula-leading text is neutralized on export and restored on re-import.
els.importText.value = JSON.stringify([
  {timestamp: '2026-07-16 23:30:00', event_type: 'TOOL_ERROR', agent: '@SUM(A1)',
    status: 'ERROR', error_message: '=HYPERLINK("http://x.test","y")'},
  {timestamp: '2026-07-16 22:00:00 UTC', event_type: 'LLM_RESPONSE', agent: 'a2',
    error_message: '\tcmd', attributes: {usage_metadata: {total_tokens: 77}}},
  {timestamp: '2026-07-15T08:00:00Z', event_type: 'LLM_RESPONSE', agent: 'a3',
    content: {usage: {total: 55}}},
]);
els.btnApplyImport.fire('click');
check(/Loaded 3 rows\./.test(els.importStatus.textContent),
    `formula rows import: ${els.importStatus.textContent}`);
els.btnExportCsv.fire('click');
const guarded = downloads[downloads.length - 1];
check(guarded.includes('\'@SUM(A1)'), 'an @-leading cell is prefixed on export');
check(guarded.includes('"\'=HYPERLINK(""http://x.test"",""y"")"'),
    'an =-leading cell is prefixed before quoting');
check(guarded.includes('\'\tcmd'), 'a tab-leading cell is prefixed on export');
check(!/(^|,)[=@+\-]/m.test(guarded.replace(/"[^"]*"/g, '')),
    'no exported cell starts with a formula character');

// Zone-less timestamps are UTC, whatever the local time zone.
const exported = csvRows(guarded);
check(exported.some((r) => r.timestamp === '2026-07-16T23:30:00.000Z' &&
    r.event_date === '2026-07-16'), 'a zone-less timestamp is read as UTC');
check(exported.some((r) => r.timestamp === '2026-07-16T22:00:00.000Z'),
    'a "UTC"-suffixed timestamp is read as UTC');

// Token totals from the SDK logger and from content.usage.
check(exported.some((r) => r.agent === 'a2' && r.total_tokens === '77'),
    'usage_metadata.total_tokens is read');
check(exported.some((r) => r.agent === 'a3' && r.total_tokens === '55'),
    'content.usage.total is read');

els.importText.value = guarded;
els.btnApplyImport.fire('click');
check(/Loaded 3 rows\./.test(els.importStatus.textContent),
    `guarded CSV re-imports: ${els.importStatus.textContent}`);
check(els.slicerAgent.innerHTML.includes('@SUM(A1)') &&
    !els.slicerAgent.innerHTML.includes('\'@SUM'),
    'the formula guard is removed on re-import');

// Export honours the explorer search box.
els.tableSearch.value = 'a3';
els.btnExportCsv.fire('click');
const searched = csvRows(downloads[downloads.length - 1]);
check(searched.length === 1 && searched[0].agent === 'a3',
    `export follows the explorer search: ${searched.length} rows`);
els.tableSearch.value = '';

// A malformed JSON Lines row is skipped and counted, not fatal.
els.importText.value = [
  JSON.stringify({timestamp: '2026-07-16T10:00:00Z', event_type: 'LLM_RESPONSE'}),
  '{not json',
].join('\n');
els.btnApplyImport.fire('click');
check(/Loaded 1 rows; skipped 1/.test(els.importStatus.textContent),
    `malformed line import: ${els.importStatus.textContent}`);

// Nearest-rank P95: nineteen 1 ms calls and one 1,000 ms call give 1 ms.
els.importText.value = JSON.stringify(Array.from({length: 20}, (_, i) => ({
  timestamp: `2026-07-16T10:00:${String(i).padStart(2, '0')}Z`,
  event_type: 'LLM_RESPONSE', agent: 'p', latency_ms: {total_ms: i === 19 ? 1000 : 1},
})));
els.btnApplyImport.fire('click');
els.promptInput.value = 'Show p95 LLM latency and time to first token by model';
els.promptForm.fire('submit');
check(/>1 ms</.test(els.kpiGrid.innerHTML) && !/1,000 ms</.test(els.kpiGrid.innerHTML),
    'P95 uses the nearest rank');

// The donut SQL folds the tail into "Other", like the chart.
els.promptInput.value = 'Compare events by event type as a pie';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(els.sqlModalCode.textContent.includes('CONCAT(\'Other (\''),
    'donut SQL folds the tail into Other');

// Charts escape labels, and clicking a bar cross-filters the page.
els.importText.value = JSON.stringify([
  {timestamp: '2026-07-16T10:00:00Z', event_type: 'TOOL_COMPLETED',
    agent: '<img src=x onerror=alert(1)>', status: 'ERROR', error_message: 'bad',
    content: {tool: 't1'}, latency_ms: {total_ms: 10}},
  {timestamp: '2026-07-16T10:01:00Z', event_type: 'TOOL_COMPLETED', agent: 'ok',
    status: 'OK', content: {tool: 't1'}, latency_ms: {total_ms: 20}},
]);
els.btnApplyImport.fire('click');
els.promptInput.value = 'Which tools fail most, with recent error messages';
els.promptForm.fire('submit');
check(!created.some((e) => /<img/i.test(e.innerHTML)),
    'chart labels are HTML-escaped');
check(/50\.0%/.test(els.kpiGrid.innerHTML),
    `a TOOL_COMPLETED call with status ERROR counts as an error: ${
        (els.kpiGrid.innerHTML.match(/[\d.]+%/) || [])[0]}`);
check(created.some((e) => /bad/.test(e.innerHTML) && /Recent|Error/.test(e.innerHTML) ||
    /<td[^>]*>bad<\/td>/.test(e.innerHTML)), 'the errored call is in Recent errors');
const clickables = created.flatMap((e) => e.matched || [])
    .filter((e) => e.dataset.idx !== undefined && (e.listeners.click || []).length);
check(clickables.length > 0, 'chart members get click handlers');
// Per-day members can't be filtered, so try members until one filters.
let filtered = false;
for (const el of clickables) {
  el.fire('click');
  if (/filter-pill/.test(els.filterPills.innerHTML)) {
    filtered = true;
    break;
  }
}
check(filtered, 'clicking a chart member cross-filters');
els.btnClearFilters.fire('click');

// Missing trace IDs and token fields stay missing, as in the SQL.
els.importText.value = JSON.stringify([{timestamp: '2026-07-16T10:00:00Z',
  event_type: 'LLM_RESPONSE', invocation_id: 'inv-1', agent: 'a'}]);
els.btnApplyImport.fire('click');
els.promptInput.value = 'Token usage and cache hit rate by agent';
els.promptForm.fire('submit');
check(!/>0</.test(els.kpiGrid.innerHTML) && /--/.test(els.kpiGrid.innerHTML),
    'missing token fields show -- rather than 0');
els.btnExportCsv.fire('click');
check(csvRows(downloads[downloads.length - 1])[0].trace_id === '',
    'a missing trace id does not fall back to the invocation id');

// Prompt parsing: metric before "by", dimension after; "new page" adds one.
const pagesBefore = els.pageTabs.innerHTML;
els.modeModifyPage.fire('click');
els.promptInput.value = 'add tool calls by agent';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/SELECT\n  agent,\n  COUNTIF\(event_type IN \('TOOL_COMPLETED'/.test(els.sqlModalCode.textContent),
    '"add tool calls by agent" counts tool calls by agent');
els.promptInput.value = 'add events by user';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/SELECT\n  user_id,\n  COUNT\(\*\) AS events/.test(els.sqlModalCode.textContent),
    '"add events by user" counts events by user');
els.btnAddBlankPromptPage.fire('click');
check(els.modeNewPage.classList.contains('active') &&
    !els.modeModifyPage.classList.contains('active'),
    '"+ Prompt a new page" switches to new-page mode');
els.modeModifyPage.fire('click');
els.promptInput.value = 'Make a new page with a bar chart of llm calls by model';
els.promptForm.fire('submit');
check(els.pageTitle.textContent === 'LLM calls by Model',
    `"make a new page ..." adds a page: ${els.pageTitle.textContent}`);
els.modeNewPage.fire('click');

// Tables: switch to table and back; a table visual shows its own metric.
els.promptInput.value = 'switch to table';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/GROUP BY model/.test(els.sqlModalCode.textContent),
    'a chart switched to a table keeps its metric and dimension');
els.promptInput.value = 'switch to bar chart';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/GROUP BY model\nHAVING llm_calls IS NOT NULL\nORDER BY llm_calls DESC, model\nLIMIT 8;/
    .test(els.sqlModalCode.textContent), 'a table switches back to a bar chart');

// SQL: anchor fallback, null measures, date top-N, row-list latency.
const pageSql = els.sqlModalCode.textContent;
check(/IF window_end IS NULL THEN/.test(pageSql),
    'the window anchor falls back when the table has no recent data');
check(/HAVING llm_calls IS NOT NULL/.test(pageSql), 'groups with no value are dropped');
els.promptInput.value = 'Show p95 LLM latency and time to first token by model';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/total_ms IS NOT NULL\nORDER BY total_ms DESC/.test(els.sqlModalCode.textContent),
    'the slowest-calls SQL skips calls with no latency');
els.promptInput.value = 'switch to bar';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/ORDER BY event_date DESC\nLIMIT 8\n\)\nORDER BY event_date;/.test(
    els.sqlModalCode.textContent), 'a per-day bar chart queries the newest 8 days');

// The formula guard round-trips values that already start with an
// apostrophe, and other CSVs keep a leading apostrophe.
els.importText.value = JSON.stringify(['\'@x', '\'=x', '\'--flag', '@x'].map((agent, i) => ({
  timestamp: `2026-07-16T10:00:0${i}Z`, event_type: 'LLM_RESPONSE', agent})));
els.btnApplyImport.fire('click');
els.btnExportCsv.fire('click');
els.importText.value = downloads[downloads.length - 1];
els.btnApplyImport.fire('click');
els.btnExportCsv.fire('click');
const agents = csvRows(downloads[downloads.length - 1]).map((r) => r.agent).sort();
check(JSON.stringify(agents) === JSON.stringify(['\'\'--flag', '\'\'=x', '\'\'@x', '\'@x']),
    `apostrophe-leading values round-trip: ${JSON.stringify(agents)}`);
els.importText.value = 'timestamp,event_type,error_message\r\n' +
    '2026-07-16T10:00:00Z,TOOL_ERROR,\'--flag\r\n';
els.btnApplyImport.fire('click');
els.tableSearch.value = '';
els.btnExportCsv.fire('click');
check(csvRows(downloads[downloads.length - 1])[0].error_message === '\'\'--flag',
    'a CSV from elsewhere keeps its leading apostrophe');

// Timestamps: microsecond epochs, exponent notation, short/spaced offsets.
els.importText.value = JSON.stringify([
  {timestamp: '1784196000000000', event_type: 'LLM_RESPONSE', agent: 'us'},
  {timestamp: '1.784196E9', event_type: 'LLM_RESPONSE', agent: 'exp'},
  {timestamp: '2026-07-16 10:00:00+00', event_type: 'LLM_RESPONSE', agent: 'o1'},
  {timestamp: '2026-07-16 10:00:00 +00:00', event_type: 'LLM_RESPONSE', agent: 'o2'},
  {timestamp: '99999999999999999999', event_type: 'LLM_RESPONSE', agent: 'huge'},
]);
els.btnApplyImport.fire('click');
check(/Loaded 4 rows; skipped 1/.test(els.importStatus.textContent),
    `timestamp forms import: ${els.importStatus.textContent}`);

// A damaged first JSON Lines record doesn't send the paste to the CSV parser.
const goodLine = JSON.stringify(
    {timestamp: '2026-07-16T10:00:00Z', event_type: 'LLM_RESPONSE'});
els.importText.value = ['"timestamp": "2026-07-16T10:00"}', goodLine, goodLine]
    .join('\n');
els.btnApplyImport.fire('click');
check(/Loaded 2 rows; skipped 1/.test(els.importStatus.textContent),
    `damaged first JSON Lines record: ${els.importStatus.textContent}`);

// A failed LLM_RESPONSE counts in the error rate, on the page and in SQL.
els.importText.value = JSON.stringify([
  {timestamp: '2026-07-16T10:00:00Z', event_type: 'LLM_RESPONSE', agent: 'a',
    status: 'ERROR', error_message: 'quota'},
  {timestamp: '2026-07-16T10:01:00Z', event_type: 'LLM_RESPONSE', agent: 'a',
    status: 'OK'},
]);
els.btnApplyImport.fire('click');
els.promptInput.value = 'Which tools fail most, with recent error messages';
els.promptForm.fire('submit');
check(/50\.0%/.test(els.kpiGrid.innerHTML),
    `an error-status LLM_RESPONSE counts in the error rate: ${
        (els.kpiGrid.innerHTML.match(/[\d.]+%/) || [])[0]}`);
els.btnShowSql.fire('click');
const errSql = els.sqlModalCode.textContent;
check(/event_type IN \('LLM_RESPONSE', 'TOOL_COMPLETED'\) AND status = 'ERROR'/.test(errSql),
    'the error-rate SQL counts error-status responses');
check(/COALESCE\(NULLIF\(UPPER\(status\), ''\), 'OK'\) AS status/.test(errSql),
    'SQL upper-cases status once and treats a missing one as OK, like the page');
check(/COALESCE\(NULLIF\(JSON_VALUE\(@@ATTRIBUTES@@, '\$\.model'\), ''\)/.test(errSql),
    'an empty attributes.model falls back to model_version in SQL');
check(/TIMESTAMP '0001-01-01'/.test(errSql), 'the fallback anchor covers pre-1970 timestamps');

// No cached-token telemetry shows unknown; an explicit zero is a real 0%.
els.importText.value = JSON.stringify([{timestamp: '2026-07-16T10:00:00Z',
  event_type: 'LLM_RESPONSE', agent: 'a',
  attributes: {usage_metadata: {prompt_token_count: 100, total_token_count: 120}}}]);
els.btnApplyImport.fire('click');
els.promptInput.value = 'Token usage and cache hit rate by agent';
els.promptForm.fire('submit');
check(!/>0\.0%</.test(els.kpiGrid.innerHTML),
    'missing cache telemetry is not shown as a 0% hit rate');
els.importText.value = JSON.stringify([{timestamp: '2026-07-16T10:00:00Z',
  event_type: 'LLM_RESPONSE', agent: 'a', attributes: {usage_metadata: {
    prompt_token_count: 100, cached_content_token_count: 0, total_token_count: 120}}}]);
els.btnApplyImport.fire('click');
check(/>0\.0%</.test(els.kpiGrid.innerHTML), 'an explicit zero cached count is 0%');

// An export with multiline diagnostics re-imports as CSV.
const diag = 'trace:\n{"code": 1}\n{"code": 2}\n{"code": 3}';
els.importText.value = JSON.stringify([0, 1, 2].map((i) => ({
  timestamp: `2026-07-16T10:00:0${i}Z`, event_type: 'TOOL_ERROR', agent: 'm',
  status: 'ERROR', error_message: diag})));
els.btnApplyImport.fire('click');
els.btnExportCsv.fire('click');
els.importText.value = downloads[downloads.length - 1];
els.btnApplyImport.fire('click');
check(/Loaded 3 rows\./.test(els.importStatus.textContent),
    `a multiline export re-imports: ${els.importStatus.textContent}`);

// A CSV from elsewhere with the same 21 data columns keeps its apostrophe.
const dataCols = downloads[downloads.length - 1].split('\r\n')[0].split(',')
    .filter((c) => c !== 'copilot_formula_guard');
check(dataCols.length === 21, `export has 21 data columns: ${dataCols.length}`);
els.importText.value = dataCols.join(',') + '\r\n' + dataCols.map((c) =>
    (c === 'timestamp' ? '2026-07-16T10:00:00Z' :
     c === 'event_type' ? 'TOOL_ERROR' : c === 'error_message' ? '\'--flag' : ''))
    .join(',') + '\r\n';
els.btnApplyImport.fire('click');
els.btnExportCsv.fire('click');
check(csvRows(downloads[downloads.length - 1])[0].error_message === '\'\'--flag',
    'a same-column CSV from elsewhere keeps its leading apostrophe');

// ===== Follow-ups from issue #611 =====

// Returns the SQL statement for the KPI query, so checks don't match text
// elsewhere in the script.
const kpiSql = (sqlText) => (sqlText.split(';').find((st) => /AS period/.test(st)) || '');

// 1. An agent literally named "agent" doesn't turn "by agent" into a filter.
els.importText.value = JSON.stringify([
  {timestamp: '2026-07-16T10:00:00Z', event_type: 'LLM_RESPONSE', agent: 'agent'},
  {timestamp: '2026-07-16T10:01:00Z', event_type: 'LLM_RESPONSE', agent: 'other'},
]);
els.btnApplyImport.fire('click');
els.promptInput.value = 'LLM calls by agent';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(!/agent = 'agent'/.test(els.sqlModalCode.textContent),
    '"by agent" does not filter to an agent named agent');
els.promptInput.value = 'LLM calls for "agent"';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/agent = 'agent'/.test(els.sqlModalCode.textContent),
    'a quoted member name still filters');
els.btnResetPage.fire('click');

// 2. "Failed calls only" keeps failed events that have no status.
els.importText.value = JSON.stringify([
  {timestamp: '2026-07-16T10:00:00Z', event_type: 'LLM_ERROR', agent: 'a'},
  {timestamp: '2026-07-16T10:01:00Z', event_type: 'TOOL_ERROR', agent: 'a',
    content: {tool: 't'}},
  {timestamp: '2026-07-16T10:02:00Z', event_type: 'LLM_RESPONSE', agent: 'a',
    status: 'OK'},
]);
els.btnApplyImport.fire('click');
els.promptInput.value = 'Which tools fail most, failed calls only';
els.promptForm.fire('submit');
check(/100\.0%/.test(els.kpiGrid.innerHTML),
    `failed calls only keeps status-less failures: ${
        (els.kpiGrid.innerHTML.match(/[\d.]+%|--/) || [])[0]}`);
els.btnShowSql.fire('click');
check(/WHERE[\s\S]*event_type IN \('LLM_ERROR', 'TOOL_ERROR'\) OR/.test(
    kpiSql(els.sqlModalCode.textContent)), 'failed calls only uses the failed-call rule in SQL');
els.btnResetPage.fire('click');

// 3. Cached tokens in content.usage count; absent stays distinct from zero.
els.importText.value = JSON.stringify([
  {timestamp: '2026-07-16T10:00:00Z', event_type: 'LLM_RESPONSE', agent: 'a',
    content: {usage: {prompt: 100, cached_tokens: 80, total: 120}}},
  {timestamp: '2026-07-16T10:01:00Z', event_type: 'LLM_RESPONSE', agent: 'a',
    attributes: {usage_metadata: {prompt_token_count: 100,
      cached_content_token_count: 0, total_token_count: 120}}},
]);
els.btnApplyImport.fire('click');
els.promptInput.value = 'Token usage and cache hit rate by agent';
els.promptForm.fire('submit');
check(/>40\.0%</.test(els.kpiGrid.innerHTML), 'content.usage.cached_tokens counts (80 + 0 of 200 = 40%)');
els.btnShowSql.fire('click');
check(/\$\.usage\.cached_tokens/.test(els.sqlModalCode.textContent),
    'SQL reads content.usage.cached_tokens');

// 4 + 6. Missing payload columns and UTC day boundaries.
const fuSql = els.sqlModalCode.textContent;
check(/INFORMATION_SCHEMA\.COLUMNS/.test(fuSql) && /EXECUTE IMMEDIATE/.test(fuSql) &&
    /IF\('attributes' IN UNNEST\(present\), 'attributes',/.test(fuSql),
    'the temp table only reads payload columns that exist');
check(!/\bDATE\(timestamp\)/.test(fuSql) && /DATE\(timestamp, 'UTC'\)/.test(fuSql) &&
    /INTERVAL 1 DAY\), 'UTC'\)/.test(fuSql), 'SQL day boundaries are UTC');

// 7. A line over a category is capped and its SQL has a LIMIT.
els.importText.value = JSON.stringify(Array.from({length: 15}, (_, i) => ({
  timestamp: `2026-07-16T10:${String(i).padStart(2, '0')}:00Z`,
  event_type: 'LLM_RESPONSE', agent: 'a', session_id: `s${i}`, user_id: `u${i}`})));
els.btnApplyImport.fire('click');
els.promptInput.value = 'Sessions by user';
els.promptForm.fire('submit');
els.promptInput.value = 'switch to line';
els.promptForm.fire('submit');
const userLines = created.map((e) => e.innerHTML)
    .filter((h) => /<polyline/.test(h) && />u\d+<\/text>/.test(h));
check(userLines.length > 0 && userLines.every(
    (h) => (h.match(/<circle[^>]*data-idx=/g) || []).length === 10),
    'a categorical line plots its top 10 members');
// A point on the user line cross-filters; per-day points don't offer to.
const userDot = created.filter((e) => /<polyline/.test(e.innerHTML) &&
    />u\d+<\/text>/.test(e.innerHTML)).flatMap((e) => e.matched || [])
    .find((e) => (e.listeners.click || []).length);
check(Boolean(userDot), 'categorical line points get a click handler');
if (userDot) {
  userDot.fire('click');
  check(/filter-pill/.test(els.filterPills.innerHTML), 'clicking a categorical line point filters');
  els.btnClearFilters.fire('click');
}
els.promptInput.value = 'switch to bar';
els.promptForm.fire('submit');
const dayBar = created.filter((e) => /class="chart-bar"/.test(e.innerHTML) &&
    /2026-07-16/.test(e.innerHTML)).flatMap((e) => e.matched || [])
    .find((e) => (e.listeners.mousemove || []).length);
check(Boolean(dayBar), 'per-day bars render');
if (dayBar) {
  dayBar.fire('mousemove', {clientX: 0, clientY: 0});
  check(!/Click to cross-filter/.test(els.chartTooltip.innerHTML),
      'per-day bars do not claim to cross-filter');
}
els.promptInput.value = 'switch to line';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/GROUP BY user_id\nHAVING sessions IS NOT NULL\nORDER BY sessions DESC, user_id\nLIMIT 10;/
    .test(els.sqlModalCode.textContent), 'a categorical line SQL has LIMIT 10');

// 8. The formula guard covers a trigger after ";" or a tab, reversibly.
els.importText.value = JSON.stringify(['x;=1+1;y', 'a\t@b', 'p;\'=q', 'plain;text']
    .map((agent, i) => ({timestamp: `2026-07-16T10:00:0${i}Z`, event_type: 'LLM_RESPONSE', agent})));
els.btnApplyImport.fire('click');
els.btnExportCsv.fire('click');
const midCsv = downloads[downloads.length - 1];
check(midCsv.includes('x;\'=1+1;y') && midCsv.includes('a\t\'@b'),
    'a formula trigger after ; or a tab is neutralized');
els.importText.value = midCsv;
els.btnApplyImport.fire('click');
els.btnExportCsv.fire('click');
check(downloads[downloads.length - 1] === midCsv, 'the mid-cell guard round-trips');

// Smaller: microseconds keep the order of same-millisecond rows.
els.importText.value = JSON.stringify([
  {timestamp: '2026-07-16 10:00:00.123400 UTC', event_type: 'TOOL_ERROR', agent: 'first',
    status: 'ERROR', error_message: 'first'},
  {timestamp: '2026-07-16 10:00:00.123900 UTC', event_type: 'TOOL_ERROR', agent: 'second',
    status: 'ERROR', error_message: 'second'},
]);
els.btnApplyImport.fire('click');
els.btnExportCsv.fire('click');
const usRows = csvRows(downloads[downloads.length - 1]);
check(usRows[0].agent === 'second' && usRows[0].timestamp === '2026-07-16T10:00:00.123900Z',
    `microseconds are kept for order and export: ${usRows.map((r) => r.timestamp).join(', ')}`);

// Smaller: the error-rate check looks at the KPI query's own expression.
els.promptInput.value = 'Which tools fail most, with recent error messages';
els.promptForm.fire('submit');
els.btnShowSql.fire('click');
check(/100 \* SAFE_DIVIDE\(COUNTIF\(\(event_type IN \('LLM_ERROR', 'TOOL_ERROR'\) OR \(event_type IN \('LLM_RESPONSE', 'TOOL_COMPLETED'\) AND status = 'ERROR'\)\)\), COUNTIF\(event_type IN \('LLM_RESPONSE', 'LLM_ERROR', 'TOOL_COMPLETED', 'TOOL_ERROR'\)\)\) AS error_rate/
    .test(kpiSql(els.sqlModalCode.textContent)), 'the KPI error-rate expression uses the failed-call rule');

// Smaller: a row-capped import doesn't compare against a partial window.
els.importText.value = JSON.stringify(Array.from({length: 12}, (_, i) => ({
  timestamp: `2026-07-${String(5 + i).padStart(2, '0')}T10:00:00Z`,
  event_type: 'LLM_RESPONSE', agent: 'a', session_id: `s${i}`})));
els.btnApplyImport.fire('click');
els.slicerDate.fire('change', {target: {value: '7'}});
els.promptInput.value = 'Overview of sessions and users';
els.promptForm.fire('submit');
check(!/[+-]\d+(\.\d+)?%/.test(els.kpiGrid.innerHTML.replace(/class="kpi-value[\s\S]*?<\/div>/g, '')),
    'deltas need a fully covered previous window');

if (failures.length) {
  console.error(`FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`ok: ${prompts.length} prompts, ${ids.length} element ids`);
