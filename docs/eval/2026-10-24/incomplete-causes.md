# Incomplete analysis causes

24 of 224 real-registry results are incomplete. Each release is counted once, under the first cause reported: an analysis issue, a baseline failure, or the most frequent diagnostic class.

| Cause                                                                                                                                           | Count | Share of incomplete | Example                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ------------------: | ---------------------- |
| unsupported-source: <path> is TypeScript that type stripping rejected: TypeScript enum is not supported in strip-only mode                      |    12 |               50.0% | zod@4.6.3->4.6.4       |
| unsupported-source: <path> is TypeScript that type stripping rejected: Expected ';', '}' or <eof>                                               |     3 |               12.5% | fastify@5.12.2->5.12.3 |
| unsupported-source: <path> is TypeScript that type stripping rejected: TypeScript import equals declaration is not supported in strip-only mode |     3 |               12.5% | pino@10.2.1->10.3.0    |
| unsupported-source: <path> is TypeScript that type stripping rejected: TypeScript parameter property is not supported in strip-only mode        |     3 |               12.5% | rxjs@7.7.0->7.8.0      |
| unparseable-source: JavaScript parse failed: SyntaxError: Identifier 'res' has already been declared (#:#)                                      |     2 |                8.3% | bcrypt@5.1.0->5.1.1    |
| unparseable-source: <path> exceeds the # byte parser limit                                                                                      |     1 |                4.2% | faker@5.5.3->6.6.6     |
