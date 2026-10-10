export interface PostHogRequestData {
    distinctId: string | null;
    flags: Record<string, boolean | string>;
}

export interface RequestContextData {
    nonce: string | undefined;
    posthog: PostHogRequestData;
}

interface ServerContextShape {
    // A promise from `posthog-middleware.ts`, which does not wait for PostHog.
    posthog?: { distinctId?: string | null; flags?: Promise<Record<string, boolean | string>> | Record<string, boolean | string> };
    security?: { nonce?: string };
}

/**
 * Reads what the request middleware (`security-middleware.ts`,
 * `posthog-middleware.ts`) put into the Start context, from a route's
 * `beforeLoad`/`loader` options.
 *
 * Start does NOT merge request-middleware context into the router context
 * (`options.context`). `createStartHandler` sets
 * `router.options.additionalContext = { serverContext }`, and router-core
 * spreads `additionalContext` at the TOP LEVEL of the `beforeLoad` options — so
 * the values live at `options.serverContext`. Reading `options.context.security`
 * is always `undefined`, which silently dropped the CSP nonce.
 *
 * `serverContext` is absent on the client; a client navigation therefore reads
 * the defaults. The SSR values survive hydration via the dehydrated
 * `beforeLoad` context.
 *
 * Async because the PostHog flags arrive as a promise; await it alongside the
 * route's other server work rather than before it.
 */
export const readRequestContext = async (options: unknown): Promise<RequestContextData> => {
    const serverContext = (options as { serverContext?: ServerContextShape } | null | undefined)?.serverContext;

    return {
        nonce: serverContext?.security?.nonce,
        posthog: {
            distinctId: serverContext?.posthog?.distinctId ?? null,
            flags: (await serverContext?.posthog?.flags) ?? {},
        },
    };
};
