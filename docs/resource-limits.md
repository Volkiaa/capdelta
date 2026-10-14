# Resource limits

This page lists the default caps and deadlines capdelta applies to a run, and how it reports partial work. Back to the [README](../README.md).

## Default resource limits

| Boundary                      | Default                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| Whole capability-analysis run | 5-minute deadline                                                         |
| Fetching                      | 8 concurrent requests, 30-second request timeout, 50 MiB per tarball      |
| Extraction                    | 4 concurrent packages, 10,000 entries, 250 MiB expanded data, 100:1 ratio |
| Manifest                      | 1 MiB                                                                     |
| JavaScript source             | 2 MiB per file, 5-second parser-worker deadline                           |
| CLI lockfile                  | 50 MiB                                                                    |
| CLI Git command               | 60 seconds, then soft-to-hard termination escalation                      |
| PR comment                    | 60,000 characters, 10 prioritized detail rows by default                  |

Deadline, cancellation, cleanup, parser-worker termination, and package-local
failures all degrade loudly into structured report issues. A manifest preflight
discovers install hooks safely, then the scheduler prioritizes those packages,
smaller downloads, and lockfile order while preserving report order. The full
budget record is in JSON and partial runs are called out in text and Action
summaries. Limits are exposed through the analysis-library options; the CLI
exposes report format, base ref, config, and strict mode.
