/**
 * Device execution — the procedures the web app calls.
 * A device is one paired install of the
 * desktop shell; every procedure here is its OWNER's alone, and every
 * `deviceId` from arguments is compared against the caller.
 *
 * The page is a dumb pipe: what it relays from the device (manifest, results)
 * carries the device's HMAC and is verified here, and what it relays to the
 * device (call envelopes) carries ours. Nothing here can approve a call — that
 * happens in the shell's local window.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { ACP_CLEARED } from "../acp/lib/constants";
import { onAcpCallEnded } from "../acp/lib/calls";
import { endHostSessionsOfDevice } from "../acp/lib/revoke";
import { internal } from "../_generated/internal";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";
import { deleteShardRoute, setShardRoute, shardRouteOwner } from "../lib/shard-routes";
import { decryptKey, encryptKey } from "../lib/encryption";
import {
    ACP_CLAIM_LEASE_MS,
    DEVICE_SIGNATURE_WINDOW_MS,
    MAX_DEVICE_OUTPUT_BYTES,
    MAX_DEVICE_SCOPE_PROJECTS,
    MAX_DEVICES_PER_USER,
    MAX_MANIFEST_BYTES,
} from "./lib/constants";
import { parseAcpOffers, parseManifestTools } from "./lib/manifest";
import { filterOwnProjectIds } from "./lib/scope";
import { claimWindowMs, expireOpenCalls, isAcpTool, isForwardPhase } from "./lib/state";
import { capUtf8, generateDeviceSecret, isFreshTimestamp, parseSignedPayload, verifyDevicePayload } from "./lib/signing";
import { vDeviceCallView, vDevicePlatform, vDeviceView, vDeviceCallStatusView } from "./validators";

const vDeviceName = v.string().check((value) => value.trim().length > 0 && value.length <= 80, { message: "Name must be 1-80 characters" });

/** Results carry at most the output cap plus JSON overhead; the backend re-caps anyway. */
const MAX_RESULT_PAYLOAD_CHARS = MAX_DEVICE_OUTPUT_BYTES * 2 + 8192;

// A payload the page relays is bounded before any crypto runs; its signature is a hex HMAC.
const vManifestPayload = v.string().check((value) => value.length > 0 && value.length <= MAX_MANIFEST_BYTES, { message: "Payload too large" });
const vResultPayload = v.string().check((value) => value.length > 0 && value.length <= MAX_RESULT_PAYLOAD_CHARS, { message: "Payload too large" });
const HEX_SIGNATURE = /^[0-9a-f]{64}$/u;
const vSignature = v.string().check((value) => HEX_SIGNATURE.test(value), { message: "Invalid signature" });

/** A progress report is a few short fields; anything longer is not one. */
const vProgressPayload = v.string().check((value) => value.length > 0 && value.length <= 1024, { message: "Payload too large" });
const PHASES: ReadonlySet<string> = new Set(["prompting", "running"]);

const RESULT_STATUSES: ReadonlySet<string> = new Set(["completed", "denied", "failed"]);
const DECISIONS: ReadonlySet<string> = new Set(["always", "denied", "once", "rule", "timeout"]);
const OUTPUT_PREVIEW_CHARS = 4000;

/**
 * What the relaying desktop names when it acts for a server it reaches over SSH. An optional argument on every
 * relay procedure: a host is addressed WITH the desktop that holds it, and a desktop without one.
 */
const vViaDeviceId = v.optional(v.id("devices"));

/**
 * The caller's device, or NOT_FOUND — a stranger's id reads exactly like a missing one. `viaDeviceId` must be the
 * desktop the row names (`undefined` for a device without one), so a desktop cannot act for another desktop's host.
 * That is an ownership check, not a security control: a client can name any device it owns. What stops a
 * desktop that does not hold a host's secret is the signature check on its results.
 */
const requireOwnDevice = async (
    ctx: Pick<MutationCtx, "db">,
    deviceId: Id<"devices">,
    userId: string,
    viaDeviceId?: Id<"devices">,
): Promise<Doc<"devices">> => {
    const device = await ctx.db.devices.findFirst({ where: { _id: deviceId, userId } });

    if (!device || device.viaDeviceId !== viaDeviceId) {
        throw new LunoraError("NOT_FOUND", "Device not found");
    }

    return device;
};

