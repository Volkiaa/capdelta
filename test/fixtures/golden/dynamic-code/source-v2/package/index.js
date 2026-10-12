// Inert static fixture: parsed by capdelta tests, never imported or executed.
export function compile() {
  return new Function("return 1;");
}
