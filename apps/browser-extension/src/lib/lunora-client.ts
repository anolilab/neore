import { LunoraClient } from "@lunora/client";

import { LUNORA_URL } from "./env";

/**
 * The one Lunora client for the panel. Its own module so `lunora.tsx` exports
 * components only, which is what Fast Refresh needs to hot-swap it.
 */
export const lunora = new LunoraClient({ url: LUNORA_URL });