const deviceSecret = async (device: Doc<"devices">): Promise<string> => {
    if (device.encryptedSecret === undefined) {
        throw new LunoraError("FORBIDDEN", "Device is not paired");
    }

    return await decryptKey(device.encryptedSecret, "device-secrets");
};

/**
 * Pairs a new device. Returns its secret ONCE: the page hands it straight to
 * the shell (`device_pair`), which stores it only after a local confirmation
 * click. Guests and impersonating admins cannot pair — a device runs code as
 * the real person at the keyboard.
 */
export const registerDevice = authMutation
    .use(rateLimit("devices/register"))
    .input({ name: vDeviceName, platform: vDevicePlatform, viaDeviceId: vViaDeviceId })
    .output(v.object({ deviceId: v.string(), secret: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const { impersonatedBy, userId } = ctx.user;

        if (impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "A device cannot be paired while impersonating");
        }

        const account = await ctx.db.user.findFirst({ where: { _id: ctx.db.asId("user", userId) } });

        if (!account || account.isAnonymous === true) {
            throw new LunoraError("FORBIDDEN", "Pairing a device requires an account");
        }

        if (await isAccountDeletionUnderway(ctx, userId)) {
            throw new LunoraError("FORBIDDEN", "This account is being deleted");
        }

        const { page: existing } = await ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER + 1, where: { userId } });

        if (existing.length >= MAX_DEVICES_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `At most ${String(MAX_DEVICES_PER_USER)} devices can be paired. Remove one first.`);
        }

        // A server is paired by a desktop of the caller's that is itself paired directly: no chains.
        if (args.viaDeviceId !== undefined) {
            const desktop = await requireOwnDevice(ctx, args.viaDeviceId, userId);

            if (desktop.encryptedSecret === undefined) {
                throw new LunoraError("FORBIDDEN", "The desktop is not paired");
            }
        }

        const secret = generateDeviceSecret();
        const deviceId = await ctx.db.insert("devices", {
            createdAt: ctx.now,
            encryptedSecret: await encryptKey(secret, "device-secrets"),
            name: args.name.trim(),
            platform: args.platform,
            userId,
            ...(args.viaDeviceId !== undefined && { transport: "ssh" as const, viaDeviceId: args.viaDeviceId }),
        });

        // The host ingest has no session: it finds this device's owner, hence its shard, from this row.
        await setShardRoute(ctx, "device", deviceId as string, userId);

        ctx.log.event("devices.register_device", { platform: args.platform, ssh: args.viaDeviceId !== undefined });

        return { deviceId: deviceId as string, secret };
    });

/** The caller's paired devices. Online state is the client's to derive from `lastSeenAt` (`DEVICE_ONLINE_WINDOW_MS`). */
export const listDevices = authQuery
    .input({})
    .output(v.array(vDeviceView))
    .query(async ({ ctx }) => {
        const { page } = await ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER, orderBy: [{ createdAt: "asc" }], where: { userId: ctx.user.userId } });
        // A deleted project silently drops out of a device's list.
        const liveProjects = await filterOwnProjectIds(
            ctx,
            ctx.user.userId,
            page.flatMap((device) => device.projectIds ?? []),
        );

        return page.map((device) => {
            return {
                _id: device._id as string,
                createdAt: device.createdAt,
                name: device.name,
                platform: device.platform,
                toolNames: (device.manifest ?? []).map((tool) => tool.name),
                ...(device.acpOffers !== undefined && device.acpOffers.length > 0 && { acpOffers: device.acpOffers }),
                ...(device.lastSeenAt !== undefined && { lastSeenAt: device.lastSeenAt }),
                ...(device.projectIds !== undefined && { projectIds: device.projectIds.filter((id) => liveProjects.has(id)) }),
                ...(device.transport !== undefined && { transport: device.transport }),
                ...(device.viaDeviceId !== undefined && { viaDeviceId: device.viaDeviceId as string }),
            };
        });
    });

export const renameDevice = authMutation
    .use(rateLimit("devices/manage"))
    .input({ deviceId: v.id("devices"), name: vDeviceName })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        // The owner renames any of their devices, a server included: `viaDeviceId` guards the relay, not this.
        const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId: ctx.user.userId } });

        if (!device) {
            throw new LunoraError("NOT_FOUND", "Device not found");
        }

        await ctx.db.patch(device._id, { name: args.name.trim() });

        ctx.log.event("devices.rename_device", { renamed: true });

        return null;
    });

