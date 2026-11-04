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
 *   the mint itself fails, the claimed row is put back so the next poll retries.
 *   A response lost in transit cannot be replayed (the key is never stored in
 *   the clear); the stranded key shows in Settings and can be revoked there.
 *   The per-person key cap is checked before the claim and again after the
 *   mint; a mint that finds the person over the cap withdraws its own key and answers with the refusal.
 *
 * The caller supplies the minting function (`mintApiKey`), so this file does
 * not import the auth instance it is installed into.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deviceAuthorization, redeemDeviceCode } from "better-auth/plugins";
import { z } from "zod";

import { authLogger } from "../lib/logger";
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

/** The web route a person opens to approve a code (`apps/web/src/routes/auth/device.tsx`). */
export const DEVICE_VERIFICATION_PATH = "/auth/device";

/** Matches `createScopedApiKey`: a name is 1-32 characters. */
const MAX_KEY_NAME_LENGTH = 32;

const KEY_NAME_PREFIX = "Neore CLI on ";

/** A CLI key is good for a year; `neore login --device` mints a fresh one. */
export const CLI_KEY_LIFETIME_DAYS = 365;

const DAY_SECONDS = 24 * 60 * 60;

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
    precheck: (userId: string) => Promise<void>;
    /**
     * Creates the device and its secret, after the atomic claim. `codeId` names the redeemed code: a retry after a
     * failure puts the code back, so the same id comes again and must find the device it already made.
     */
    register: (input: { codeId: string; name: string; platform: HostPlatform; userId: string }) => Promise<{ deviceId: string; secret: string }>;
}

