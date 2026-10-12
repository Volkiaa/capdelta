// Inert static fixture: parsed by capdelta tests, never imported or executed.
import https from "node:https";

export function connect(options) {
  return https.request(options);
}