/**
 * Where a device's tools are offered: any of the owner's chats, or only threads of the listed projects. Applies to
 * the next turn (the tool set is built per run and re-checked when a call is created). An owner's setting for any
 * of their devices, a server included, like a rename.
 */
export const setDeviceProjectScope = authMutation
    .use(rateLimit("devices/manage"))
    .input({
        deviceId: v.id("devices"),
        scope: v.union(
            v.object({ kind: v.literal("any") }),
            v.object({
                kind: v.literal("projects"),
                projectIds: v.array(v.id("projects")).check((ids) => ids.length <= MAX_DEVICE_SCOPE_PROJECTS, { message: "Too many projects" }),
            }),
        ),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId } });

        if (!device) {
            throw new LunoraError("NOT_FOUND", "Device not found");
        }

        let projectIds: Id<"projects">[] | undefined;

        if (args.scope.kind === "projects") {
            // Only the caller's own projects: another member's project in a shared organization is not theirs to scope by.
            projectIds = [...new Set(args.scope.projectIds)];

            const own = await filterOwnProjectIds(ctx, userId, projectIds);

            if (projectIds.some((id) => !own.has(id))) {
                throw new LunoraError("NOT_FOUND", "Project not found");
            }
        }

        await patchRow(ctx.db, device, { projectIds });

        ctx.log.event("devices.set_device_project_scope", { projects: projectIds?.length ?? null });

        return null;
    });

/**
 * Unpairs a device from the web — the way out for a lost laptop. The row (and
 * with it the secret) is deleted, so nothing is ever signed for it again; its
 * audit rows stay, carrying the device's name. Revoking a desktop revokes the
 * servers it holds in the same mutation (their secrets live on that desktop);
 * revoking a server alone leaves the desktop paired.
 */
export const revokeDevice = authMutation
    .use(rateLimit("devices/manage"))
    .input({ deviceId: v.id("devices") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId } });

        if (!device) {
            throw new LunoraError("NOT_FOUND", "Device not found");
        }

        const { page: owned } = await ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER, where: { userId } });
        const hosts = owned.filter((other) => other.viaDeviceId === device._id);

        for (const revoked of [device, ...hosts]) {
            await expireOpenCalls(ctx, revoked._id, "The device was removed");
            await endHostSessionsOfDevice(ctx, revoked._id, ctx.now);
            await deleteShardRoute(ctx, "device", revoked._id as string);
            await ctx.db.delete(revoked._id);
        }

        ctx.log.event("devices.revoke_device", { hosts: hosts.length, revoked: true });

        return null;
    });

/** When this isolate last confirmed a device's ingest route, so a heartbeat reads the route table once in a while, not every 30 s. */
const routeCheckedAt = new Map<string, number>();
const ROUTE_RECHECK_MS = 10 * 60_000;

/**
 * A device paired before the host ingest existed has no `shardRoutes` row. Its next heartbeat writes it, so it
 * works without re-pairing.
 */
const ensureDeviceRoute = async (ctx: Pick<MutationCtx, "db">, deviceId: string, userId: string, now: number): Promise<void> => {
    if (now - (routeCheckedAt.get(deviceId) ?? 0) < ROUTE_RECHECK_MS) {
        return;
    }

    try {
        if ((await shardRouteOwner(ctx, "device", deviceId)) === null) {
            await setShardRoute(ctx, "device", deviceId, userId);
        }

        routeCheckedAt.set(deviceId, now);
    } catch (error) {
        // A heartbeat must not fail for a route hint; the next one tries again.
        console.error("[devices] Failed to record the ingest route:", error);
    }
};

/**
 * The shell's page beats every 30 s while open. `paired: false` tells it this
 * device is gone (revoked elsewhere), so it offers pairing again.
 */
export const heartbeatDevice = authMutation
    .use(rateLimit("devices/heartbeat"))
    .input({ deviceId: v.id("devices"), viaDeviceId: vViaDeviceId })
    .output(v.object({ paired: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId: ctx.user.userId } });

        if (!device || device.viaDeviceId !== args.viaDeviceId) {
            return { paired: false };
        }

        await ctx.db.patch(device._id, { lastSeenAt: ctx.now });
        await ensureDeviceRoute(ctx, device._id as string, ctx.user.userId, ctx.now);

        ctx.log.event("devices.heartbeat_device", { paired: true });

        return { paired: true };
    });

/**
 * Stores the device's tool list. The manifest is SIGNED by the device's Rust
 * core, must be fresh and newer than the stored one (no rollback to an older
 * tool set), and is re-validated (`lib/manifest.ts`).
 */
