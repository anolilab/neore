/**
 * Sign-in for the `neore` CLI by device code: the CLI shows a URL and a short
 * code, the person approves the code in the web app while signed in, and the
 * CLI polls until it holds an API key. No browser and no callback port are
 * needed on the machine running the CLI, so it works over SSH.
 *
 * The state machine is better-auth's `deviceAuthorization` plugin: code
 * issue, the claim-on-view step, approve and deny, expiry and the one-time
 * claim all come from it. Two things differ from its stock token route, which
 * answers with a full browser SESSION:
 *
 * - the plugin's `grant` hook makes every code ours: the client is fixed, the
 *   request may carry only a display `hostname`, and `assertSessionRedemption`
 *   refuses the stock `/device/token` for all of them. A person who approves a
 *   code approves a read-only API key, so the code must never be redeemable for
 *   more than that;
 * - `POST /device/key` redeems the code with the plugin's own `redeemDeviceCode`
 *   (same polling interval, expiry, denial and atomic claim) and then mints the
 *   key. The key is minted only AFTER the claim succeeded, so two concurrent
 *   polls cannot produce two keys; it is returned once, in that response. If
 *   the mint itself fails, the code stays spent (the key row may exist even when the call failed, so
 *   giving the code back could mint a second key) and the CLI starts over with a new code.
 *   A response lost in transit cannot be replayed (the key is never stored in
 *   the clear); the stranded key shows in Settings and can be revoked there.
 *   The per-person key cap is checked before the claim and again after the
 *   mint; a mint that finds the person over the cap withdraws its own key and answers with the refusal.
 *
 * - `POST /device/host` redeems a code issued for the client `neore-host` (a
 *   headless machine pairing itself, `hostPairing` option): after the same
 *   atomic claim it registers a DEVICE of the approving account and hands the
 *   machine its secret once, in that response. A CLI code cannot redeem there
 *   and a host code cannot redeem at `/device/key`.
 *
 *   `POST /device/revoke` lets the CLI delete a key it was just issued when it
 *   could not check or save it, so retries do not stack toward the cap.
 *
 * The caller supplies the minting function (`mintApiKey`), so this file does
 * not import the auth instance it is installed into.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deviceAuthorization, redeemDeviceCode } from "better-auth/plugins";
import { z } from "zod";

import { authLogger } from "../lib/logger";
import { DEVICE_LIMIT_CODE } from "../devices/lib/constants";
import { MAX_API_KEYS_PER_USER } from "./api-key-limits";

/** The one client id a CLI code can carry. */
export const CLI_CLIENT_ID = "neore-cli";

/**
 * The client id of a headless machine pairing itself as a device (`neore-host pair`). Same plugin, same
 * state machine; the redemption registers a device instead of minting a key (`/device/host`, below).
 */
export const HOST_CLIENT_ID = "neore-host";

/** What a pairing machine says about itself. Display only: the approval page shows it, nothing trusts it. */
export const HOST_PLATFORMS = ["linux", "macos", "windows"] as const;

export type HostPlatform = (typeof HOST_PLATFORMS)[number];

/** Where the machine will keep the device secret, announced with the code so the approval page can say so. */
export const HOST_SECRET_STORAGE = ["file", "keychain"] as const;

export type HostSecretStorage = (typeof HOST_SECRET_STORAGE)[number];

const isOneOf = <T extends string>(allowed: ReadonlyArray<T>, value: unknown): value is T =>
    typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value);

/** The web route a person opens to approve a code. */
export const DEVICE_VERIFICATION_PATH = "/auth/device";

/** Matches `createScopedApiKey`: a name is 1-32 characters. */
const MAX_KEY_NAME_LENGTH = 32;

const KEY_NAME_PREFIX = "Neore CLI on ";

/** A CLI key is good for a year; `neore login --device` mints a fresh one. */
export const CLI_KEY_LIFETIME_DAYS = 365;

const DAY_SECONDS = 24 * 60 * 60;

/** The plugin's default code lifetime (30 minutes); a key older than this was not issued by a live sign-in. */
const CODE_LIFETIME_MS = 30 * 60 * 1000;

const MAX_STORED_HOSTNAME_LENGTH = 64;

/**
 * What the requesting machine calls itself, reduced to host-name characters.
 * It is untrusted: the approval page shows it as plain text and the key name
 * embeds it. Anything outside `[A-Za-z0-9._-]` (control and bidi characters
 * included) is dropped, not escaped.
 */
