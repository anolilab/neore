/**
 * HMAC-SHA256 request signing for internal service-to-service calls.
 *
 * Signs: METHOD + "\n" + PATH_AND_QUERY + "\n" + TIMESTAMP + "\n" + SHA256(BODY)
 *
 * PATH_AND_QUERY is `pathname` (no query) or `pathname?canonical_query`, where
 * canonical_query is the searchParams sorted by key. This authenticates query
 * parameters so they can't be tampered with within the replay window. All
 * verifiers must reconstruct the same canonical form.
 *
 * Covers:
 *  - Authenticity: only the holder of the shared secret can produce a valid signature
 *  - Integrity:    body hash + query string are part of the signed message
 *  - Replay protection: timestamp is signed, receiver rejects requests older than 30 s
 *
 * Uses Web Crypto API (available globally in backend actions via Node.js 22+).
 */
import { compareStrings } from "./collections";
import { hmacSha256Hex, isWithinWindow, sha256Hex, timingSafeEqual } from "./crypto";

/**
 * How far a service request's `X-Timestamp` (ms) may be from now. Tighter than
 * the third-party webhook window (`SIGNED_REQUEST_WINDOW_MS`, `lib/crypto.ts`)
 * because both ends are ours; it must match the services' own verifiers.
 */
export const SERVICE_REQUEST_WINDOW_MS = 30_000;

const DIGITS_ONLY = /^\d+$/u;

/**
 * Build the canonical PATH_AND_QUERY component used in the signed message.
 * Receivers must compute the same value to validate.
 */
const canonicalPathAndQuery = (urlString: string): string => {
    const url = new URL(urlString);
    const params = [...url.searchParams.entries()].toSorted(([a], [b]) => compareStrings(a, b));
    const canonicalQuery = new URLSearchParams(params).toString();

    return canonicalQuery ? `${url.pathname}?${canonicalQuery}` : url.pathname;
};

/**
 * Signs an outgoing request and returns the headers to attach.
 * @example
 * ```ts
 * const sigHeaders = await signRequest("POST", url, fileBytes, secret);
 * await fetchWithDeadline(url, { method: "POST", headers: { ...sigHeaders, "Content-Type": mimeType }, body: fileBytes });
 * ```
 */
const signRequest = async (method: string, url: string, body: ArrayBuffer, secret: string): Promise<{ "X-Signature": string; "X-Timestamp": string }> => {
    const timestamp = Date.now().toString();
    const pathAndQuery = canonicalPathAndQuery(url);
    const bodyHash = await sha256Hex(body);
    const message = `${method}\n${pathAndQuery}\n${timestamp}\n${bodyHash}`;
    const signature = await hmacSha256Hex(secret, message);

    return { "X-Signature": signature, "X-Timestamp": timestamp };
};

/**
 * Verify a request signed by {@link signRequest} (or a service's twin of it):
 * the timestamp is inside {@link SERVICE_REQUEST_WINDOW_MS} and the signature
 * covers method, canonical path+query, timestamp and body hash. Reads the body
 * from a clone, so the caller can still consume it.
 */
const verifySignedRequest = async (request: Request, secret: string): Promise<boolean> => {
    const signature = request.headers.get("X-Signature");
    const timestamp = request.headers.get("X-Timestamp");

    if (!signature || !timestamp || !DIGITS_ONLY.test(timestamp) || !isWithinWindow(Number(timestamp), SERVICE_REQUEST_WINDOW_MS)) {
        return false;
    }

    const bodyHash = await sha256Hex(await request.clone().arrayBuffer());
    const message = `${request.method}\n${canonicalPathAndQuery(request.url)}\n${timestamp}\n${bodyHash}`;

    return timingSafeEqual(signature, await hmacSha256Hex(secret, message));
};

export default signRequest;
export { canonicalPathAndQuery, verifySignedRequest };
