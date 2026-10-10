/**
 * Messenger pairing replaced "the first sender claims the bot": a connection
 * answers nobody until someone sends `/pair <code>` with the one-time code the
 * owner sees in settings. Pins the code helpers, the pairing mutation, the
 * owner-only regeneration, and the gate every webhook runs a sender through.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { pairConnection, regeneratePairingCode } from "./functions";
import { generatePairingCode, hashPairingCode, PAIRED_NOTICE, PAIRING_CODE_TTL_MS, parsePairCommand, PRIVATE_BOT_NOTICE } from "./lib/pairing";
import { checkSenderPairing } from "./pairing";

/** `value: false` refuses everything; otherwise each `operation:key` counts against its configured rate. */
const rateLimitOk = vi.hoisted(() => {
    return { counts: new Map<string, number>(), value: true };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/rate-limiter")>();

    return {
        ...actual,
        checkRateLimit: async (_context: unknown, operation: keyof typeof actual.RATE_LIMIT_CONFIGS, options: { key?: string } = {}) => {
            const bucket = `${operation}:${options.key ?? "global"}`;
            const used = (rateLimitOk.counts.get(bucket) ?? 0) + 1;

            rateLimitOk.counts.set(bucket, used);

            return { ok: rateLimitOk.value && used <= actual.RATE_LIMIT_CONFIGS[operation].rate };
        },
        rateLimitGuard: async () => undefined,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const session = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, email: "", id: context.auth.userId, isAdmin: false, name: "", userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: session,
        getSessionUserForQuery: session,
    };
});

const CODE_SHAPE = /^[2-9A-Z]{4}-[2-9A-Z]{4}$/u;
const OWNER = "user-owner";
const NOW = 1_800_000_000_000;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const connection = async (fields: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
        async (ctx: any) => await ctx.db.insert("messengerConnections", { connectedAt: NOW, platform: "telegram", status: "active", userId: OWNER, ...fields }),
    );

const row = async (id: string): Promise<Record<string, unknown>> => await harness.run(async (ctx: any) => await ctx.db.get(id));

/** An `HttpActionCtx` stand-in: the gate only runs `pairConnection` and schedules notices. */
const httpContext = () => {
    const scheduled: { args: { text: string } }[] = [];
    const context = {
        runMutation: async (_reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(pairConnection, args)),
        scheduler: {
            runAfter: async (_delay: number, _reference: unknown, args: { text: string }) => {
                scheduled.push({ args });
            },
        },
    };

    return { context: context as never, notices: () => scheduled.map((entry) => entry.args.text) };
};

const pairWith = async (connectionId: string, code: string, extra: { chatId?: string; senderId?: string } = {}) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(pairConnection, {
                codeHash: await hashPairingCode(code),
                connectionId,
                platformChatId: extra.chatId ?? "chat-1",
                platformUserId: extra.senderId ?? "sender-1",
            }),
    );

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    rateLimitOk.value = true;
    rateLimitOk.counts.clear();
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("pairing code helpers", () => {
    it("parses /pair commands, including Telegram's /pair@bot form, and nothing else", () => {
        expect(parsePairCommand("/pair K7QM-2XPA")).toBe("K7QM-2XPA");
        expect(parsePairCommand("pair k7qm2xpa")).toBe("k7qm2xpa");
        expect(parsePairCommand("/pair@my_bot K7QM-2XPA")).toBe("K7QM-2XPA");
        expect(parsePairCommand("hello there")).toBeNull();
        expect(parsePairCommand("/pair")).toBeNull();
        expect(parsePairCommand(undefined)).toBeNull();
    });

    it("hashes a typed-back code the same regardless of case and dash", async () => {
        const code = generatePairingCode();

        expect(code).toMatch(CODE_SHAPE);
        await expect(hashPairingCode(code.toLowerCase().replace("-", ""))).resolves.toBe(await hashPairingCode(code));
    });
});

describe("pairConnection", () => {
    it("binds the sender when the code matches, and consumes the code", async () => {
        const id = await connection({ pairingCodeExpiresAt: NOW + PAIRING_CODE_TTL_MS, pairingCodeHash: await hashPairingCode("AAAA-BBBB") });

        await expect(pairWith(id, "aaaabbbb")).resolves.toBe(true);
        expect(await row(id)).toMatchObject({ platformChatId: "chat-1", platformUserId: "sender-1" });
        expect(await row(id)).not.toHaveProperty("pairingCodeHash");

        // Consumed: nobody can re-pair with it.
        await expect(pairWith(id, "AAAA-BBBB", { senderId: "sender-2" })).resolves.toBe(false);
    });

    it("refuses a wrong code, an expired code, and an already-paired connection", async () => {
        const id = await connection({ pairingCodeExpiresAt: NOW + PAIRING_CODE_TTL_MS, pairingCodeHash: await hashPairingCode("AAAA-BBBB") });

        await expect(pairWith(id, "ZZZZ-ZZZZ")).resolves.toBe(false);

        vi.setSystemTime(NOW + PAIRING_CODE_TTL_MS + 1);
        await expect(pairWith(id, "AAAA-BBBB")).resolves.toBe(false);

        const paired = await connection({
            pairingCodeExpiresAt: NOW * 2,
            pairingCodeHash: await hashPairingCode("CCCC-DDDD"),
            platformUserId: "owner-contact",
        });

        await expect(pairWith(paired, "CCCC-DDDD")).resolves.toBe(false);
    });
});