export const cleanHostname = (raw: string | undefined | null): string => {
    const cleaned = (raw ?? "").replaceAll(/[^\w.-]/gu, "").slice(0, MAX_STORED_HOSTNAME_LENGTH);

    return cleaned || "unknown-host";
};

/** The key name, "Neore CLI on" plus the host, cut to the 32 characters a key name may have. */
export const cliKeyName = (hostname: string): string => `${KEY_NAME_PREFIX}${cleanHostname(hostname)}`.slice(0, MAX_KEY_NAME_LENGTH);

export interface MintedCliKey {
    expiresAt?: Date | number | string | null;
    id: string;
    key: string;
}

/** What a redeemed host code registers: a device of the approving account, paired for the machine that asked. */
export interface HostPairingOptions {
    /** Throws when the account cannot add a device. Runs before the code is spent, so a refusal leaves it unclaimed. */
    precheck: (userId: string, codeId: string) => Promise<void>;
    /**
     * Creates the device and its secret, after the atomic claim. `codeId` names the redeemed code: a retry after a
     * failure puts the code back, so the same id comes again and must find the device it already made.
     */
    register: (input: { codeId: string; name: string; platform: HostPlatform; userId: string }) => Promise<{ deviceId: string; secret: string }>;
}

export interface CliDeviceAuthOptions {
    /**
     * Enables `client_id: "neore-host"` codes and `POST /device/host`. Without it a host code is refused at issue and
     * the route does not exist. Production leaves it off until the approval page shows machine-specific consent.
     */
    hostPairing?: HostPairingOptions;
    /** Mints a read-only public-API key for `userId`. Called once per redeemed code. */
    mintApiKey: (input: { expiresInSeconds: number; name: string; userId: string }) => Promise<MintedCliKey>;
    /** Resolves a presented key to its row id and owner, or `null` when it is not a valid key. */
    verifyApiKey: (key: string) => Promise<{ id: string; referenceId: string } | null>;
}

