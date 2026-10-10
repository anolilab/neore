export const APP_URL = import.meta.env.VITE_APP_URL ?? "https://neore.ai";

/**
 * The Lunora backend Worker's origin.
 *
 * The previous backend had two origins, one for RPC and one for HTTP routes,
 * which is why this file used to carry two separate variables. One Lunora Worker serves `/_lunora/rpc`,
 * `/api/auth/*` and the HTTP routes, so the two could only ever hold the same
 * value — the web app collapsed them into `VITE_LUNORA_URL` and this is the
 * extension's half of the same change.
 */
export const LUNORA_URL = import.meta.env.VITE_LUNORA_URL ?? "";
export const LLM_GATEWAY_URL = import.meta.env.VITE_LLM_GATEWAY_URL ?? "";
