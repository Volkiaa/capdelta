# ADR-046: Serve a read-only status page from the platform service

- **Status:** Accepted (agent, 2026-10-26, Tier 1 under CLAUDE.md "Autonomy")
- **Date:** 2026-10-26
- **Plan reference:** PLAN §3 (attacker-controlled strings), docs/platform.md, docs/v2-roadmap.md phase 3

## Context

The platform API answers only lookups by name, version or digest. Nobody can see which releases the monitor analyzed or which findings exist without already knowing a name. A reviewer has to read JSON files. Release names, versions, evidence excerpts and reasons all come from packages, so they are attacker-controlled.

## Decision

The service gains two read routes and one page, all GET, none authenticated (same trust model as the existing read API).

- `GET /v1/recent/releases?limit=N` returns the N most recently analyzed releases, newest first, as compact rows: `name`, `version`, `previousVersion`, `digest`, `analyzedAt`, `status`, `incompleteReasons` (count only), and the report's `summary.bySeverity`. `limit` defaults to 50 and is capped at 200. The route lstats every record file once, streams the directory, keeps the 1000 newest by modification time in memory, reads only those, and orders them by `analyzedAt`. Memory and record reads are bounded; the lstat pass grows with the store.
- `GET /v1/recent/findings?limit=N&verdict=V` returns the N most recently updated findings with the same bounds, optionally filtered to one verdict. Each row is the stored finding, including `evidence` and `history`.
- `GET /` returns one self-contained HTML page. The page calls the routes above plus `/v1/jobs` and `/v1/feed` from the same origin, refreshes every 15 seconds, and shows job counts, recent releases, findings with evidence and history, and the feed. It has no write controls.
- The HTML lives in a TypeScript module as a string constant, so `tsc` ships it with no copy step. The response carries `Content-Security-Policy: default-src 'none'; script-src 'sha256-<hash of the inline script>'; style-src 'sha256-<hash of the inline style>'; connect-src 'self'; base-uri 'none'; form-action 'none'` and `X-Content-Type-Options: nosniff`. The hashes are computed from the constants at module load.
- The page writes every string from the API with `textContent`. It never uses `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`, and never turns a value into a link (PLAN §3).

## Alternatives rejected

- **Server-rendered HTML.** Every field would need escaping on the server, and a missed escape is a stored XSS from package data. A static page with `textContent` has no such path.
- **A persistent index of releases.** It adds a new record kind and a write path for a convenience view. The bounded scan is enough at the current volume (hundreds of records).
- **Reviewer buttons in the page.** They need a token in the browser and a CSRF story. Reading comes first.

## Consequences

The maintainer can watch the monitor work in a browser. The routes read the same records as the existing API and change no verdict, report or gate. Each request costs one directory read and one lstat per record, so the cost grows with the store while memory and record reads stay bounded. Codex flagged this in review; an index would remove it and was rejected for now. Revisit when the store passes about 10,000 releases (add an index) or when reviewers want to act from the page (new ADR).

Git: conventional commits, imperative mood, no Co-Authored-By trailer. Never run package code. No new runtime dependency. Every catch recovers or rethrows with context. Keep any comment that states a security reason.

## Hard rules

- Work only inside this worktree. Don't push, open PRs, or change anything on a remote.
- Commit your work on the current branch, following the repo's commit conventions (its CLAUDE.md, CONTRIBUTING file, or recent `git log`). Never stage `.task.md` or `NOTES.md`.
- Before you finish, run every command under "Verification" in the ticket. Fix failures you caused. Report failures you didn't cause in NOTES.
- When you're done, or blocked, write `NOTES.md` in the worktree root and leave it uncommitted. Keep it under 40 lines; the orchestrator reads it in full. Put failures and open questions first. It must contain:
  - each change as `file:line` with a one-line description
  - test counts: passed, failed, skipped
  - the result of each verification command
  - a "Noticed, not touched" list of problems you saw outside the ticket's scope
- If the ticket is unclear or you're blocked, write the question in NOTES and stop. A wrong guess costs more than a stop.

## Method

### Test-driven development

Work in a red → green loop. These rules apply on every cycle.

Read `GLOSSARY.md` if the repo has one, so test names match the project's domain language. Respect the ADRs in the area you touch.

#### What a good test is

A test checks behavior through public interfaces, not implementation details. The code can change entirely and the test still passes. A good test reads like a specification: "user can checkout with valid cart" names a capability, and it survives refactors because it doesn't depend on internal structure.

```typescript
// GOOD: tests observable behavior through the interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});

// BAD: bypasses the interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});
```

#### Seams: where tests go

A seam is the public boundary you test at. Tests live at seams, never against internals. Test only at the seams the brief lists. If the brief lists none, pick the smallest set that covers the critical paths, and list each one in NOTES with a line on what it catches and what it misses.

#### Mocking

Mock only at system boundaries: external APIs, time, randomness, and sometimes the database or filesystem (prefer a test database). Leave your own modules and internal collaborators unmocked. Pass external dependencies in as parameters so a test can swap them.

#### Anti-patterns

