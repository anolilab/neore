/**
 * The device upload route (`acp/upload-http.ts`) end to end against the in-memory harness and the real TUS handler:
 * a signed create and its chunks reach the owner's staging prefix; a replayed create, a stale signature, an
 * altered offset, body, size or type under an otherwise valid signature, and another user's upload id are each
 * refused.
 */
import { createHash } from "node:crypto";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeBucket } from "../../test/fake-upload-bucket";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi } = await import("../../test/registered-api");

    return registeredApi(await importOriginal(), registry);
});

const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { registerModule } = await import("../../test/registered-api");
const { default: schema } = await import("../schema");
const devices = await import("../devices/functions");
const { signDevicePayload } = await import("../devices/lib/signing");
const { DEVICE_SIGNATURE_WINDOW_MS } = await import("../devices/lib/constants");
const { resetFloodGuard, resetOwnerCache } = await import("./http");
const { hostUploadHttpAction } = await import("./upload-http");
const { stagingPrefixFor } = await import("../lib/chat-upload-staging");
const { HOST_MEDIA_MAX_BYTES, HOST_UPLOAD_PATH, HOST_UPLOAD_PAYLOAD_HEADER, HOST_UPLOAD_SIGNATURE_HEADER } = await import("./lib/constants");

registerModule(registry, "lib_shard_routes", await import("../lib/shard-routes"));
registerModule(registry, "acp_upload", await import("./upload"));
registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));
registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));

const NOT_THE_DEVICE_LIMIT = /(?<!hosts%2F)uploads%2Fcreate/u;
const ORIGIN = "https://backend.example.test";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MB = 1024 * 1024;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let bucket: ReturnType<typeof fakeBucket>;
let reaps: ReturnType<typeof vi.fn>;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertUser = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;

const httpContext = () => {
    const runners = {
        runAction: async () => {
            throw new Error("no actions here");
        },
        runMutation: async (ref: never, args: never) => await harness.run(async (ctx: any) => await ctx.runMutation(ref, args)),
        runQuery: async (ref: never, args: never) => await harness.run(async (ctx: any) => await ctx.runQuery(ref, args)),
    };

    return { ...runners, auth: { getIdentity: async () => null, userId: null }, forShard: () => runners, scheduler: { runAfter: reaps } } as never;
};

interface Paired {
    deviceId: string;
    secret: string;
    userId: string;
}

const pair = async (userId: string): Promise<Paired> => {
    const { deviceId, secret } = (await as(userId).mutation(devices.registerDevice as never, { name: "Laptop", platform: "linux" } as never)) as {
        deviceId: string;
        secret: string;
    };

    return { deviceId, secret, userId };
};

const base64url = (text: string): string => btoa(String.fromCodePoint(...new TextEncoder().encode(text))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const metadata = (type: string): string => `filename ${btoa("chart.png")},filetype ${btoa(type)}`;

let nonceCounter = 0;
const nonce = (): string => {
    nonceCounter += 1;

    return `nonce-${String(nonceCounter).padStart(12, "0")}`;
};

interface Signing {
    domain?: "turn" | "upload";
    secret?: string;
}

/** The two headers a device sends: its payload and the signature over it. */
const sign = async (device: Paired, fields: Record<string, unknown>, signing: Signing = {}): Promise<Record<string, string>> => {
    const payload = JSON.stringify({ deviceId: device.deviceId, issuedAt: Date.now(), kind: "upload", v: 1, ...fields });

    return {
        [HOST_UPLOAD_PAYLOAD_HEADER]: base64url(payload),
        [HOST_UPLOAD_SIGNATURE_HEADER]: await signDevicePayload(signing.secret ?? device.secret, signing.domain ?? "upload", payload),
    };
};

const send = async (request: Request): Promise<Response> => await hostUploadHttpAction(httpContext(), request, bucket.bucket);

const createRequest = async (device: Paired, overrides: { fields?: Record<string, unknown>; headers?: Record<string, string>; signing?: Signing; url?: string } = {}) => {
    const signed = await sign(device, { method: "POST", nonce: nonce(), size: PNG.byteLength, type: "image/png", ...overrides.fields }, overrides.signing);

    return new Request(overrides.url ?? `${ORIGIN}${HOST_UPLOAD_PATH}`, {
        headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(PNG.byteLength), "Upload-Metadata": metadata("image/png"), ...signed, ...overrides.headers },
        method: "POST",
    });
};

const patchRequest = async (
    device: Paired,
    uploadId: string,
    overrides: { body?: Uint8Array; fields?: Record<string, unknown>; headers?: Record<string, string>; signing?: Signing } = {},
) => {
    const body = overrides.body ?? PNG;
    const signed = await sign(device, { bodySha256: sha256(body), method: "PATCH", offset: 0, uploadId, ...overrides.fields }, overrides.signing);

    return new Request(`${ORIGIN}${HOST_UPLOAD_PATH}/${uploadId}`, {
        body,
        headers: { "Content-Type": "application/offset+octet-stream", "Tus-Resumable": "1.0.0", "Upload-Offset": "0", ...signed, ...overrides.headers },
        method: "PATCH",
    });
};

