# Platform service

`capdelta-platform` watches the npm registry, analyzes each new release with the capdelta engine, stores the report, and serves it over a read-only HTTP API. It needs no project lockfile and no Git repository. The CLI and the GitHub Action keep working without it.

Phase 1 has three commands: `monitor`, `analyze`, and `serve`. There is no authentication and no write API.

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
```

The defaults are port 8787 and host 127.0.0.1.

## Data directory

The service keeps one JSON file per record under `--data`. Keys are sha256 hex strings, except the cursor:

```text
<data>/cursor/npm-changes.json          the change feed position
<data>/job/<sha256>.json                one queued, running, done, or failed job
<data>/release/<sha256>.json            one release record and its report
<data>/release-by-version/<sha256>.json version index
<data>/release-by-digest/<sha256>.json  artifact digest index
```

Every write goes to a temporary file and then an atomic rename or link puts it in place, so a crash leaves either the old record or the new one. A corrupt record fails the read with an error instead of being treated as absent. To back up the service, stop it and copy the directory.

## API

The API answers `GET` and `HEAD` on `127.0.0.1:8787` by default. Other methods return 405. Every response is JSON with `content-type: application/json; charset=utf-8`.

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

## Trust assumptions

- The data directory belongs to the operator. The store rejects keys that would escape the directory and refuses to follow symlinks, but a local user who can write inside the directory can replace records. Protect the directory with file permissions.
- The API has no authentication in phase 1 and binds `127.0.0.1` by default. If you pass `--host 0.0.0.0`, every host that can reach the port can read every stored report. Put an authenticating reverse proxy in front of it if you need remote access.
- Registry and package strings are untrusted. The service truncates them to the report limits before storing or serving them and never turns them into links.
- The service never executes package code. It verifies the tarball bytes against the registry sha512, extracts them with the core safe extractor, and parses the files.

## Limits

- One feed event queues at most the 20 newest versions of one package. An older version is reachable with `analyze`.
- The file store writes one JSON file per record and lists a directory to find jobs and records. Job listing reads every job file, so the store does not scale past one host and a large job count. ADR-038 says to replace it when the record count passes what a directory listing handles.
- One process should own a data directory. Two `monitor` processes would race on the same queue and cursor.
- The API rejects a URL over 2048 characters and a name or version over 214 characters. The failed job list is capped at 100.