const oauthError = (status: "BAD_REQUEST" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR", error: string, description: string): APIError =>
    new APIError(status, { error, error_description: description });

/** The plugin's `grant`: see the file header. */
const makeGrant = (hostPairing: boolean) => {
    return {
        assertSessionRedemption: () => {
            throw oauthError("BAD_REQUEST", "invalid_grant", "This code can only be exchanged by the Neore CLI.");
        },
        authorizeRequest: async ({
            ctx,
            request,
        }: {
            ctx: { context: { adapter: { deleteMany: (input: unknown) => Promise<unknown> } } };
            request: { client_id?: string; hostname?: string; platform?: string; scope?: string; storage?: string; user_id?: string };
        }) => {
            const clientId = request.client_id ?? CLI_CLIENT_ID;

            if (clientId !== CLI_CLIENT_ID && !(hostPairing && clientId === HOST_CLIENT_ID)) {
                throw oauthError("BAD_REQUEST", "invalid_client", "Invalid client ID");
            }

            const isHost = clientId === HOST_CLIENT_ID;

            if (isHost && (!isOneOf(HOST_PLATFORMS, request.platform) || !isOneOf(HOST_SECRET_STORAGE, request.storage))) {
                throw oauthError("BAD_REQUEST", "invalid_request", "A host code names its platform and where it keeps the secret");
            }

            // Nothing may pre-bind a code to a user: the first signed-in person to open it claims it.
            if (request.user_id) {
                throw oauthError("BAD_REQUEST", "invalid_request", "user_id is not accepted");
            }

            if (request.scope) {
                throw oauthError("BAD_REQUEST", "invalid_scope", "The CLI's access is fixed; scope is not accepted");
            }

            // Nothing sweeps expired rows (the plugin deletes one only when it is polled after expiry), so
            // issuing a code clears the lapsed ones. Issuing is rate limited per address.
            await ctx.context.adapter.deleteMany({ model: "deviceCode", where: [{ field: "expiresAt", operator: "lt", value: new Date() }] });

            return {
                clientId,
                deviceCodeFields: { hostname: cleanHostname(request.hostname), ...(isHost && { platform: request.platform, storage: request.storage }) },
            };
        },
        deviceCodeSchemaFields: {
            hostname: { required: false, type: "string" as const },
            platform: { required: false, type: "string" as const },
            storage: { required: false, type: "string" as const },
        },
        getVerificationContext: (record: Record<string, unknown>) => {
            const text = (key: string): string | undefined => (typeof record[key] === "string" ? record[key] : undefined);

            return { hostname: text("hostname"), platform: text("platform"), storage: text("storage") };
        },
        requestSchemaFields: { hostname: z.string().max(255).optional(), platform: z.string().max(16).optional(), storage: z.string().max(16).optional() },
        verificationOpenAPIProperties: {
            hostname: { description: "What the requesting machine calls itself (untrusted)", type: "string" },
            platform: { description: "linux, macos or windows (host codes only; untrusted)", type: "string" },
            storage: { description: "keychain or file: where the machine keeps the device secret (host codes only)", type: "string" },
        },
    };
};

const keyLimitMessage = `You already have ${String(MAX_API_KEYS_PER_USER)} API keys. Revoke one in Settings, then try again.`;

/** The routes a signed-in person uses on a code: open it (which claims it), approve it, deny it. */
const GUARDED_PATHS = new Set(["/device", "/device/approve", "/device/deny"]);

/**
 * Guests are disposable and uninvited; a long-lived credential (or a paired machine) for one outlives both properties. A guest also
 * must not be able to open (claim) or deny a code, which would keep the intended account from approving it.
 * A session an admin opened to act as someone else (impersonation) is refused for the same reason as a guest's.
 */
const refuseGuestApproval = {
    handler: createAuthMiddleware(async (ctx) => {
        const session = await getSessionFromCtx(ctx);

        if ((session?.user as { isAnonymous?: boolean } | undefined)?.isAnonymous === true) {
            throw oauthError("FORBIDDEN", "access_denied", "Create an account to use this code.");
        }

        // An admin acting as someone must not hand out a long-lived key or pair a machine in that person's name.
        if ((session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) {
            throw oauthError("FORBIDDEN", "access_denied", "Sign in as yourself to use this code.");
        }
    }),
    matcher: (context: { path?: string }) => GUARDED_PATHS.has(context.path ?? ""),
};

/** The code being approved, by the user code in the request. */
const approvedCodeOf = async (ctx: { body?: unknown; context: { adapter: { findOne: (input: never) => Promise<unknown> } } }) => {
    const raw = (ctx.body as { userCode?: unknown } | undefined)?.userCode;

    if (typeof raw !== "string") {
        return null;
    }

    return (await ctx.context.adapter.findOne({
        model: "deviceCode",
        where: [{ field: "userCode", value: raw.replaceAll(/[^a-z0-9]/giu, "").toUpperCase() }],
    } as never)) as { clientId?: string; id?: string } | null;
};

/**
 * Approval by an account already at its cap: the approval itself goes through (the code becomes approved),
 * and the page is told it cannot finish, so it does not report a sign-in or pairing that will not happen. The
 * machine that is polling then gets the redemption-time refusal on its next poll, ends at once with the reason,
 * and does not wait out the 30 minutes of the code. A CLI code is held to the API key cap; a machine code mints a
 * device, so it is held to the device cap instead, checked by the same shard call the redemption makes (which
 * lets a retry's own device through).
 */
const reportLimitAtApproval = (hostPairing: HostPairingOptions | undefined) => {
    return {
        handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof APIError) {
                return;
            }

            const session = await getSessionFromCtx(ctx);

            if (!session?.user.id) {
                return;
            }

            const code = await approvedCodeOf(ctx);

            if (code?.clientId === HOST_CLIENT_ID) {
                await reportDeviceLimit(hostPairing, session.user.id, String(code.id ?? ""));

                return;
            }

            await reportKeyLimit(ctx, session.user.id);
        }),
        matcher: (context: { path?: string }) => context.path === "/device/approve",
    };
};

/** Throws `device_limit` when the account has no room for the machine; any other answer is the redemption's to give. */
const reportDeviceLimit = async (hostPairing: HostPairingOptions | undefined, userId: string, codeId: string): Promise<void> => {
    try {
        await hostPairing?.precheck(userId, codeId);
    } catch (error) {
        if (isDeviceLimit(error) && error instanceof Error) {
            throw oauthError("FORBIDDEN", "device_limit", error.message);
        }

        // The approval is already saved and the machine's poll checks again before the code is spent: note it, no more.
        if (refusalCode(error) === undefined) {
            authLogger.warn("[auth] the device check at a machine code's approval failed", { error });
        }
    }
};

const reportKeyLimit = async (
    ctx: { context: { adapter: { count: (input: { model: string; where: { field: string; value: string }[] }) => Promise<number> } } },
    userId: string,
): Promise<void> => {
    const keys = await ctx.context.adapter.count({ model: "apikey", where: [{ field: "referenceId", value: userId }] });

    if (keys >= MAX_API_KEYS_PER_USER) {
        throw oauthError("FORBIDDEN", "key_limit", keyLimitMessage);
    }
};

