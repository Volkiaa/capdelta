# Programmatic API

This page covers using capdelta as a library instead of through the CLI or the Action. Back to the [README](../README.md).

The package also exposes the ecosystem-agnostic analysis library. Until the
first release, this API is available from a local build and may still evolve:

```ts
import {
  analyzeChangedPackages,
  diffNpmLockfiles,
  renderJsonRunReport,
} from "capdelta";

const lockfileDiff = diffNpmLockfiles(parsedBaseLockfile, parsedHeadLockfile);
const run = await analyzeChangedPackages(lockfileDiff);
const json = renderJsonRunReport(run);
```

Public exports include the capability-set contract, npm lockfile/fetch/extract
adapters, analysis execution policy, Differ, JSON/text/SARIF reporters, and
typed failure taxonomies.
