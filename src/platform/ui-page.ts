import { createHash } from "node:crypto";

/**
 * A first-evidence path is a display hint, not a verdict. A path counts as a
 * test path when a segment is exactly `test`, `tests`, `_test` or `__tests__`,
 * or the basename matches `*.test.*`, `*.spec.*`, `*.bench.*` or `*.fuzz.*`.
 *
 * The status page embeds this function's source, so the unit-tested predicate
 * and the browser code are the same code.
 */
export function isTestEvidencePath(file: string): boolean {
  const segments = file.replace(/\\/g, "/").split("/");
  const basename = segments[segments.length - 1] ?? "";
  if (
    segments.some(
      (segment) =>
        segment === "test" ||
        segment === "tests" ||
        segment === "_test" ||
        segment === "__tests__",
    )
  ) {
    return true;
  }
  return /\.(test|spec|bench|fuzz)\.[^/]+$/.test(basename);
}

export interface ReleaseGroupSource {
  name?: unknown;
  version?: unknown;
  bySeverity?: Record<string, unknown> | null;
}

export interface FindingGroupSource {
  name?: unknown;
  version?: unknown;
  severity?: unknown;
  ruleKey?: unknown;
  evidence?: readonly { file?: unknown }[] | null;
}

export interface ReleaseGroupRow {
  name: string;
  version: string;
  severity: string;
  findingCount: string;
  reason: string;
  noise: boolean;
}

/**
 * Rows for the flagged releases table. Severity is the worst one the report
 * counts or the loaded findings carry, so it is never lowered. The noise flag
 * is a display hint only: the row keeps its real severity.
 *
 * The status page embeds this function's source for the same reason as
 * `isTestEvidencePath`.
 */
export function groupFlaggedReleases(
  releases: readonly ReleaseGroupSource[],
  findings: readonly FindingGroupSource[],
): ReleaseGroupRow[] {
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
  const text = (value: unknown): string => {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return String(value);
    }
    return "";
  };
  const countOf = (
    counts: Record<string, unknown> | null | undefined,
    name: string,
  ): number => {
    if (counts === null || counts === undefined) return 0;
    const count = Number(counts[name]);
    return Number.isFinite(count) && count > 0 ? count : 0;
  };
  const countText = (
    counts: Record<string, unknown> | null | undefined,
  ): string =>
    severities
      .map((name) => name + " " + String(countOf(counts, name)))
      .join(", ");
  const kindOf = (ruleKey: unknown): string => {
    const key = text(ruleKey);
    const colon = key.indexOf(":");
    return colon === -1 ? key : key.slice(colon + 1);
  };
  const reasonFor = (related: readonly FindingGroupSource[]): string => {
    if (related.length === 0) return "no finding detail loaded";
    const counts: Record<string, number> = {};
    let best = "";
    let bestCount = 0;
    for (const finding of related) {
      const kind = kindOf(finding.ruleKey);
      if (kind === "") continue;
      const count = (counts[kind] ?? 0) + 1;
      counts[kind] = count;
      if (
        count > bestCount ||
        (count === bestCount && (best === "" || kind < best))
      ) {
        best = kind;
        bestCount = count;
      }
    }
    return best === "" ? "no rule key" : best + " x" + String(bestCount);
  };
  const worstFor = (
    counts: Record<string, unknown> | null | undefined,
    related: readonly FindingGroupSource[],
  ): string => {
    let worst = severities.length;
    for (let index = 0; index < severities.length; index += 1) {
      const name = severities[index];
      if (name !== undefined && countOf(counts, name) > 0) {
        worst = index;
        break;
      }
    }
    for (const finding of related) {
      const index = severities.indexOf(text(finding.severity));
      if (index !== -1 && index < worst) worst = index;
    }
    return worst === severities.length ? "none" : (severities[worst] ?? "none");
  };
  const isNoise = (
    release: ReleaseGroupSource,
    related: readonly FindingGroupSource[],
  ): boolean => {
    if (text(release.version).startsWith("0.0.0-")) return true;
    const high = related.filter((finding) => {
      const severity = text(finding.severity);
      return severity === "CRITICAL" || severity === "HIGH";
    });
    // An empty list would make every() true, so require a loaded finding.
    if (high.length === 0) return false;
    return high.every((finding) => {
      const evidence: readonly { file?: unknown }[] = Array.isArray(
        finding.evidence,
      )
        ? (finding.evidence as readonly { file?: unknown }[])
        : [];
      const first = evidence.length > 0 ? evidence[0] : undefined;
      if (first === undefined) return false;
      return isTestEvidencePath(text(first.file));
    });
  };

  const rows: ReleaseGroupRow[] = [];
  for (const release of releases) {
    const name = text(release.name);
    const version = text(release.version);
    const related = findings.filter(
      (finding) =>
        text(finding.name) === name && text(finding.version) === version,
    );
    const counts = release.bySeverity ?? null;
    const flagged =
      countOf(counts, "CRITICAL") > 0 ||
      countOf(counts, "HIGH") > 0 ||
      related.some((finding) => {
        const severity = text(finding.severity);
        return severity === "CRITICAL" || severity === "HIGH";
      });
    if (!flagged) continue;
    rows.push({
      name,
      version,
      severity: worstFor(counts, related),
      findingCount:
        related.length > 0 ? String(related.length) : countText(counts),
      reason: reasonFor(related),
      noise: isNoise(release, related),
    });
  }
  return rows;
}

