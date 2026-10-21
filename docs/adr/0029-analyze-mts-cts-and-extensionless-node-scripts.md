# ADR-029: Analyze .mts, .cts and extensionless Node scripts

- **Status:** Proposed
- **Date:** 2026-10-22
- **Plan reference:** PLAN §2 (degrade loudly), §4 (capability extraction)

## Context

`src/core/npm/javascript-capability-extractor.ts` analyzes `.js`, `.mjs`,
`.cjs` and `.ts`. Every other file is skipped with no diagnostic. That skips
two kinds of runnable code:

- `.mts` and `.cts` are the ESM and CommonJS forms of the same TypeScript that
  ADR-028 already analyzes. A bump can put a `fetch` in one and capdelta
  reports nothing.
- npm links `bin` targets such as `bin/cli`, and Node runs an extensionless
  file whose first line is `#!/usr/bin/env node`. A bump can add a new `bin`
  script with any capability and capdelta reports nothing.

## Decision

1. Send `.mts` and `.cts` through the TypeScript path with the same amaro
   strip-only mode and failure handling as `.ts`. `.d.mts` and `.d.cts` stay
   skipped like `.d.ts`. The parser `sourceType` is `module` for `.mts`,
   `script` for `.cts` and `either` for `.ts`, which matches how Node assigns
   a module form to each file kind.
2. Take the extension from the last dot in the basename, so `.js` is a
   JavaScript file and a dot in a directory name does not count. Read the
   first 1024 bytes of a basename with no dot. Analyze the file as
   JavaScript when the first line starts with `#!` and contains the word
   `node`. Then read the file in full with the same `maxSourceBytes` limit and
   failure diagnostics as every other source file. The parser `sourceType` is
   `either` because Node chooses ESM or CommonJS for an extensionless entry
   from the package type and from the syntax it finds.
3. Leave every other extension skipped, including `.tsx` and `.jsx`. Node does
   not run those without a transform, so analyzing them would add noise.
4. A failed hashbang probe is an `unparseable-source` diagnostic rather than a
   silent skip, so an unreadable extensionless file cannot hide a script
   without notice.

## Alternatives rejected

- Parse every extensionless file as JavaScript. README and LICENSE files
  would become parse diagnostics, and arbitrary text would be treated as
  code.
- Follow only the `package.json` `bin` map. It misses extensionless scripts
  invoked through `scripts` or directly by path, and it does not say which
  files Node can run.
- Read the whole file before deciding whether it is a Node script. The probe
  bounds the decision read so the first line cannot make capdelta read an
  attacker-sized file twice.
- Give `.mts` and `.cts` the `either` source type. `.cts` is CommonJS, so an
  `import` there cannot run; parsing it as a module would analyze code Node
  rejects.

## Consequences

- Capabilities in `.mts`, `.cts` and shebang scripts now reach the differ and
  the report. A new extensionless script can raise a HIGH endpoint finding.
- `.mts` and `.cts` that use syntax strip-only mode rejects become
  `unsupported-source`, the same loud outcome `.ts` already has.
- An extensionless file whose first line exceeds 1024 bytes, with `node` after
  that cutoff, is skipped. Shebang lines are far shorter, so the gap is small;
  widen the probe if a real package needs it.
- Revisit if Node changes how it detects the module form of extensionless
  files or stops running `.mts` and `.cts`.
