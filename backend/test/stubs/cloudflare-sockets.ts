/**
 * Test stub for the `cloudflare:sockets` runtime module.
 *
 * `connect()` exists only inside workerd, so Node cannot resolve the specifier.
 * Every delivery test injects its own transport, so nothing should reach this
 * stub; if one does, it fails loudly instead of opening a socket from a test.
 */
export const connect = (): never => {
    throw new Error("cloudflare:sockets is only available in the Workers runtime; inject a connect function in tests.");
};