/**
 * The page is static. The browser code reads the API with fetch and writes
 * every value with textContent, so a package name or evidence excerpt can
 * never become markup. The CSP below allows only these exact bytes.
 */
export const STATUS_PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f5f5f2;
  --fg: #1b1b19;
  --muted: #5d5d57;
  --line: #d8d8d2;
  --panel: #ffffff;
  --accent: #0b5fff;
  --error: #a30000;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121311;
    --fg: #ecece8;
    --muted: #a3a39b;
    --line: #33352f;
    --panel: #1b1d19;
    --accent: #8ab4ff;
    --error: #ff8a8a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.4;
}
header {
  padding: 1rem;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
h1 { margin: 0 0 0.25rem; font-size: 1.35rem; }
h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
h3 { margin: 0 0 0.35rem; font-size: 1rem; }
h4 { margin: 1rem 0 0.35rem; font-size: 0.95rem; }
main {
  display: grid;
  gap: 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem;
}
section { min-width: 0; }
.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
}
.counts li { display: flex; align-items: baseline; gap: 0.35rem; color: var(--muted); }
.counts strong { color: var(--fg); font-size: 1.1rem; }
.hint, #updated { color: var(--muted); font-size: 0.9rem; }
#error { color: var(--error); font-weight: 600; }
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
.finding-row { cursor: pointer; }
.finding-row:hover, .finding-row:focus {
  outline: none;
  background: rgba(11, 95, 255, 0.12);
}
.detail {
  margin-top: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
.detail[hidden] { display: none; }
.detail-item { margin: 0.5rem 0; }
pre {
  margin: 0.25rem 0;
  padding: 0.5rem;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  border-radius: 6px;
  background: var(--bg);
}
.feed { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
.feed li {
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
.feed p { margin: 0.35rem 0 0; }
.feed .meta { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; color: var(--muted); font-size: 0.85rem; }
summary { margin: 0.75rem 0 0.5rem; cursor: pointer; font-weight: 600; }
details .table-wrap { margin-top: 0.5rem; }
@media (max-width: 640px) {
  main { gap: 1rem; padding: 0.75rem; }
  table, thead, tbody, tr, th, td { display: block; }
  thead { display: none; }
  tr { border-bottom: 1px solid var(--line); padding: 0.35rem 0; }
  td { border: 0; padding: 0.3rem 0.6rem; }
  td::before { content: attr(data-label) ": "; color: var(--muted); font-weight: 600; }
}
`;

export const STATUS_PAGE_SCRIPT = `
"use strict";
const REFRESH_MS = 15000;
const JOBS = "/v1/jobs";
const RELEASES = "/v1/recent/releases?limit=50";
const FINDINGS = "/v1/recent/findings?limit=50";
const FEED = "/v1/feed?limit=100";
const STATES = ["pending", "running", "done", "failed"];
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

${isTestEvidencePath.toString()}

${groupFlaggedReleases.toString()}

const nodes = {
  updated: document.getElementById("updated"),
  error: document.getElementById("error"),
  jobCounts: document.getElementById("job-counts"),
  releases: document.getElementById("releases-body"),
  flagged: document.getElementById("flagged-body"),
  noise: document.getElementById("noise-body"),
  noiseSummary: document.getElementById("noise-summary"),
  findings: document.getElementById("findings-body"),
  detail: document.getElementById("finding-detail"),
  feed: document.getElementById("feed-list"),
};
let busy = false;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function cell(tag, text, label) {
  const node = element(tag, text);
  node.setAttribute("data-label", label);
  return node;
}

function clear(node) {
  if (node === null) return;
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function text(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error("HTTP " + String(response.status) + " for " + path);
  }
  return response.json();
}

function emptyRow(tbody, columns, message) {
  const row = element("tr");
  const cellNode = element("td", message);
  cellNode.colSpan = columns;
  row.append(cellNode);
  tbody.append(row);
}

function renderJobs(body) {
  clear(nodes.jobCounts);
  const counts = body && body.counts ? body.counts : {};
  for (const state of STATES) {
    const item = element("li");
    const value = counts[state] === undefined ? 0 : counts[state];
    item.append(element("span", state), element("strong", text(value)));
    nodes.jobCounts.append(item);
  }
  const failed = body && Array.isArray(body.failed) ? body.failed : [];
  if (failed.length > 0) {
    const item = element("li");
    item.append(element("span", "showing " + String(failed.length) + " failed"));
    nodes.jobCounts.append(item);
  }
}

function severityText(value) {
  const counts = value || {};
  return SEVERITIES.map(function (name) {
    const count = counts[name] === undefined ? 0 : counts[name];
    return name + " " + text(count);
  }).join(", ");
}

function renderReleases(body) {
  clear(nodes.releases);
  const rows = body && Array.isArray(body.releases) ? body.releases : [];
  if (rows.length === 0) {
    emptyRow(nodes.releases, 6, "No releases yet.");
    return;
  }
  for (const release of rows) {
    const row = element("tr");
    const previous = release.previousVersion === null || release.previousVersion === undefined
      ? "first release"
      : text(release.previousVersion);
    row.append(
      cell("td", text(release.name), "Package"),
      cell("td", text(release.version), "Version"),
      cell("td", previous, "Previous"),
      cell("td", text(release.analyzedAt), "Analyzed"),
      cell("td", text(release.status), "Status"),
      cell("td", severityText(release.bySeverity), "Severity"),
    );
    nodes.releases.append(row);
  }
}

function releaseGroupRow(row) {
  const elementRow = element("tr");
  elementRow.append(
    cell("td", text(row.name), "Package"),
    cell("td", text(row.version), "Version"),
    cell("td", text(row.severity), "Worst severity"),
    cell("td", text(row.findingCount), "Findings"),
    cell("td", text(row.reason), "Reason"),
  );
  return elementRow;
}

function renderReleaseGroups(releasesBody, findingsBody) {
  clear(nodes.flagged);
  clear(nodes.noise);
  const releases = releasesBody && Array.isArray(releasesBody.releases) ? releasesBody.releases : [];
  const findings = findingsBody && Array.isArray(findingsBody.findings) ? findingsBody.findings : [];
  const rows = groupFlaggedReleases(releases, findings);
  let noiseCount = 0;
  for (const row of rows) {
    if (row.noise) {
      noiseCount += 1;
      nodes.noise.append(releaseGroupRow(row));
    } else {
      nodes.flagged.append(releaseGroupRow(row));
    }
  }
  if (rows.length === noiseCount) {
    emptyRow(nodes.flagged, 5, "No flagged releases.");
  }
  if (noiseCount === 0) {
    emptyRow(nodes.noise, 5, "No releases in this group.");
  }
  nodes.noiseSummary.textContent = "Probably noise (" + String(noiseCount) + ")";
}

function showFinding(finding) {
  clear(nodes.detail);
  nodes.detail.hidden = false;
  nodes.detail.append(element("h3", text(finding.name) + "@" + text(finding.version)));
  nodes.detail.append(element(
    "p",
    "Finding " + text(finding.id) + ", revision " + text(finding.revision) + ", updated " + text(finding.updatedAt),
  ));
  nodes.detail.append(element("h4", "Evidence"));
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  if (evidence.length === 0) {
    nodes.detail.append(element("p", "No evidence was recorded."));
  }
  for (const item of evidence) {
    const block = element("div");
    block.className = "detail-item";
    block.append(
      element("p", text(item.file) + ":" + text(item.line)),
      element("pre", text(item.excerpt)),
    );
    nodes.detail.append(block);
  }
  nodes.detail.append(element("h4", "History"));
  const history = Array.isArray(finding.history) ? finding.history : [];
  if (history.length === 0) {
    nodes.detail.append(element("p", "No transitions yet."));
  }
  for (const entry of history) {
    nodes.detail.append(element(
      "p",
      text(entry.at) + " " + text(entry.actor) + ": " + text(entry.from) + " to " + text(entry.to) + ". " + text(entry.reason),
    ));
  }
}

function renderFindings(body) {
  clear(nodes.findings);
  clear(nodes.detail);
  nodes.detail.hidden = true;
  const rows = body && Array.isArray(body.findings) ? body.findings : [];
  if (rows.length === 0) {
    emptyRow(nodes.findings, 5, "No findings yet.");
    return;
  }
  for (const finding of rows) {
    const row = element("tr");
    row.className = "finding-row";
    row.tabIndex = 0;
    row.append(
      cell("td", text(finding.name), "Package"),
      cell("td", text(finding.version), "Version"),
      cell("td", text(finding.severity), "Severity"),
      cell("td", text(finding.verdict), "Verdict"),
      cell("td", text(finding.summary), "Summary"),
    );
    const open = function () {
      showFinding(finding);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    nodes.findings.append(row);
  }
}

function renderFeed(body) {
  clear(nodes.feed);
  const entries = body && Array.isArray(body.entries) ? body.entries : [];
  if (entries.length === 0) {
    nodes.feed.append(element("li", "No published findings yet."));
    return;
  }
  for (const entry of entries) {
    const finding = entry && entry.finding ? entry.finding : {};
    const item = element("li");
    const meta = element("p");
    meta.className = "meta";
    meta.append(
      element("span", "Sequence " + text(entry.sequence)),
      element("span", text(finding.verdict)),
      element("span", text(finding.updatedAt)),
    );
    item.append(
      element("strong", text(finding.name) + "@" + text(finding.version)),
      meta,
      element("p", text(finding.summary)),
    );
    nodes.feed.append(item);
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const results = await Promise.all([
      getJson(JOBS),
      getJson(RELEASES),
      getJson(FINDINGS),
      getJson(FEED),
    ]);
    renderJobs(results[0]);
    renderReleases(results[1]);
    renderReleaseGroups(results[1], results[2]);
    renderFindings(results[2]);
    renderFeed(results[3]);
    nodes.error.textContent = "";
    nodes.updated.textContent = "Updated " + new Date().toLocaleTimeString();
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    nodes.error.textContent = "Refresh failed: " + message;
  } finally {
    busy = false;
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
`;

function cspHash(source: string): string {
  // CSP hashes cover the exact bytes between the tag and its closing tag.
  return createHash("sha256").update(source, "utf8").digest("base64");
}

export const STATUS_PAGE_SCRIPT_HASH = cspHash(STATUS_PAGE_SCRIPT);
export const STATUS_PAGE_STYLE_HASH = cspHash(STATUS_PAGE_STYLE);
export const STATUS_PAGE_CSP =
  `default-src 'none'; ` +
  `script-src 'sha256-${STATUS_PAGE_SCRIPT_HASH}'; ` +
  `style-src 'sha256-${STATUS_PAGE_STYLE_HASH}'; ` +
  `connect-src 'self'; base-uri 'none'; form-action 'none'`;

export const STATUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>capdelta platform</title>
<style>${STATUS_PAGE_STYLE}</style>
</head>
<body>
<header>
<h1>capdelta platform</h1>
<p id="updated">Loading...</p>
<p id="error" role="alert"></p>
<ul id="job-counts" class="counts"></ul>
</header>
<main>
<section>
<h2>Recent releases</h2>
<div class="table-wrap">
<table>
<thead>
<tr><th>Package</th><th>Version</th><th>Previous</th><th>Analyzed</th><th>Status</th><th>Severity counts</th></tr>
</thead>
<tbody id="releases-body"></tbody>
</table>
</div>
</section>
<section>
<h2>Flagged releases</h2>
<p class="hint">Releases with a CRITICAL or HIGH finding. The worst severity is never lowered.</p>
<div class="table-wrap">
<table>
<thead>
<tr><th>Package</th><th>Version</th><th>Worst severity</th><th>Findings</th><th>Reason</th></tr>
</thead>
<tbody id="flagged-body"></tbody>
</table>
</div>
<details>
<summary id="noise-summary">Probably noise (0)</summary>
<p class="hint">This group is a display hint, not a verdict. Each release keeps its real severity.</p>
<div class="table-wrap">
<table>
<thead>
<tr><th>Package</th><th>Version</th><th>Worst severity</th><th>Findings</th><th>Reason</th></tr>
</thead>
<tbody id="noise-body"></tbody>
</table>
</div>
</details>
</section>
<section>
<h2>Findings</h2>
<p class="hint">Select a row to show its evidence and history.</p>
<div class="table-wrap">
<table>
<thead>
<tr><th>Package</th><th>Version</th><th>Severity</th><th>Verdict</th><th>Summary</th></tr>
</thead>
<tbody id="findings-body"></tbody>
</table>
</div>
<div id="finding-detail" class="detail" hidden></div>
</section>
<section>
<h2>Feed</h2>
<ol id="feed-list" class="feed"></ol>
</section>
</main>
<script>${STATUS_PAGE_SCRIPT}</script>
</body>
</html>
`;