- **Implementation-coupled.** The test mocks internal collaborators, tests private methods, asserts on call counts or order, or verifies through a side channel. The tell is that it breaks on a refactor that leaves behavior unchanged.
- **Tautological.** The assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`), so it passes by construction. Expected values come from an independent source: a known literal, a worked example, the spec.
- **Horizontal slicing.** Writing all the tests first and then all the code. Work in vertical slices instead: one test, then the code that passes it, then the next test.

#### Rules of the loop

- Write the failing test first and watch it fail. Then write only enough code to pass it.
- Do one seam, one test and one minimal implementation per cycle.
- Leave refactoring for review. Record refactors you'd make under "Noticed, not touched" in NOTES.

## Writing rules

Apply these to all prose you write: NOTES, commit messages, code comments, docs.


### Unslop

Edit text to remove AI patterns. Scan for the patterns below, then rewrite. Preserve meaning and match the intended tone.

#### Patterns to detect and fix

Rule numbers are stable ids that other skills cite. A removed rule leaves a gap.

##### Content

3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete or expand with real sources.
5. **Vague attributions.** "Experts believe", "Industry reports suggest", "Some critics argue". Name the source or delete.

##### Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Replace with plain words.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".
9. **"Not just X, but Y."** State the point directly instead.
10. **Rule of three.** Don't force ideas into groups of three. Use the natural number.
11. **Synonym cycling.** Protagonist, main character, central figure, hero all in one paragraph. Pick one, repeat it.
12. **False ranges.** "from X to Y" where X and Y aren't on a meaningful scale. List topics directly.

##### Style

13. **Em dash overuse.** Avoid em dashes entirely. Use periods or commas only (no parentheses, no en dashes, no hyphen-as-dash substitutes). If a thought needs separation, end the sentence or use a comma.
14. **Colon overuse.** Colons are fine before a list or example, not as mid-sentence connectors. "If you're coming from traditional automation: instead of registering event handlers, you describe conditions" adds nothing with the colon. Rewrite to let the point stand on its own without comparison framing. "Describing when the scheduler should fire works best as plain English." Same meaning, no crutch punctuation.
15. **Boldface overuse.** Don't bold every proper noun or acronym.
16. **Inline-header lists.** The tell is a bold label and colon that restates the line: "**Performance:** Performance improved...". Convert those to prose. A bold lead-in that ends in a period, names the item, and is followed by genuinely new detail ("**Schema in TypeScript.** Tables live in one file.") is fine, not a tell.
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove from headings and bullets.
19. **Curly quotes.** Use straight quotes.

##### Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Of course!", "Certainly!", "Found the smoking gun!" Remove.
22. **Sycophantic tone.** "Great question! You're absolutely right!" Respond directly.

##### Filler

23. **Filler phrases.** "In order to" becomes "To". "Due to the fact that" becomes "Because". Delete "It is important to note that".
24. **Excessive hedging.** "could potentially possibly be argued that it might" becomes "may".
25. **Generic conclusions.** "The future looks bright." State specific plans or facts.

##### Jargon

26. **Abstract metaphor nouns.** Substrate (base), wedge, wedge in (add), vector (way, method), locus, vantage, nexus, primitive as a noun, harness as a metaphor, surface as in "API surface", bedrock, scaffolding as a metaphor, modality, paradigm, gold-plating (more than the job needs), ratchet as a metaphor (the mechanism's real name, or a limit that only tightens), evacuate for moving code (move out), endgame (the last phase), north star, flywheel. These read as technical but usually have a plainer concrete word. Pick the concrete word.

##### Plain speech

27. **Say what it does, not how it feels.** "the database stays close at hand", "SQL you can read", "types that follow your schema" name a feeling. The fix names the mechanism or a number: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". Ask what the sentence tells the reader to do or know, then write that. If you can't restate it as a concrete instruction, fact, or number, cut it. One more check: if the sentence could appear unchanged in another project's docs, it says nothing about this one. Cut it.
28. **Shorten or split dense sentences.** If the reader has to backtrack to parse a sentence, break it in two or drop clauses. One idea per sentence.
29. **Active voice.** Prefer it. Catch "is/are/was/were + past participle" and name the actor: "queries are validated" becomes "the compiler validates queries", "the file is parsed by the loader" becomes "the loader parses the file". Passive is fine only when the actor is unknown or genuinely doesn't matter.
30. **Cut adverbs, or use a stronger verb.** "runs quickly" becomes "is fast" or the number, and "significantly improves" becomes the measured delta. An adverb propping up a weak verb means the verb is wrong.
31. **Prefer the plain word.** "utilize" and "leverage" become "use", "facilitate" becomes "help", "numerous" becomes "many", "in the event that" becomes "if". The fancier synonym is rarely clearer.
32. **Mannered prose.** Metaphor or flourish where a literal phrase exists: aphorisms ("wire it or delete it"), rhetorical fragments for effect, personified code ("the plan holds it"), figurative verbs ("rides along", "stands on"), stock framing phrases. "A dial worth turning" becomes "a parameter worth varying". Say what you mean. Rule 26 covers the metaphor nouns.
33. **Over-compression.** Dropped articles, verbless fragments, symbol-speak, and abbreviations that make the reader decode instead of read. "Parser rejects bad date → exit 2, no write" becomes "The parser rejects a bad date, exits with code 2, and writes nothing." Write whole sentences with their articles and verbs, and spell out arrows and abbreviations.
