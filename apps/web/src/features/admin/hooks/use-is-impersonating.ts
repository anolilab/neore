import { skipToken, useQuery } from "@tanstack/react-query";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

/**
 * Check if current session is impersonated.
 *
 * The banner that consumes this is mounted app-wide, including on the signed-out
 * landing page, and the procedure requires a session — so without the gate every
 * first paint fired a request that could only ever come back 401. Its own module, apart from `use-admin`, so the root
 * layout's banner gate keeps the admin hooks off the first load.
 */
export const useIsImpersonating = () => {
    const crpc = useCRPC();
    // Gated on the RPC client's auth state rather than better-auth's session:
    // the two are not the same instant. The session cookie lands first and the
    // bearer token the client sends is fetched after, so gating on the session
    // still fires this while the client is anonymous — a 401, every load.
    const { isAuthenticated } = useLunoraAuth();
    // A banner for a rare admin session; it can appear a moment after first paint.
    const afterFirstPaint = useAfterFirstPaint();
    const options = crpc.auth.admin.isImpersonating.queryOptions({});

    return useQuery({ ...options, queryFn: isAuthenticated && afterFirstPaint ? options.queryFn : skipToken });
};
