# Contributing to capdelta

capdelta is public but remains an unpublished, pre-release security tool. Small,
well-evidenced contributions are welcome.

## Before changing code

1. Read the authoritative [development plan](docs/PLAN.md), especially the
   threat model in §3 and the component boundary you intend to change.
2. Read the accepted [architecture decisions](docs/adr/).
3. For a new component, propose its interface, data types, and error-handling
   strategy before implementation. Product deviations require maintainer
   approval and an ADR.
4. Keep a pull request to one component and its tests. Record adjacent issues
   under **Noticed, not touched** rather than expanding scope.

## Security constraints

All analyzed input is attacker-controlled. Package code must never be imported,
evaluated, or executed—not even in tests. Fixtures must be inert. Extraction,
parsing, reporting, and subprocess changes must preserve explicit resource
limits and the project's **degrade loudly** rule (PLAN §2-§3).

Do not disclose suspected vulnerabilities in an issue or ordinary pull request;
follow [SECURITY.md](SECURITY.md).

## Development setup

Node.js 20 or newer and npm are required:

```bash
npm ci
npm run build
```

Before opening a pull request, run the same checks as CI:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run check:deps
npm run check:action
```

Tests must accompany behavior changes. Use inert handcrafted fixtures and exact
golden outputs where the plan requires them (PLAN §7). If behavior is difficult
to test, raise the design problem before merging it.

## Dependencies and commits

The project permits fewer than ten direct runtime dependencies (PLAN §10).
Adding one requires explicit maintainer approval and a one-line justification
in the pull-request description.

Use conventional commits in imperative mood, for example:

```text
feat(core): detect URL-domain changes
fix(action): preserve critical finding priority
docs: refresh public usage guide
```

Do not add AI tools or assistants as co-authors.