const keyBodySchema = z.object({
    client_id: z.string().max(64).optional(),
    device_code: z.string().max(256),
});

/** Best effort: if the row cannot be restored, the person starts a new code. */
const restoreClaimedCode = async (
    adapter: { create: (input: { data: Record<string, unknown>; forceAllowId?: boolean; model: string }) => Promise<unknown> },
    claimed: { id?: unknown; userId?: unknown },
    cause?: unknown,
): Promise<void> => {
    try {
        await adapter.create({ data: { ...claimed }, forceAllowId: true, model: "deviceCode" });
    } catch (error) {
        authLogger.error("[auth] could not restore a redeemed device code", {
            cause,
            deviceCodeId: claimed.id,
            error,
            userId: claimed.userId,
        });
    }
};

const redeemKey = (options: CliDeviceAuthOptions) =>
    createAuthEndpoint("/device/key", { body: keyBodySchema, metadata: { noStore: true }, method: "POST" }, async (ctx) => {
        const { claimedDeviceCode, user } = await redeemDeviceCode({
            authorizeRedemption: (record) => {
                if (record.clientId !== CLI_CLIENT_ID || (ctx.body.client_id !== undefined && ctx.body.client_id !== CLI_CLIENT_ID)) {
                    throw oauthError("BAD_REQUEST", "invalid_grant", "Invalid device code");
                }

                return { context: undefined, ownershipWhere: { field: "clientId", value: CLI_CLIENT_ID } };
            },
            ctx,
            deviceCode: ctx.body.device_code,
            // Runs before the atomic claim, so a refusal here leaves the code unspent.
            prepareRedemption: async (record) => {
                const account = await ctx.context.internalAdapter.findUserById(record.userId as string);

                // The account was deleted after it approved the code: no key for a user that no longer exists.
                if (!account) {
                    throw oauthError("BAD_REQUEST", "invalid_grant", "Invalid device code");
                }

                if ((account as { isAnonymous?: boolean } | null)?.isAnonymous === true) {
                    throw oauthError("FORBIDDEN", "access_denied", "Create an account to sign in the CLI.");
                }

                const keys = await ctx.context.adapter.count({ model: "apikey", where: [{ field: "referenceId", value: record.userId as string }] });

                if (keys >= MAX_API_KEYS_PER_USER) {
                    throw oauthError("FORBIDDEN", "access_denied", keyLimitMessage);
                }

                return {};
            },
        });
        const { hostname } = claimedDeviceCode as { hostname?: string };
        // A mint that throws may still have written the key row, so the code is not given back: the CLI
        // starts over with a new one, and a stranded key shows in Settings.
        const minted: MintedCliKey = await options.mintApiKey({
            expiresInSeconds: CLI_KEY_LIFETIME_DAYS * DAY_SECONDS,
            name: cliKeyName(hostname ?? ""),
            userId: user.id,
        });

        // The cap is counted before the claim and cannot be reserved (the adapter has no transaction across
        // the count and the insert), so it is counted again once the key exists: if concurrent redemptions
        // pushed the person past it, this key is withdrawn and the poll that is waiting for it gets the
        // definite refusal below (the CLI prints it and stops). The code stays spent, because nothing will poll
        // it again after that answer. Two racing mints can both withdraw; neither can leave the person over
        // the cap, and the person starts a new code once a key is revoked.
        let total: number;

        try {
            total = await ctx.context.adapter.count({ model: "apikey", where: [{ field: "referenceId", value: user.id }] });
        } catch (error) {
            // The mint went through but the key was never revealed. Withdraw it, and give the code back only once
            // the delete is confirmed: if the delete fails the key may be live, so the code stays spent and the
            // person starts over, since restoring it would let the next poll mint a second live key.
            const isWithdrawn = await ctx.context.adapter
                .delete({ model: "apikey", where: [{ field: "id", value: minted.id }] })
                .then(() => true)
                .catch((deleteError: unknown) => {
                    authLogger.error("[auth] a CLI device key could not be withdrawn after a failed key count and must be revoked", {
                        apiKeyId: minted.id,
                        error: deleteError,
                        userId: user.id,
                    });

                    return false;
                });

            if (isWithdrawn) {
                await restoreClaimedCode(ctx.context.adapter, claimedDeviceCode, error);
            }

            throw error;
        }

        if (total > MAX_API_KEYS_PER_USER) {
            await ctx.context.adapter.delete({ model: "apikey", where: [{ field: "id", value: minted.id }] });

            throw oauthError("FORBIDDEN", "access_denied", keyLimitMessage);
        }

        authLogger.info("[auth] api_keys.create_cli_device_key", { apiKeyId: minted.id, hostname: cleanHostname(hostname), userId: user.id });

        ctx.setHeader("Cache-Control", "no-store");
        ctx.setHeader("Pragma", "no-cache");

        return ctx.json({
            api_key: minted.key,
            api_key_id: minted.id,
            expires_at: minted.expiresAt ? new Date(minted.expiresAt).getTime() : null,
            token_type: "api_key",
        });
    });

