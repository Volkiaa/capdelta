// Inert static fixture: parsed by capdelta tests, never imported or executed.
export function mode() {
  return process.env.CAPDELTA_FIXTURE_MODE ?? "default";
}
