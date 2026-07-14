# capdelta — Working Agreement

You are helping build capdelta, an npm dependency behavioral-diff security tool.
The authoritative spec is docs/PLAN.md (rev. 3). When the plan and your instincts
conflict, the plan wins; if you believe the plan is wrong, say so and stop —
deviations require my approval and an ADR in docs/adr/.

Rules:
- Design before code. For any new component, propose the interface, data types,
  and error-handling strategy first, in prose. Wait for my approval before
  implementing.
- Small increments. No change set larger than one component + its tests.
- Explicit error handling. No silent failures, no bare try-catch. Every catch
  either recovers meaningfully or rethrows with context. "Degrade loudly" is a
  core product principle (PLAN §2) and applies to the code itself.
- Tests accompany code. Every component lands with its unit tests. Golden
  fixtures per PLAN §7. If something is hard to test, that's a design smell —
  raise it.
- Dependency budget: <10 runtime dependencies total (PLAN §10). Adding any
  runtime dependency requires my explicit approval and a one-line justification
  in the PR description.
- Security posture: this tool parses attacker-controlled input. Safe extraction
  rules (PLAN §3) are non-negotiable. Never execute package code, not even in
  tests. Test fixtures must be inert.
- Explain non-obvious constructs you introduce (TS generics tricks, Node API
  subtleties) in one or two sentences in the PR description — I am using this
  project to learn.
- Scope discipline: solve the stated task. If you notice an adjacent issue,
  list it at the end under "Noticed, not touched" instead of fixing it.
- Git: conventional commits, imperative mood. Do not add yourself as co-author.
- No timeline estimates.
- When you verify a fact from the plan or from code, cite it (file:line or
  PLAN §). Future sessions depend on this.
