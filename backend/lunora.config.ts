/**
 * Lunora project config — read STATICALLY by codegen (`ts-morph`, never run),
 * so every value below must stay an inline string literal.
 *
 * `services` are the sibling Workers this backend calls over a Cloudflare
 * service binding (`ctx.services.<key>`, actions only). Lunora writes one
 * `services[]` entry per key into `wrangler.jsonc` (binding `SERVICE_<KEY>`),
 * records it in `package.json#lunora.services`, and `lunora dev` runs each one
 * in the backend's own `wrangler dev` session. The deploy is Alchemy's:
 * `alchemy.run.ts` binds the same `SERVICE_<KEY>` names.
 *
 * `services/embeddings` is deliberately absent: nothing in the backend calls it.
 */
export default {
    services: {
        browserRenderer: { dir: "../services/browser-renderer" },
        documentParser: { dir: "../services/document-parser" },
        // The gateway is also PUBLIC (the browser posts to `/v1/*`), so a binding
        // to its default `fetch` would be indistinguishable from an internet
        // request: the backend must bind its `InternalApi` named entrypoint, which
        // only a service binding reaches. That entrypoint is set in a HAND-WRITTEN
        // `services[]` entry in `wrangler.jsonc` (Lunora leaves an entry it did not
        // write alone, with a warning), NOT with `entrypoint:` here — that would
        // type `ctx.services.llmGateway` from the gateway's own sources, which then
        // join the type check of every project compiling `_generated/` (apps/web,
        // the browser extension) under THEIR compiler options. `InternalApi` only
        // serves `fetch`, so the fetch typing is the right one anyway.
        llmGateway: { dir: "../services/llm-gateway" },
        nsfwChecker: { dir: "../services/nsfw-checker" },
    },
    // Reviewed ERRORs. The team add writes an existing org member; the subject field comes from args by design:
    advisor: {
        accept: [
            {
                exportName: "addTeamMember",
                file: "auth/team",
                reason: "Adds another user by design. Requires canManageTeamMembers for the team, the team must belong to the caller's organization, and the target must already be a member of it.",
                rule: "owner_field_from_args_not_auth",
            },
        ],
    },
};
