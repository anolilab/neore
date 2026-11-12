"use client";

import { lazyShellChunk } from "@/lib/native/shell-chunk";

import { useIsImpersonating } from "../hooks/use-is-impersonating";

// Off the first load, and fetched only for an impersonated session. A chunk that fails to load renders nothing rather
// than reaching the root error boundary (`lazyShellChunk`).
const ImpersonationBanner = lazyShellChunk(async () => await import("./impersonation-banner"));

/** Mounts the impersonation banner only once the session is known to be impersonated; nobody else downloads it. */
const ImpersonationBannerGate = () => {
    // The banner reads the same query, so mounting it sends no second request.
    const { data } = useIsImpersonating();

    return data?.isImpersonating ? <ImpersonationBanner /> : null;
};

export default ImpersonationBannerGate;