describe("regeneratePairingCode", () => {
    it("is the owner's alone, and unpairs the current contact", async () => {
        const id = await connection({ platformChatId: "chat-1", platformUserId: "old-contact" });

        await expect(
            harness.withIdentity({ userId: "stranger" } as never).mutation(regeneratePairingCode as never, { connectionId: id } as never),
        ).rejects.toThrow();

        const result = (await harness.withIdentity({ userId: OWNER } as never).mutation(regeneratePairingCode as never, { connectionId: id } as never)) as {
            pairingCode: string;
        };

        expect(await row(id)).not.toHaveProperty("platformUserId");
        const regenerated = await row(id);

        expect(regenerated.pairingCodeHash).toBe(await hashPairingCode(result.pairingCode));
    });
});

describe("checkSenderPairing", () => {
    const delivery = { platform: "telegram", platformChatId: "chat-1" };

    it("answers only the paired contact; a stranger gets the private notice, once", async () => {
        const id = await connection({ platformChatId: "chat-1", platformUserId: "contact" });
        const doc = (await row(id)) as never;
        const { context, notices } = httpContext();

        await expect(checkSenderPairing(context, doc, { chatId: "chat-1", senderId: "contact", text: "hi" }, delivery)).resolves.toBe("proceed");
        await expect(checkSenderPairing(context, doc, { chatId: "chat-9", senderId: "stranger", text: "hi" }, delivery)).resolves.toBe("refused");
        expect(notices()).toEqual([PRIVATE_BOT_NOTICE]);

        rateLimitOk.value = false;
        await checkSenderPairing(context, doc, { chatId: "chat-9", senderId: "stranger", text: "hi" }, delivery);
        expect(notices()).toHaveLength(1);
    });

    it("pairs an unpaired connection on the right code, and refuses plain messages and wrong codes", async () => {
        const id = await connection({ pairingCodeExpiresAt: NOW + PAIRING_CODE_TTL_MS, pairingCodeHash: await hashPairingCode("AAAA-BBBB") });
        const { context, notices } = httpContext();

        await expect(checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: "first", text: "hello" }, delivery)).resolves.toBe(
            "refused",
        );
        await expect(
            checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: "guess", text: "/pair ZZZZ-ZZZZ" }, delivery),
        ).resolves.toBe("refused");
        expect(await row(id)).not.toHaveProperty("platformUserId");

        await expect(
            checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: "owner", text: "/pair aaaa-bbbb" }, delivery),
        ).resolves.toBe("just_paired");
        expect(await row(id)).toMatchObject({ platformUserId: "owner" });
        expect(notices()).toContain(PAIRED_NOTICE);
    });

    it("caps guesses per sender, so one stranger cannot lock the owner out", async () => {
        const id = await connection({ pairingCodeExpiresAt: NOW + PAIRING_CODE_TTL_MS, pairingCodeHash: await hashPairingCode("AAAA-BBBB") });
        const { context } = httpContext();

        for (let guess = 0; guess < 5; guess += 1) {
            await checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: "stranger", text: "/pair ZZZZ-ZZZZ" }, delivery);
        }

        // The stranger is out of guesses — even the right code is refused for them.
        await expect(
            checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: "stranger", text: "/pair AAAA-BBBB" }, delivery),
        ).resolves.toBe("refused");
        expect(await row(id)).not.toHaveProperty("platformUserId");

        // The owner still pairs.
        await expect(
            checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: "owner", text: "/pair AAAA-BBBB" }, delivery),
        ).resolves.toBe("just_paired");
    });

    it("caps guesses per connection across senders", async () => {
        const id = await connection({ pairingCodeExpiresAt: NOW + PAIRING_CODE_TTL_MS, pairingCodeHash: await hashPairingCode("AAAA-BBBB") });
        const { context } = httpContext();

        for (let sender = 0; sender < 30; sender += 1) {
            await checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: `bot-${String(sender)}`, text: "/pair ZZZZ-ZZZZ" }, delivery);
        }

        await expect(
            checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: "owner", text: "/pair AAAA-BBBB" }, delivery),
        ).resolves.toBe("refused");
    });

    it("refuses pairing guesses once the attempt limit is spent", async () => {
        const id = await connection({ pairingCodeExpiresAt: NOW + PAIRING_CODE_TTL_MS, pairingCodeHash: await hashPairingCode("AAAA-BBBB") });
        const { context } = httpContext();

        rateLimitOk.value = false;
        await expect(
            checkSenderPairing(context, (await row(id)) as never, { chatId: "c", senderId: "owner", text: "/pair AAAA-BBBB" }, delivery),
        ).resolves.toBe("refused");
        expect(await row(id)).not.toHaveProperty("platformUserId");
    });
});