/**
 * Only a refusal the pairing check MEANT (FORBIDDEN or BAD_REQUEST) is the person's to read: FORBIDDEN is
 * `access_denied`, a full account (its own error code) is `device_limit` (the machine waits and says so, the code
 * stays valid), any other BAD_REQUEST an `invalid_request`. Any other failure is ours, and the machine retries a 5xx.
 */
const refusalCode = (error: unknown): "BAD_REQUEST" | "FORBIDDEN" | undefined => {
    const code = (error as { code?: unknown } | null)?.code;

    return (code === "FORBIDDEN" || code === "BAD_REQUEST") && error instanceof Error ? code : undefined;
};

const isDeviceLimit = (error: unknown): boolean => (error as { data?: { code?: unknown } } | null)?.data?.code === DEVICE_LIMIT_CODE;

const refusalOrRetryable = (error: unknown): APIError => {
    const code = refusalCode(error);

    if (code === "FORBIDDEN" && error instanceof Error) {
        return oauthError("FORBIDDEN", "access_denied", error.message);
    }

    if (code === "BAD_REQUEST" && error instanceof Error) {
        return isDeviceLimit(error)
            ? oauthError("FORBIDDEN", "device_limit", error.message)
            : oauthError("BAD_REQUEST", "invalid_request", "The pairing request was refused.");
    }

    authLogger.error("[auth] pairing a machine failed", { error });

    return oauthError("INTERNAL_SERVER_ERROR", "server_error", "The pairing could not be completed. Try again.");
};

/** `owner@example.com` as `o***@example.com`: enough to recognise one's own account, not to harvest an address. */
const maskEmail = (email: string | undefined): string => {
    const at = email?.lastIndexOf("@") ?? -1;

    if (!email || at < 1) {
        return "";
    }

    return `${email.slice(0, 1)}***${email.slice(at)}`;
};

const hostBodySchema = z.object({
    client_id: z.string().max(64).optional(),
    device_code: z.string().max(256),
});

/**
 * Redeems an approved host code: the machine that asked receives its device id and secret in this response. The
 * device is registered only AFTER the plugin's atomic claim, so two racing polls cannot register two devices; the
 * secret never passes through the approving browser. Until the code expires, a later poll with the same device code
 * gets the same device again (a lost reply), unless the device was revoked.
 */
