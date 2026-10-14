# Development and validation

This page covers how to run capdelta's checks, fixtures, and false-positive check. Back to the [README](../README.md).

Development setup and the checks CI runs are in
[CONTRIBUTING.md](../CONTRIBUTING.md#development-setup); run them locally before
opening a pull request.

Tests use inert handcrafted lockfiles and tarballs; package code is never run.
Golden pairs cover each PLAN §4.4 severity row (`test/fixtures/golden/`), and
attack reconstructions cover documented incidents
(`test/fixtures/reconstructions/`).
CI executes the suite on Node.js 20, 22, and 24 and verifies that the committed
Action bundle is reproducible.

The post-M3 false-positive harness inspects adjacent recent, nondeprecated,
stable npm releases:

```bash
npm run fp-check -- --bumps 3 lodash react minimist
```

Its selection is not a legitimacy attestation. It emits JSON summaries and
returns exit `2` when a package or bump could not be analyzed. The required
informal run covered 20 packages and 60 bumps; see the
[recorded results and interpretation](fp-corpus-2026-07-29.md). This is a
pre-M4 tuning exercise, not the formal M5 false-positive measurement.