export const updateDeviceManifest = authMutation
    .use(rateLimit("devices/manifest"))
    .input({ deviceId: v.id("devices"), payload: vManifestPayload, signature: vSignature, viaDeviceId: vViaDeviceId })
    .output(v.object({ toolCount: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const device = await requireOwnDevice(ctx, args.deviceId, ctx.user.userId, args.viaDeviceId);
        const secret = await deviceSecret(device);

        if (!(await verifyDevicePayload(secret, "manifest", args.payload, args.signature))) {
            throw new LunoraError("FORBIDDEN", "Manifest signature is invalid");
        }

        const { now } = ctx;
        const manifest = parseSignedPayload(args.payload, "manifest", device._id as string);
        const issuedAt = manifest?.issuedAt;

        if (
            !manifest ||
            !isFreshTimestamp(issuedAt, now, DEVICE_SIGNATURE_WINDOW_MS) ||
            (device.manifestIssuedAt !== undefined && issuedAt <= device.manifestIssuedAt)
        ) {
            throw new LunoraError("BAD_REQUEST", "Manifest is stale or malformed");
        }

        const tools = parseManifestTools(manifest.tools);
        const offers = parseAcpOffers(manifest.acpOffers);

        if (!tools || !offers) {
            throw new LunoraError("BAD_REQUEST", "Manifest tools are invalid");
        }

        await ctx.db.patch(device._id, { acpOffers: offers, lastSeenAt: now, manifest: tools, manifestIssuedAt: issuedAt });

        ctx.log.event("devices.update_device_manifest", { toolCount: tools.length });

        return { toolCount: tools.length };
    });

/**
 * Calls waiting for this device and for the servers it holds — the relay's live
 * query. The page forwards each envelope to the shell, which verifies our
 * signature before anything else. `hostDeviceIds` are the servers the relay
 * speaks for; one that is not the caller's, or is held by another desktop,
 * contributes nothing.
 */
export const listPendingDeviceCalls = authQuery
    .input({
        deviceId: v.id("devices"),
        hostDeviceIds: v.optional(v.array(v.id("devices")).check((ids) => ids.length <= MAX_DEVICES_PER_USER, { message: "Too many servers" })),
    })
    .output(v.array(v.object({ callId: v.string(), deviceId: v.string(), envelope: v.string(), signature: v.string() })))
    .query(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const primary = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId } });

        // The desktop is the primary device: a server's id is reached only through the desktop that holds it.
        if (!primary || primary.viaDeviceId !== undefined) {
            return [];
        }

        const held = await Promise.all((args.hostDeviceIds ?? []).map(async (id) => await ctx.db.devices.findFirst({ where: { _id: id, userId } })));
        const deviceIds = [args.deviceId, ...held.flatMap((host) => (host?.viaDeviceId === args.deviceId ? [host._id] : []))];
        const pages = await Promise.all(
            deviceIds.map(
                async (deviceId) =>
                    await ctx.db.deviceCalls.findMany({ limit: 10, orderBy: [{ createdAt: "asc" }], where: { deviceId, status: "pending", userId } }),
            ),
        );

        return pages
            .flatMap(({ page }) => page)
            .toSorted((a, b) => a.createdAt - b.createdAt)
            .slice(0, 10)
            .map((call) => {
                return { callId: call._id as string, deviceId: call.deviceId as string, envelope: call.envelope, signature: call.signature };
            });
    });

/**
 * Claim-once: the first relay to claim a call runs it; a second window, a
 * stale page or a late claim past the claim window gets `claimed: false`.
 *
 * A coding-agent command is claimed on a lease (plans/acp-agent-host.md §4.1): one that is not completed in time
 * goes back to `pending` (`acp/calls.ts`) and is claimed again, until its deadline, however long ago it was first
 * taken. The claim window only decides whether it is ever taken.
 */
