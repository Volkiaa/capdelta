# Development and validation

This page covers how to run capdelta's checks, fixtures, and false-positive check. Back to the [README](../README.md).

Development setup and the checks CI runs are in
[CONTRIBUTING.md](../CONTRIBUTING.md#development-setup); run them locally before
opening a pull request.

Tests use inert handcrafted lockfiles and tarballs; package code is never run.
Golden pairs cover each PLAN §4.4 severity row (`test/fixtures/golden/`), and
attack reconstructions cover documented incidents
(`test/fixtures/reconstructions/`). After an intended report change, run
`npx vitest run <golden test file> -u` to rewrite the `expected-*` files, then
review the diff. Put `-u` after the test file path because vitest reads the next
argument as the update type.
CI executes the suite on Node.js 20, 22, and 24 and verifies that the committed
Action bundle is reproducible.

## Updating bundled dependencies

Dependabot groups every package that changes `dist/action/` into one pull
request. The group is `action-bundle` in `.github/dependabot.yml` and covers
the `@actions/*` packages, `@vercel/ncc`, `acorn`, `acorn-walk`,
`jsonc-parser`, `tar`, and `typescript`. A bump in that group leaves the
committed bundle stale, so `check:action` fails on the pull request. That
failure is intended.

To rebuild the bundle:

1. Check out the Dependabot branch and merge `main` into it if the branch is
   behind. Commit or stash every tracked change first: the script stops when a
   tracked file is modified. Untracked files do not block it.
2. Run `scripts/package-action-sandboxed.sh`.
3. Review the `dist/action/` diff the script prints.
4. Commit with `build(action): rebuild dist/action for <PR>` and push the
   branch without force.

The script never mounts the checkout. It sends `git archive HEAD` into a
container that holds no credentials and installs with `npm ci --ignore-scripts`,
then rebuilds and verifies the bundle with no network. Only `dist/action` comes
back, and only after validation. The rebuilt bundle must hold exactly the files
`git ls-files dist/action` lists, all regular files, and be under 50 MiB.
Anything else is rejected and leaves the checkout unchanged. If a dependency bump
legitimately adds or removes a bundle file, the script rejects it, and you
rebuild that case by hand after reading what changed.

Do not run `npm ci` or the verification commands on the host for a Dependabot
branch. That would run the updated dependency code with your credentials on your
machine. Let the container run the tests, and let CI run `check:action` on the
push.

No workflow rebuilds the bundle. A job that builds updated dependency code
would run that code during the build and would need a token that can write to
the branch, so the token would be reachable from code no one has reviewed. A
person reviews the bundle diff and commits instead.

The script pins the container image by digest. Dependabot cannot see that
digest, so bump it by hand when a newer Node.js image is wanted.

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
