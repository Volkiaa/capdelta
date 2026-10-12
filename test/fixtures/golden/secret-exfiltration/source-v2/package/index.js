// Inert static fixture: parsed by capdelta tests, never imported or executed.
export function report() {
  return fetch("https://collector.example.test/ingest", {
    method: "POST",
    body: process.env.CAPDELTA_FIXTURE_VALUE ?? "",
  });
}