export const claimDeviceCall = authMutation
    .use(rateLimit("devices/relay"))
    .input({ callId: v.id("deviceCalls"), claimId: v.optional(v.string().max(MAX_LENGTH.id)), deviceId: v.id("devices"), viaDeviceId: vViaDeviceId })
    .output(v.object({ claimed: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId, deviceId: args.deviceId, userId } });
        const { now } = ctx;

        // The same window asking again: its claim was saved and the answer was lost, so it is told so. No other
        // window, and no claim without an id, is ever handed a call that is already taken.
        if (call?.status === "claimed" && args.claimId !== undefined && call.claimId === args.claimId) {
            return { claimed: true };
        }

        if (call?.status !== "pending" || now >= call.deadline) {
            return { claimed: false };
        }

        // `claimedAt` on a pending call means it was claimed before and its lease lapsed.
        const withinWindow = call.claimedAt === undefined ? now - call.createdAt <= claimWindowMs(call.toolName) : isAcpTool(call.toolName);

        if (!withinWindow) {
            return { claimed: false };
        }

        await requireOwnDevice(ctx, args.deviceId, userId, args.viaDeviceId);

        await ctx.db.patch(call._id, { claimedAt: now, status: "claimed", ...(args.claimId !== undefined && { claimId: args.claimId }) });

        if (isAcpTool(call.toolName)) {
            await ctx.scheduler.runAfter(ACP_CLAIM_LEASE_MS + 1000, internal.acp.calls.checkAcpCall, { callId: call._id });
        }

        ctx.log.event("devices.claim_device_call", { claimed: true });

        return { claimed: true };
    });

/**
 * Records a device's SIGNED result. A terminal call is never rewritten, so a
 * replayed result for a finished call is ignored (`accepted: false`).
 */
export const completeDeviceCall = authMutation
    .use(rateLimit("devices/relay"))
    .input({ callId: v.id("deviceCalls"), deviceId: v.id("devices"), payload: vResultPayload, signature: vSignature, viaDeviceId: vViaDeviceId })
    .output(v.object({ accepted: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const device = await requireOwnDevice(ctx, args.deviceId, userId, args.viaDeviceId);
        const secret = await deviceSecret(device);

        if (!(await verifyDevicePayload(secret, "result", args.payload, args.signature))) {
            throw new LunoraError("FORBIDDEN", "Result signature is invalid");
        }

        const result = parseSignedPayload(args.payload, "result", device._id as string);

        if (result?.callId !== args.callId || typeof result.status !== "string" || !RESULT_STATUSES.has(result.status)) {
            throw new LunoraError("BAD_REQUEST", "Result is malformed");
        }

        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId, deviceId: device._id, userId } });

        if (call?.status !== "claimed") {
            return { accepted: false };
        }

        const { now } = ctx;
        const output = typeof result.output === "string" ? capUtf8(result.output, MAX_DEVICE_OUTPUT_BYTES) : undefined;
        const error = typeof result.error === "string" ? result.error.slice(0, 1000) : undefined;
        const decision = typeof result.decision === "string" && DECISIONS.has(result.decision) ? result.decision : undefined;
        const exitCode = typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode) ? result.exitCode : undefined;

        const status = result.status as "completed" | "denied" | "failed";

        await ctx.db.patch(call._id, {
            completedAt: now,
            status,
            ...(output && { output: output.text, truncated: output.truncated || result.truncated === true }),
            ...(error !== undefined && { error }),
            ...(decision !== undefined && { decision }),
            ...(exitCode !== undefined && { exitCode }),
            ...(isAcpTool(call.toolName) && ACP_CLEARED),
        });
        await onAcpCallEnded(ctx, call, { status, ...(error !== undefined && { error }) }, now);

        ctx.log.event("devices.complete_device_call", { accepted: true, status: result.status });

        return { accepted: true };
    });

/**
 * Records where a claimed call is on the device — the approval window is
 * showing it (`prompting`), or it is running — so the chat can say so. SIGNED
 * by the device like a result (domain `progress`), fresh, for this call, and
 * forward-only: a replayed or reordered report can never move a call back, and
 * no report can finish one. Display only — nothing reads `phase` to decide.
 */
export const reportDeviceCallProgress = authMutation
    .use(rateLimit("devices/relay"))
    .input({ callId: v.id("deviceCalls"), deviceId: v.id("devices"), payload: vProgressPayload, signature: vSignature, viaDeviceId: vViaDeviceId })
    .output(v.object({ accepted: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const device = await requireOwnDevice(ctx, args.deviceId, userId, args.viaDeviceId);
        const secret = await deviceSecret(device);

        if (!(await verifyDevicePayload(secret, "progress", args.payload, args.signature))) {
            throw new LunoraError("FORBIDDEN", "Progress signature is invalid");
        }

        const { now } = ctx;
        const report = parseSignedPayload(args.payload, "progress", device._id as string);
        const phase = report?.phase;

        if (
            report?.callId !== args.callId ||
            typeof phase !== "string" ||
            !PHASES.has(phase) ||
            !isFreshTimestamp(report.issuedAt, now, DEVICE_SIGNATURE_WINDOW_MS)
        ) {
            throw new LunoraError("BAD_REQUEST", "Progress report is malformed");
        }

        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId, deviceId: device._id, userId } });
        const next = phase as "prompting" | "running";

        if (call?.status !== "claimed" || !isForwardPhase(call.phase, next)) {
            return { accepted: false };
        }

        await ctx.db.patch(call._id, { phase: next, phaseAt: now });

        ctx.log.event("devices.report_device_call_progress", { phase: next });

        return { accepted: true };
    });