const redeemHost = (options: HostPairingOptions) =>
    createAuthEndpoint("/device/host", { body: hostBodySchema, metadata: { noStore: true }, method: "POST" }, async (ctx) => {
        const { claimedDeviceCode, user } = await redeemDeviceCode({
            authorizeRedemption: (record) => {
                if (record.clientId !== HOST_CLIENT_ID || (ctx.body.client_id !== undefined && ctx.body.client_id !== HOST_CLIENT_ID)) {
                    throw oauthError("BAD_REQUEST", "invalid_grant", "Invalid device code");
                }

                return { context: undefined, ownershipWhere: { field: "clientId", value: HOST_CLIENT_ID } };
            },
            ctx,
            deviceCode: ctx.body.device_code,
            // Runs before the atomic claim, so a refusal here leaves the code unspent.
            prepareRedemption: async (record) => {
                const account = await ctx.context.internalAdapter.findUserById(record.userId as string);

                // The account was deleted after it approved the code: nothing to pair to.
                if (!account) {
                    throw oauthError("BAD_REQUEST", "invalid_grant", "Invalid device code");
                }

                if ((account as { isAnonymous?: boolean }).isAnonymous === true) {
                    throw oauthError("FORBIDDEN", "access_denied", "Create an account to pair a machine.");
                }

                try {
                    await options.precheck(record.userId as string, String((record as { id?: unknown }).id ?? ""));
                } catch (error) {
                    throw refusalOrRetryable(error);
                }

                return {};
            },
        });
        const claimed = claimedDeviceCode as { hostname?: string; id?: unknown; platform?: string };
        const name = cleanHostname(claimed.hostname);
        const platform = isOneOf(HOST_PLATFORMS, claimed.platform) ? claimed.platform : "linux";
        let device: { deviceId: string; secret: string };

        try {
            device = await options.register({ codeId: String(claimed.id ?? ""), name, platform, userId: user.id });
        } catch (error) {
            const refusal = refusalOrRetryable(error);

            // A failure of ours, or a full account (`device_limit`, which tells the machine to wait): put the code back so
            // the machine's next poll finishes the pairing, as with a failed key mint. Only a final refusal (a revoked
            // pairing among them) leaves it spent. Whether a failure of ours committed the device is the shard's to
            // know: the next registration finds it, or refuses it if it was revoked meanwhile.
            if (refusalCode(error) === undefined || isDeviceLimit(error)) {
                await restoreClaimedCode(ctx.context.adapter, claimedDeviceCode, error);
            }

            throw refusal;
        }

        // Put back after a success too: if this reply is lost on its way, the machine's next poll gets the same device
        // and secret instead of `invalid_grant` and a device nobody holds. Only the holder of the device code can poll,
        // only until the code expires, and revoking the device in Settings ends it (`devicePairingRevocations`).
        await restoreClaimedCode(ctx.context.adapter, claimedDeviceCode);

        ctx.setHeader("Cache-Control", "no-store");
        ctx.setHeader("Pragma", "no-cache");

        // The account that approved, masked, so the person at the machine sees whose it became.
        return ctx.json({ account: maskEmail(user.email), device_id: device.deviceId, name, secret: device.secret, token_type: "device_secret" });
    });

const revokeBodySchema = z.object({ api_key: z.string().max(256) });

/**
 * The CLI withdraws a key it was just issued when it could not check or save it, so retries do not stack toward
 * the key limit. The credential is the key itself (whoever holds it could already use it, and this only deletes
 * it), and only a key this flow minted (named by `cliKeyName`) and issued within a code's lifetime can be deleted
 * here, so it stays "a key just issued" and never a way to delete an old one; every refusal answers the same.
 */
const revokeKey = (options: CliDeviceAuthOptions) =>
    createAuthEndpoint("/device/revoke", { body: revokeBodySchema, metadata: { noStore: true }, method: "POST" }, async (ctx) => {
        const verified = await options.verifyApiKey(ctx.body.api_key).catch(() => null);
        const row = verified
            ? await ctx.context.adapter.findOne<{ createdAt?: Date | number | string | null; name?: string | null }>({
                  model: "apikey",
                  where: [{ field: "id", value: verified.id }],
              })
            : null;

        const age = row?.createdAt ? Date.now() - new Date(row.createdAt).getTime() : Infinity;

        if (!verified || !row || typeof row.name !== "string" || !row.name.startsWith(KEY_NAME_PREFIX) || age > CODE_LIFETIME_MS) {
            throw oauthError("BAD_REQUEST", "invalid_grant", "Invalid key");
        }

        await ctx.context.adapter.delete({ model: "apikey", where: [{ field: "id", value: verified.id }] });
        authLogger.info("[auth] api_keys.revoke_cli_device_key", { apiKeyId: verified.id, userId: verified.referenceId });
        ctx.setHeader("Cache-Control", "no-store");

        return ctx.json({ revoked: true });
    });

/**
 * Both plugins, in the order better-auth wants them. Rate limits for the
 * routes live in `AUTH_RATE_LIMIT_CUSTOM_RULES` (`auth.ts`).
 */
export const cliDeviceAuth = (options: CliDeviceAuthOptions): BetterAuthPlugin[] => {
    const stock = deviceAuthorization({
        // `expiresIn` and `interval` are left at the plugin's defaults: 30 minutes and 5 seconds.
        grant: makeGrant(options.hostPairing !== undefined) as never,
        verificationUri: DEVICE_VERIFICATION_PATH,
    }) as unknown as BetterAuthPlugin;

    return [
        stock,
        {
            endpoints: {
                redeemCliDeviceKey: redeemKey(options),
                revokeCliDeviceKey: revokeKey(options),
                ...(options.hostPairing && { redeemHostDevice: redeemHost(options.hostPairing) }),
            },
            hooks: { after: [reportLimitAtApproval(options.hostPairing)], before: [refuseGuestApproval] },
            id: "neore-cli-device-key",
        } satisfies BetterAuthPlugin,
    ];
};
