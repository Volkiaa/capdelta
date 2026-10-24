# Platform service

`capdelta-platform` watches the npm registry, analyzes each new release with the capdelta engine, stores the report, and serves it over an HTTP API. It needs no project lockfile and no Git repository. The CLI and the GitHub Action keep working without it.

Phase 1 adds collection, analysis and the read API. Phase 3 adds reviewer-confirmed findings: a findings query, a feed, an OSV view, and a write route a reviewer uses to change a verdict. The write route exists only when the service starts with a reviewers file.

## Run it

Build the project first:

```sh
npm ci --ignore-scripts
npm run build
```

`monitor` reads the npm change feed, analyzes the new releases it finds, and stores the results. The first cycle stores the current feed position and analyzes nothing. Without `--interval` it runs one cycle and exits. With `--interval` it repeats until you stop it or a cycle fails:

```sh
capdelta-platform monitor --data /var/lib/capdelta
capdelta-platform monitor --data /var/lib/capdelta --interval 60
```

Options for `monitor`:

- `--registry <url>` sets the registry base URL. The default is `https://registry.npmjs.org`.
- `--changes <url>` sets the change feed URL. The default is `https://replicate.npmjs.com/_changes`.
- `--interval <seconds>` repeats the cycle every N seconds.

`analyze` analyzes one named version now, without waiting for the feed. Use it for a version the feed has already passed:

```sh
capdelta-platform analyze --data /var/lib/capdelta --package left-pad --version 1.3.0
```

`analyze` also accepts `--registry <url>`.

`serve` starts the HTTP API. It does not collect or analyze; run `monitor` or `analyze` in another process:

```sh
capdelta-platform serve --data /var/lib/capdelta
capdelta-platform serve --data /var/lib/capdelta --port 9000 --host 127.0.0.1
capdelta-platform serve --data /var/lib/capdelta --reviewers /etc/capdelta/reviewers.json
```

The defaults are port 8787 and host 127.0.0.1. The reviewers file is optional and unlocks the transition route.

`reviewer-token` prints a new token and the reviewers-file entry that authenticates it:

```sh
capdelta-platform reviewer-token --name alice
```

The first line is the token. Show it to the reviewer once; the command writes no file. The second line is the entry to add to the reviewers file.

## Reviewers

The reviewers file is a JSON object that maps the sha256 hash of a token to a reviewer name:

```json
{
  "9f2c4b6c1d0e8a7b9c3d5e7f1a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d0e2f4a6b": "alice",
  "1a3b5c7d9e1f3a5b7c9d0e2f4a6b9f2c4b6c1d0e8a7b9c3d5e7f1a2b4c6d8e0f": "bob"
}
```

The service reads the file at startup, so restart it after a change. Without the file a transition request returns 404. A request without a token, or with a token that matches no entry, returns 401. The reviewer name comes from the token entry, never from the request body. A name may not be `analyzer`.

## Data directory

The service keeps one JSON file per record under `--data`. Keys are sha256 hex strings, except the cursor, the feed entries and the feed head:

```text
<data>/cursor/npm-changes.json          the change feed position
<data>/job/<sha256>.json                one queued, running, done, or failed job
<data>/release/<sha256>.json            one release record and its report
<data>/release-by-version/<sha256>.json version index
<data>/release-by-digest/<sha256>.json  artifact digest index
<data>/finding/<sha256>.json            one finding with its verdict and history
<data>/finding-by-package/<sha256>.json finding package index
<data>/finding-by-digest/<sha256>.json  finding artifact digest index
<data>/feed/entry-<sequence>.json       one published feed entry
<data>/feed-meta/head.json              the highest published sequence
```

Every write goes to a temporary file and then an atomic rename or link puts it in place, so a crash leaves either the old record or the new one. A corrupt record fails the read with an error instead of being treated as absent. To back up the service, stop it and copy the directory.

## API

The API answers `GET` and `HEAD`. It also answers `POST` on the transition route, and only when the service started with a reviewers file. Every other method returns 405. Every response is JSON with `content-type: application/json; charset=utf-8`.

`GET /healthz` reports that the server is up:

```sh
curl -sS http://127.0.0.1:8787/healthz
```

`GET /v1/releases/npm/<name>/<version>` returns the release records stored for one version. A scoped name is one path segment, with the slash encoded as `%2F`:

```sh
curl -sS http://127.0.0.1:8787/v1/releases/npm/left-pad/1.3.0
curl -sS "http://127.0.0.1:8787/v1/releases/npm/%40scope%2Fpkg/1.0.0"
```

`GET /v1/artifacts/<digest>` returns the records stored for one artifact digest. The digest is the registry's sha512 integrity string, URL-encoded:

```sh
curl -sS "http://127.0.0.1:8787/v1/artifacts/sha512-abc123%2Fdef%3D"
```

`GET /v1/jobs` returns the job count per state and the failed jobs. The failed list holds at most 100 entries:

```sh
curl -sS http://127.0.0.1:8787/v1/jobs
```

A failed job stays in the queue and the monitor cursor has already passed its feed event. To retry it after the registry recovers, stop the service, delete the job file, and run `analyze` for that version:

```sh
curl -sS http://127.0.0.1:8787/v1/jobs
rm /var/lib/capdelta/job/<job-id>.json
capdelta-platform analyze --data /var/lib/capdelta --package <name> --version <version>
```

The `id` field in the failed list is the file name to delete. There is no automatic retry for a failed job in phase 1.

`GET /v1/findings` returns the findings for one package version or one artifact digest. Supply `ecosystem=npm` and either `name` with an optional `version`, or `digest`. Every verdict is visible, including `suspected`:

```sh
curl -sS "http://127.0.0.1:8787/v1/findings?ecosystem=npm&name=evil-pkg&version=1.0.1"
```

`GET /v1/feed` returns the findings a reviewer published. Each entry carries a sequence, and the caller passes the last sequence back as `since`:

```sh
curl -sS "http://127.0.0.1:8787/v1/feed?since=0&limit=100"
```

A retraction keeps the confirmation entry and appends a retraction entry at a higher sequence.

`GET /v1/osv/<id>` returns the OSV record for a confirmed or retracted finding. The route returns 404 for a suspected finding:

```sh
curl -sS http://127.0.0.1:8787/v1/osv/CDI-0123456789abcdef0123
```

`POST /v1/findings/<id>/transitions` moves a finding to another verdict. The request needs a bearer token from the reviewers file and a JSON body with `to` and `reason`:

```sh
curl -sS -X POST http://127.0.0.1:8787/v1/findings/CDI-0123456789abcdef0123/transitions \
  -H "authorization: Bearer cdr_..." \
  -H "content-type: application/json" \
  -d '{"to":"confirmed-malicious","reason":"the evidence matches the incident report","validation":{"method":"manual review","evidenceRefs":[0]}}'
```

A transition to `confirmed-malicious` needs `validation` with a `method` and at least one index in `evidenceRefs` that points at the finding's evidence list. The service adds the reviewer name from the token. A transition to any other verdict must not carry a validation. An unknown body field, including `actor`, returns 400. A transition the model does not allow, such as `suspected` to `confirmed-malicious`, returns 409. So does a confirmation without a validation.

## Verdict lifecycle

The analyzer creates every finding as `suspected` and never changes the verdict. A reviewer moves it along these paths only:

| From                  | To                              |
| --------------------- | ------------------------------- |
| `suspected`           | `under-review`, `benign`        |
| `under-review`        | `confirmed-malicious`, `benign` |
| `confirmed-malicious` | `retracted`                     |
| `benign`              | `under-review`                  |
| `retracted`           | `under-review`                  |

The verdict is independent of `severity`, which the analyzer derives from what the behavior can do, and `confidence`, which the analyzer or the reviewer sets. Each transition appends one history entry with the actor, the time and the reason. The service never rewrites history.

## Consumers

The CLI and the GitHub Action query the service when the operator points them at it:

```sh
capdelta --base origin/main --intel-url http://127.0.0.1:8787
```

```yaml
- uses: your-org/capdelta@v0
  with:
    intel-url: https://intel.example
```

The lookup sends one request per distinct changed artifact: `GET /v1/findings?ecosystem=npm&digest=<sha512>`. It sends the digest only. Package names, versions, the lockfile and CI credentials stay in the job. `--intel-url` and the `intel-url` Action input accept https anywhere, and plain http only on localhost, 127.0.0.1 or `[::1]`.

A `confirmed-malicious` match adds one CRITICAL lockfile finding and fails the gate at CRITICAL. A `retracted` finding adds nothing. If the service is unreachable, slow or returns a malformed answer, the CLI prints `capdelta: warning: intelligence service unavailable (<cause>); continuing with local analysis only` and finishes with the same report and exit code as a run without `--intel-url`.

The feed is for mirrors and other consumers that replay each published change with its sequence. The CLI and Action use the findings query route instead, because the query returns the finding's current verdict. A retracted finding therefore reads as `retracted` on the next run and adds no finding, without replaying the feed from the confirmation entry.

## Trust assumptions

- The data directory belongs to the operator. The store rejects keys that would escape the directory and refuses to follow symlinks, but a local user who can write inside the directory can replace records. Protect the directory with file permissions.
- The read API has no authentication and binds `127.0.0.1` by default. If you pass `--host 0.0.0.0`, every host that can reach the port can read every stored report and finding.
- The service speaks plain HTTP and has no TLS. Put a reverse proxy in front of it that terminates TLS and authenticates readers before you expose it beyond localhost.
- The service reads reviewer tokens at startup from the reviewers file. Restart the service to add or revoke a reviewer. The file stores sha256 hashes, so a copy of the file does not carry a usable token.
- Registry and package strings are untrusted. The service truncates them to the report limits before storing or serving them and never turns them into links.
- The service never executes package code. It verifies the tarball bytes against the registry sha512, extracts them with the core safe extractor, and parses the files.

## Limits

- One feed event queues at most the 3 newest versions of one package. An older version is reachable with `analyze`.
- The file store writes one JSON file per record and lists a directory to find jobs and records. Job listing reads every job file, so the store does not scale past one host and a large job count. ADR-038 says to replace it when the record count passes what a directory listing handles.
- One process should own a data directory. Two `monitor` processes would race on the same queue and cursor.
- The API rejects a URL over 2048 characters and a name or version over 214 characters. The failed job list is capped at 100.
