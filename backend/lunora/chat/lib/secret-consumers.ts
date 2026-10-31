/**
 * The two places a requested secret (`chat/lib/secret-requests.ts`) can go,
 * each the write a manual save in Settings would make:
 *
 * - {@link consumeAsProviderKey}: the user's BYOK key for a provider
 *   (`aiUserPreferences.providerApiKeys`, encrypted by `auth/lib/byok-keys.ts`
 *   exactly as the settings page's save is);
 * - {@link consumeAsMcpHeader}: a header on one of the user's own MCP servers
 *   (`aiUserPreferences.mcpServers`), stored as the settings page stores it.
 *
 * Both take the reference through {@link takeRequestedSecret} and write in the
 * same mutation, so a failed write puts the value back and a successful one
 * leaves nothing to take twice. The destination was fixed on the card the user
 * approved; the caller names only the reference.
 */
import type { MutationCtx } from "../../_generated/server";
import { mergeKeyEntries } from "../../auth/lib/byok-keys";
import type { KeyEntryInput, StoredKeyEntry } from "../../auth/lib/byok-keys";
import { saveAiUserPreferences } from "../../auth/lib/preference-writes";
import { encryptKey } from "../../lib/encryption";
import type { SecretFailure } from "../tools/request-secret-constants";
import { SECRET_FAILURE_MESSAGES } from "../tools/request-secret-constants";
import { takeRequestedSecret } from "./secret-requests";

interface ConsumeArgs {
    now: number;
    ref: string;
    threadId: string;
    userId: string;
}

export type ConsumeResult =
    { header: string; server: string; status: "saved" } | { message: string; status: SecretFailure } | { provider: string; status: "saved" };

const failure = (status: SecretFailure): ConsumeResult => {
    return { message: SECRET_FAILURE_MESSAGES[status], status };
};

const preferencesOf = async (ctx: Pick<MutationCtx, "db">, userId: string) =>
    await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

export const consumeAsProviderKey = async (ctx: Pick<MutationCtx, "db">, args: ConsumeArgs): Promise<ConsumeResult> => {
    const taken = await takeRequestedSecret(ctx, { ...args, kind: "provider_key" });

    if (!taken.ok) {
        return failure(taken.status);
    }

    const { use, value } = taken;

    if (use.kind !== "provider_key") {
        return failure("wrong_use");
    }

    const existing = await preferencesOf(ctx, args.userId);
    const stored = (existing?.providerApiKeys ?? undefined) as Record<string, StoredKeyEntry> | undefined;
    // The merge REPLACES the entry set, so every stored provider goes back in (key omitted = keep its ciphertext).
    const input: Record<string, KeyEntryInput | undefined> = Object.fromEntries(
        Object.entries(stored ?? {}).map(([name, entry]) => [name, { ...entry, enabled: entry.enabled }]),
    );

    input[use.provider] = { enabled: true, key: value };

    const providerApiKeys = await mergeKeyEntries(input, stored, async (plaintext) => await encryptKey(plaintext, "provider-keys"), {
        now: args.now,
        stampMetadata: true,
    });

    await saveAiUserPreferences(ctx.db, existing, args.userId, { providerApiKeys });
    console.info(`[BYOK Audit] userId=${args.userId} action=save purposes=[provider-keys] source=requestSecret timestamp=${new Date(args.now).toISOString()}`);

    return { provider: use.provider, status: "saved" };
};

export const consumeAsMcpHeader = async (ctx: Pick<MutationCtx, "db">, args: ConsumeArgs): Promise<ConsumeResult> => {
    const existing = await preferencesOf(ctx, args.userId);
    const servers = existing?.mcpServers ?? [];
    const taken = await takeRequestedSecret(
        ctx,
        { ...args, kind: "mcp_header" },
        (use) => use.kind === "mcp_header" && servers.some((server) => server.name === use.server),
    );

    if (!taken.ok) {
        return failure(taken.status);
    }

    const { use, value } = taken;

    if (use.kind !== "mcp_header" || !existing) {
        return failure("wrong_use");
    }

    const mcpServers = servers.map((server) => {
        if (server.name !== use.server) {
            return server;
        }

        const others = (server.headers ?? []).filter((header) => header.key.toLowerCase() !== use.header.toLowerCase());

        return { ...server, headers: [...others, { key: use.header, value }] };
    });

    await saveAiUserPreferences(ctx.db, existing, args.userId, { mcpServers });

    return { header: use.header, server: use.server, status: "saved" };
};
