/**
 * Link preview cards: `getLinkPreview({ url })` returns title / description /
 * site metadata for a URL a message contains (GitHub repos, issues and PRs from
 * the REST API; Linear issues from the URL alone; anything else from the page's
 * OpenGraph tags). The rules live in `lib/link-preview.ts`.
 *
 * Cached in `actionCache` (a `.global()` table, so every user shares one entry
 * per URL): a day for a found preview, half an hour for a miss. The
 * `chat/linkPreview` rate limit is charged only on a cache MISS — a thread full
 * of already-seen links costs one D1 read per card, not a token each.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { cacheKeyFor } from "../lib/action-cache";
import { authAction, rateLimit } from "../lib/crpc";
import { fetchWithDeadline } from "../lib/fetch-timeout";
import { rateLimitGuard } from "../lib/rate-limiter";
import type { LinkPreview } from "./lib/link-preview";
import {
    buildLinkPreview,
    LINK_PREVIEW_CACHE_NAME,
    LINK_PREVIEW_CACHE_TTL_MS,
    LINK_PREVIEW_NEGATIVE_TTL_MS,
    MAX_PREVIEW_URL_LENGTH,
    normalizePreviewUrl,
} from "./lib/link-preview";
import { fetchWithTimeout, validateDomain } from "./tools/utilities";

export const getLinkPreview = authAction
    .use(rateLimit("chat/linkPreview"))
    .input({
        url: v.string().check((value) => value.length <= MAX_PREVIEW_URL_LENGTH, { message: "URL is too long" }),
    })
    .output(
        v.object({
            description: v.optional(v.string()),
            favicon: v.optional(v.string()),
            github: v.optional(
                v.object({
                    language: v.optional(v.string()),
                    number: v.optional(v.number()),
                    owner: v.string(),
                    repo: v.string(),
                    stars: v.optional(v.number()),
                    state: v.optional(v.string()),
                }),
            ),
            image: v.optional(v.string()),
            kind: v.union(v.literal("generic"), v.literal("github-issue"), v.literal("github-pull"), v.literal("github-repo"), v.literal("linear-issue")),
            linear: v.optional(v.object({ identifier: v.string() })),
            ok: v.boolean(),
            siteName: v.optional(v.string()),
            title: v.optional(v.string()),
            url: v.string(),
        }),
    )
    .action(async ({ args, ctx }): Promise<LinkPreview> => {
        const url = normalizePreviewUrl(args.url);

        // Not http(s), credentials in the URL, or a private / reserved host: no
        // card, no fetch, no cache row.
        if (!url || validateDomain(url) !== null) {
            return { kind: "generic", ok: false, url: args.url };
        }

        const key = await cacheKeyFor(LINK_PREVIEW_CACHE_NAME, url);
        const cached = await ctx.runQuery(internal.lib.action_cache.get, { key, now: Date.now() });

        if (cached.kind === "hit" && cached.value && typeof cached.value === "object") {
            return cached.value as LinkPreview;
        }

        await rateLimitGuard({
            ...ctx,
            rateLimitKey: "chat/linkPreview",
            user: { plan: ctx.user.plan, userId: ctx.user.userId },
        } as never);

        const preview = await buildLinkPreview(url, {
            fetchApi: async (target, { timeoutMs, ...init }) => await fetchWithDeadline(target, { ...init, timeoutMs }),
            fetchPage: async (target, init, timeoutMs) => await fetchWithTimeout(target, init, timeoutMs),
            now: () => Date.now(),
            validateUrl: (target) => validateDomain(target),
        });

        // A lost cache write costs a repeat fetch later, never this answer.
        await ctx
            .runMutation(internal.lib.action_cache.put, {
                key,
                name: LINK_PREVIEW_CACHE_NAME,
                ttl: preview.ok ? LINK_PREVIEW_CACHE_TTL_MS : LINK_PREVIEW_NEGATIVE_TTL_MS,
                value: preview,
            })
            .catch(() => undefined);

        ctx.log.event("chat.link_preview", { kind: preview.kind, ok: preview.ok });

        return preview;
    });