export interface CliDeviceAuthOptions {
    /** Enables `client_id: "neore-host"` codes and `POST /device/host`. Without it a host code is refused at issue. */
    hostPairing?: HostPairingOptions;
    /** Mints a read-only public-API key for `userId`. Called once per redeemed code. */
    mintApiKey: (input: { expiresInSeconds: number; name: string; userId: string }) => Promise<MintedCliKey>;
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
 * Guests are disposable and uninvited; a long-lived credential for one outlives both properties. A guest also
 * must not be able to open (claim) or deny a code, which would keep the intended account from approving it.
 * Approval also refuses an account that is already at the key cap, so the page does not report a sign-in that
 * the redemption would refuse; the redemption-time check stays as the backstop.
 */
/** Whether the code being approved is a CLI sign-in (it mints an API key). A headless machine's code mints a device. */
const isCliCode = async (ctx: { body?: unknown; context: { adapter: { findOne: (input: never) => Promise<unknown> } } }): Promise<boolean> => {
    const raw = (ctx.body as { userCode?: unknown } | undefined)?.userCode;

    if (typeof raw !== "string") {
        return true;
    }

    const row = (await ctx.context.adapter.findOne({
        model: "deviceCode",
        where: [{ field: "userCode", value: raw.replaceAll(/[^a-z0-9]/giu, "").toUpperCase() }],
    } as never)) as { clientId?: string } | null;

    return row?.clientId !== HOST_CLIENT_ID;
};

const refuseGuestApproval = {
    handler: createAuthMiddleware(async (ctx) => {
        const session = await getSessionFromCtx(ctx);

        if ((session?.user as { isAnonymous?: boolean } | undefined)?.isAnonymous === true) {
            throw oauthError("FORBIDDEN", "access_denied", "Create an account to use this code.");
        }

        if ((session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) {
            throw oauthError("FORBIDDEN", "access_denied", "A code cannot be used while impersonating.");
        }

        if (ctx.path === "/device/approve" && session?.user.id && (await isCliCode(ctx))) {
            const keys = await ctx.context.adapter.count({ model: "apikey", where: [{ field: "referenceId", value: session.user.id }] });

            if (keys >= MAX_API_KEYS_PER_USER) {
                throw oauthError("FORBIDDEN", "key_limit", keyLimitMessage);
            }
        }
    }),
    matcher: (context: { path?: string }) => GUARDED_PATHS.has(context.path ?? ""),
};

const keyBodySchema = z.object({
    client_id: z.string().max(64).optional(),
    device_code: z.string().max(256),
});

/** Best effort: if the row cannot be restored, the person starts a new code, as before. */
const restoreClaimedCode = async (
    adapter: { create: (input: { data: Record<string, unknown>; forceAllowId?: boolean; model: string }) => Promise<unknown> },
    claimed: object,
    cause: unknown,
): Promise<void> => {
    try {
        await adapter.create({ data: { ...claimed }, forceAllowId: true, model: "deviceCode" });
    } catch (error) {
        authLogger.error("[auth] could not restore a device code after a failed key mint", { cause, error });
    }
};

/**
 * Only a refusal the pairing check MEANT (FORBIDDEN or BAD_REQUEST) is the person's to read: a full account is
 * `device_limit` (the machine waits and says so, the code stays valid), anything else `access_denied`. Any other
 * failure is ours, and the machine retries a 5xx.
 */
const refusalCode = (error: unknown): "BAD_REQUEST" | "FORBIDDEN" | undefined => {
    const code = (error as { code?: unknown } | null)?.code;

    return (code === "FORBIDDEN" || code === "BAD_REQUEST") && error instanceof Error ? code : undefined;
};

const refusalOrRetryable = (error: unknown): APIError => {
    const code = refusalCode(error);

    if (code && error instanceof Error) {
        return oauthError("FORBIDDEN", code === "BAD_REQUEST" ? "device_limit" : "access_denied", error.message);
    }

    authLogger.error("[auth] pairing a machine failed", { error });

    return oauthError("INTERNAL_SERVER_ERROR", "server_error", "The pairing could not be completed. Try again.");
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
        let minted: MintedCliKey;

        try {
            minted = await options.mintApiKey({ expiresInSeconds: CLI_KEY_LIFETIME_DAYS * DAY_SECONDS, name: cliKeyName(hostname ?? ""), userId: user.id });
        } catch (error) {
            // The claim is spent and no key exists: put the code back so the CLI's next poll can finish the
            // sign-in. Minting stays AFTER the claim, so two polls still cannot mint two keys.
            await restoreClaimedCode(ctx.context.adapter, claimedDeviceCode, error);

            throw error;
        }

        // The cap is counted before the claim and cannot be reserved (the adapter has no transaction across
        // the count and the insert), so it is counted again once the key exists: if concurrent redemptions
        // pushed the person past it, this key is withdrawn and the poll that is waiting for it gets the
        // definite refusal below (the CLI prints it and stops). The code stays spent, because nothing will poll
        // it again after that answer. Two racing mints can both withdraw; neither can leave the person over
        // the cap, and the person starts a new code once a key is revoked.
        const total = await ctx.context.adapter.count({ model: "apikey", where: [{ field: "referenceId", value: user.id }] });

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
 * Redeems an approved host code: the machine that asked receives its device id and secret, ONCE, in this
 * response. The device is registered only AFTER the plugin's atomic claim, so two racing polls cannot register
 * two devices; the secret never passes through the approving browser.
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

                if ((account as { isAnonymous?: boolean } | null)?.isAnonymous === true) {
                    throw oauthError("FORBIDDEN", "access_denied", "Create an account to pair a machine.");
                }

                try {
                    await options.precheck(record.userId as string);
                } catch (error) {
                    throw refusalOrRetryable(error);
                }

                return {};
            },
        });
        const claimed = claimedDeviceCode as { hostname?: string; platform?: string };
        const name = cleanHostname(claimed.hostname);
        const platform = isOneOf(HOST_PLATFORMS, claimed.platform) ? claimed.platform : "linux";
        let device: { deviceId: string; secret: string };

        try {
            device = await options.register({ codeId: String((claimedDeviceCode as { id?: unknown }).id ?? ""), name, platform, userId: user.id });
        } catch (error) {
            const refusal = refusalOrRetryable(error);

            // A failure of ours, or a full account (`device_limit`, which tells the machine to wait): put the code back so
            // the machine's next poll finishes the pairing, as with a failed key mint. Only a final refusal leaves it spent.
            if (refusalCode(error) !== "FORBIDDEN") {
                await restoreClaimedCode(ctx.context.adapter, claimedDeviceCode, error);
            }

            throw refusal;
        }

        ctx.setHeader("Cache-Control", "no-store");
        ctx.setHeader("Pragma", "no-cache");

        // The account that approved, masked, so the person at the machine sees whose it became.
        return ctx.json({ account: maskEmail(user.email), device_id: device.deviceId, name, secret: device.secret, token_type: "device_secret" });
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
            endpoints: { redeemCliDeviceKey: redeemKey(options), ...(options.hostPairing && { redeemHostDevice: redeemHost(options.hostPairing) }) },
            hooks: { before: [refuseGuestApproval] },
            id: "neore-cli-device-key",
        } satisfies BetterAuthPlugin,
    ];
};
