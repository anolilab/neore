import { fetch as expoFetch } from "expo/fetch";

import type { Fetch } from "@/auth/grant";

/**
 * A fetch whose response body is a readable stream. React Native's global `fetch` buffers the whole
 * response and exposes no `body`, so the NDJSON reply relay would see nothing until the reply ended
 * (and `relayReply` treats a missing body as a failure). Expo's fetch streams the body natively.
 *
 * Its response type is Expo's own `FetchResponse`, which matches the `Response` members the relay
 * reads (`ok`, `status`, `body`); the cast is that boundary.
 */
export const streamingFetch: Fetch = (input, init) => expoFetch(input, init as Parameters<typeof expoFetch>[1]) as unknown as Promise<Response>;