const headRequest = async (device: Paired, uploadId: string, overrides: { fields?: Record<string, unknown>; signing?: Signing } = {}) =>
    new Request(`${ORIGIN}${HOST_UPLOAD_PATH}/${uploadId}`, {
        headers: { "Tus-Resumable": "1.0.0", ...(await sign(device, { method: "HEAD", uploadId, ...overrides.fields }, overrides.signing)) },
        method: "HEAD",
    });

const statusOf = async (request: Request): Promise<number> => {
    const response = await send(request);

    return response.status;
};

const create = async (device: Paired): Promise<string> => {
    const response = await send(await createRequest(device));

    expect(response.status).toBe(201);

    return response.headers.get("Location")!.split("/").pop()!;
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    bucket = fakeBucket();
    reaps = vi.fn(async () => "job");
    resetFloodGuard();
    resetOwnerCache();
});

afterEach(() => {
    harness.close();
});

describe("a signed upload from a paired computer", () => {
    it("creates, continues and resumes an upload under the device owner's staging prefix", async () => {
        const owner = await pair(await insertUser());
        const uploadId = await create(owner);

        expect(reaps).toHaveBeenCalledWith(expect.any(Number), expect.anything(), { keys: [`${stagingPrefixFor(owner.userId)}${uploadId}`] });

        const head = await send(await headRequest(owner, uploadId));

        expect(head.status).toBe(200);
        expect(head.headers.get("Upload-Offset")).toBe("0");

        const patched = await send(await patchRequest(owner, uploadId));

        expect(patched.status).toBe(204);

        const staged = bucket.objects.get(`${stagingPrefixFor(owner.userId)}${uploadId}`);

        expect([...staged!.bytes]).toEqual([...PNG]);
        expect(staged!.contentType).toBe("image/png");
    });

    it("refuses a replayed create: the nonce is claimed once", async () => {
        const owner = await pair(await insertUser());
        const request = await createRequest(owner);

        expect(await statusOf(request.clone())).toBe(201);
        expect(await statusOf(request.clone())).toBe(401);
    });

    it("refuses a stale signature on every method, without touching storage", async () => {
        const owner = await pair(await insertUser());
        const uploadId = await create(owner);
        const stale = { issuedAt: Date.now() - DEVICE_SIGNATURE_WINDOW_MS - 1000 };

        expect(await statusOf(await createRequest(owner, { fields: stale }))).toBe(401);
        expect(await statusOf(await patchRequest(owner, uploadId, { fields: stale }))).toBe(401);
        expect(await statusOf(await headRequest(owner, uploadId, { fields: stale }))).toBe(401);
        expect([...bucket.objects.keys()].filter((key) => key.startsWith("uploads/"))).toEqual([]);
    });

    it("refuses another user's upload id on PATCH and HEAD as not found", async () => {
        const alice = await pair(await insertUser());
        const bob = await pair(await insertUser());
        const uploadId = await create(alice);

        // Bob's device signs correctly for Bob; the id is Alice's, and the handler only looks under Bob's prefix.
        expect(await statusOf(await patchRequest(bob, uploadId))).toBe(404);
        expect(await statusOf(await headRequest(bob, uploadId))).toBe(404);
        expect(bucket.objects.get(`${stagingPrefixFor(alice.userId)}${uploadId}`)).toBeUndefined();

        // The upload is still Alice's and still whole.
        expect(await statusOf(await patchRequest(alice, uploadId))).toBe(204);
    });

    it("refuses a request altered under an otherwise valid signature", async () => {
        const owner = await pair(await insertUser());
        const uploadId = await create(owner);
        const other = await create(owner);

        // Another offset than the one signed.
        expect(await statusOf(await patchRequest(owner, uploadId, { headers: { "Upload-Offset": "4" } }))).toBe(401);
        // Another body than the one hashed.
        const forged = await patchRequest(owner, uploadId);
        const swapped = new Request(forged.url, { body: Uint8Array.from([...PNG, 9]), headers: forged.headers, method: "PATCH" });

        expect(await statusOf(swapped)).toBe(401);
        // A signature for one upload presented on another's path.
        const onOther = await patchRequest(owner, uploadId);

        expect(await statusOf(new Request(`${ORIGIN}${HOST_UPLOAD_PATH}/${other}`, { body: PNG, headers: onOther.headers, method: "PATCH" }))).toBe(401);
        // Another size or type than the ones signed.
        expect(await statusOf(await createRequest(owner, { headers: { "Upload-Length": String(PNG.byteLength + 1) } }))).toBe(401);
        expect(await statusOf(await createRequest(owner, { headers: { "Upload-Metadata": metadata("application/pdf") } }))).toBe(401);
        // A signed HEAD cannot be used to write.
        const head = await headRequest(owner, uploadId);

        expect(await statusOf(new Request(`${ORIGIN}${HOST_UPLOAD_PATH}/${uploadId}`, { body: PNG, headers: head.headers, method: "PATCH" }))).toBe(401);
        expect(bucket.objects.get(`${stagingPrefixFor(owner.userId)}${uploadId}`)).toBeUndefined();
    });

    it("refuses a signature that is not an upload signature, from the wrong secret, or from an unknown or revoked device", async () => {
        const owner = await pair(await insertUser());
        const stranger = await pair(await insertUser());

        expect(await statusOf(await createRequest(owner, { signing: { domain: "turn" } }))).toBe(401);
        expect(await statusOf(await createRequest(owner, { signing: { secret: stranger.secret } }))).toBe(401);
        expect(await statusOf(await createRequest({ ...owner, deviceId: "nosuchdevice" }))).toBe(401);

        await as(owner.userId).mutation(devices.revokeDevice as never, { deviceId: owner.deviceId } as never);
        resetOwnerCache();

        expect(await statusOf(await createRequest(owner))).toBe(401);
    });

    it("charges a create to the devices' own limit, not the person's", async () => {
        const owner = await pair(await insertUser());

        await create(owner);

        const rows = JSON.stringify(await harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect()));

        expect(rows).toContain("hosts%2Fuploads%2Fcreate");
        expect(rows).not.toMatch(NOT_THE_DEVICE_LIMIT);
    });

    it("refuses a create that carries a body, whatever its length header says", async () => {
        const owner = await pair(await insertUser());
        const request = await createRequest(owner);
        const withBody = new Request(request.url, { body: "x", headers: request.headers, method: "POST" });

        expect(await statusOf(withBody)).toBe(401);
    });

    it("refuses a request with no signature headers, a malformed one, or a payload for another device", async () => {
        const owner = await pair(await insertUser());
        const base = { "Tus-Resumable": "1.0.0", "Upload-Length": "12", "Upload-Metadata": metadata("image/png") };

        expect(await statusOf(new Request(`${ORIGIN}${HOST_UPLOAD_PATH}`, { headers: base, method: "POST" }))).toBe(401);
        expect(
            await statusOf(new Request(`${ORIGIN}${HOST_UPLOAD_PATH}`, { headers: { ...base, [HOST_UPLOAD_PAYLOAD_HEADER]: "!!", [HOST_UPLOAD_SIGNATURE_HEADER]: "x" }, method: "POST" })),
        ).toBe(401);
        expect(await statusOf(await createRequest(owner, { fields: { deviceId: "someoneelse" } }))).toBe(401);
    });

    it("refuses a type or size the device route does not take, as the file and not the caller", async () => {
        const owner = await pair(await insertUser());
        const declare = async (type: string, size: number): Promise<number> =>
            await statusOf(
                await createRequest(owner, {
                    fields: { size, type },
                    headers: { "Upload-Length": String(size), "Upload-Metadata": metadata(type) },
                }),
            );

        for (const type of ["text/html", "image/svg+xml", "application/javascript", "text/css", "application/xml", "image/bmp"]) {
            expect(await declare(type, 10), type).toBe(415);
        }

        expect(await declare("image/png", HOST_MEDIA_MAX_BYTES + 1)).toBe(413);
        expect(await declare("image/png", 0)).toBe(400);
        expect(await declare("image/png", 20 * MB)).toBe(201);
    });

    it("takes only create, patch and head, and no purpose", async () => {
        const owner = await pair(await insertUser());
        const uploadId = await create(owner);

        expect(await statusOf(new Request(`${ORIGIN}${HOST_UPLOAD_PATH}/${uploadId}`, { method: "DELETE" }))).toBe(405);
        expect(await statusOf(new Request(`${ORIGIN}${HOST_UPLOAD_PATH}/${uploadId}`, { method: "GET" }))).toBe(405);
        expect(await statusOf(await createRequest(owner, { url: `${ORIGIN}${HOST_UPLOAD_PATH}?purpose=reference-media` }))).toBe(401);
    });

    it("answers a post from one address over the flood limit with 429 before reading anything", async () => {
        const owner = await pair(await insertUser());
        const { floodAllowed } = await import("./http");
        const { INGEST_FLOOD_LIMIT_PER_MINUTE } = await import("./lib/constants");

        for (let count = 0; count < INGEST_FLOOD_LIMIT_PER_MINUTE; count += 1) {
            floodAllowed("192.0.2.9", Date.now());
        }

        const request = await createRequest(owner, { headers: { "cf-connecting-ip": "192.0.2.9" } });

        expect(await statusOf(request)).toBe(429);
    });
});
