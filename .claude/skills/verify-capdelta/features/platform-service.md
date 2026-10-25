# Platform service

`capdelta-platform` (`dist/platform-cli.js`) is the v2 service: `monitor`, `analyze`,
`serve [--reviewers file]` and `reviewer-token --name <n>`. It lives in
`src/platform/` and never changes `src/core/`. ADR-038 to ADR-041 are the designs and
`docs/platform.md` is the operator guide.

## What proves it

- `src/platform/e2e.test.ts` runs monitor, queue, worker and API against a fake
  registry (`src/platform/test-registry.ts`). It needs no network.
- `src/platform/intel-e2e.test.ts` covers findings, reviewer transitions and the feed.
- `bin/intel-drive` proves the CLI against a real `serve` process (see
  [Intelligence lookup](./intel-lookup.md)).

```sh
npx vitest run src/platform/e2e.test.ts src/platform/intel-e2e.test.ts
```

## Live registry check

Run `monitor` once against `registry.npmjs.org` into a scratch data directory. The
first cycle stores the `update_seq` cursor and queues nothing, so run it twice. Then
`analyze` drains the queue. Check the counts with the API (`/v1/releases`,
`/v1/jobs`). Expect a few percent of releases stored as `incomplete`, not failures.
Last measured: 136 releases analyzed, 0 failed, 15 incomplete.

## Gotchas

- Registry data is attacker-controlled. The collector pins the origin, rejects
  redirects and caps bytes. Never relax those to make a drive pass.
- The write route does not exist without `--reviewers`. A 404 on a transition means
  the flag is missing, not that the finding is gone.
- Put TLS in front before binding beyond localhost. The service speaks plain http.