/**
 * The shell refused a claimed call's envelope before running anything (not
 * paired any more, expired, not signed for it) and so has no signed result to
 * send. Fails the call at once instead of leaving the agent waiting for the
 * deadline. Unsigned on purpose: all it can do is stop the caller's OWN call.
 */
export const releaseDeviceCall = authMutation
    .use(rateLimit("devices/relay"))
    .input({
        callId: v.id("deviceCalls"),
        deviceId: v.id("devices"),
        reason: v.string().check((value) => value.length <= 500, { message: "Reason too long" }),
        viaDeviceId: vViaDeviceId,
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId } });
        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId, deviceId: args.deviceId, userId } });

        const released = call?.status === "claimed" && device !== null && device.viaDeviceId === args.viaDeviceId;

        if (released) {
            const error = `The device refused the request: ${args.reason}`;

            await ctx.db.patch(call._id, { completedAt: ctx.now, error, status: "failed", ...(isAcpTool(call.toolName) && ACP_CLEARED) });
            await onAcpCallEnded(ctx, call, { error, status: "failed" }, ctx.now);
        }

        ctx.log.event("devices.release_device_call", { released });

        return null;
    });

/** The audit list: the caller's recent device calls, newest first, optionally for one device. */
export const listDeviceCalls = authQuery
    .input({
        deviceId: v.optional(v.id("devices")),
        limit: v.optional(v.number().check((value) => Number.isSafeInteger(value) && value >= 1 && value <= 100, { message: "limit must be 1-100" })),
    })
    .output(v.array(vDeviceCallView))
    .query(async ({ args, ctx }) => {
        const { page } = await ctx.db.deviceCalls.findMany({
            limit: args.limit ?? 50,
            orderBy: [{ createdAt: "desc" }],
            where: { userId: ctx.user.userId, ...(args.deviceId !== undefined && { deviceId: args.deviceId }) },
        });

        return page.map((call) => {
            return {
                _id: call._id as string,
                createdAt: call.createdAt,
                deviceId: call.deviceId as string,
                deviceName: call.deviceName,
                input: call.input.slice(0, OUTPUT_PREVIEW_CHARS),
                status: call.status,
                taintedBy: call.taintedBy,
                threadId: call.threadId as string,
                toolName: call.toolName,
                ...(call.claimedAt !== undefined && { claimedAt: call.claimedAt }),
                ...(call.completedAt !== undefined && { completedAt: call.completedAt }),
                ...(call.decision !== undefined && { decision: call.decision }),
                ...(call.error !== undefined && { error: call.error }),
                ...(call.exitCode !== undefined && { exitCode: call.exitCode }),
                ...(call.output !== undefined && { output: call.output.slice(0, OUTPUT_PREVIEW_CHARS) }),
                ...(call.truncated !== undefined && { truncated: call.truncated }),
            };
        });
    });

/**
 * Where one device call is, by the AI SDK tool call it answers — what the
 * chat's device row shows ("waiting for approval on …"). The chat mounts it
 * only while that call is still running, never on first paint. `null` until
 * the tool created its row, and for anyone but the caller who owns it.
 */
export const getDeviceCallByToolCall = authQuery
    .input({ toolCallId: v.string().max(MAX_LENGTH.short) })
    .output(v.union(v.null(), vDeviceCallStatusView))
    .query(async ({ args, ctx }) => {
        const call = await ctx.db.deviceCalls.findFirst({ where: { toolCallId: args.toolCallId, userId: ctx.user.userId } });

        if (!call) {
            return null;
        }

        return {
            _id: call._id as string,
            deviceName: call.deviceName,
            status: call.status,
            toolName: call.toolName,
            ...(call.phase !== undefined && { phase: call.phase }),
        };
    });
