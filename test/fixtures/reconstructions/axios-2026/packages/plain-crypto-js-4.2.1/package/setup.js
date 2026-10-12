// DEFANGED RECONSTRUCTION of plain-crypto-js@4.2.1 setup.js, modeled on public incident analyses
// (see test/fixtures/reconstructions/inventory.json). Synthetic, not the original artifact.
// Parsed by capdelta tests only; never imported, installed, or executed.
// Kept: encoded string table, layered decoding, computed require, process
// execution sink. Omitted: the real strings, C2 contact, payload download,
// and self-deletion. The table decodes to inert fixture values.
const stq = ["_wKxgW8rEHKx4ScqEXKxgSMoFjKx/SMuE7Lx1SMpEvKxnWMrEnLxhSMqEnKx6SMrE7Kx","_8KxgW8rEHKx4ScqEXKxgSMoFjKx/SMuE7Lx1SMpEvKxnWMrEnLxhSMqEnKx6SMrE7Kx","pS8oEzKxnSMoELKxuS8pFnLxjSMqEnLx+S8oEXLxoS8oEXKxjSMoFjKx/SMuE7Lx1SMpEvKxnWMrEnLxhSMqEnKx6SMrE7Kx","_Iax9WcvF3bx1WMsFnLx+SMqE7LxjWMqEHKx9SMoEvKx1SMqEPax4WsrELaxiW8tF3Lx+ScuEXKx"];

function _trans_1(text, key) {
  const digits = [...key].map((c) => Number(c) || 0);
  return [...text].map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ digits[(7 * i * i) % 10] ^ 333)).join("");
}

function _trans_2(text) {
  const b64 = [...text].reverse().join("").replace(/_/g, "=");
  return _trans_1(Buffer.from(b64, "base64").toString("utf8"), "OrDeR_7077");
}

// Never called: the original invoked its entry at load time; this does not.
function _entry(campaign) {
  const cp = require(_trans_2(stq[0]));
  require(_trans_2(stq[1]));
  return cp.execSync(`${_trans_2(stq[2])} ${_trans_2(stq[3])}${campaign}`);
}

module.exports = { _entry };
