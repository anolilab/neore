/**
 * `requestSecret`: the agent asks for a value on a card and gets back a reference.
 *
 * - the pause: the tool always asks, and a headless run never gets it;
 * - answering (`claimSecretAnswer`): one claim on the run's snapshot, only for a
 *   `requestSecret` request, the value stored encrypted behind a reference, and a
 *   decline that resumes the run with a denial;
 * - the value never reaches a message, the tool result, the resume payload or any
 *   other row;
 * - a reference works once, only for its user and thread, only before it expires,
 *   and only for the destination the user approved (`consumeAsProviderKey`,
 *   `consumeAsMcpHeader`).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/encryption` reads the key when it loads.
const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

vi.mock("../../agent/client", () => {
    return { createTool: (definition: unknown) => definition };
});

const { default: schema } = await import("../../schema");
const { claimSecretAnswer, secretResumeArgs } = await import("./request-secret-claim");
const { consumeAsMcpHeader, consumeAsProviderKey } = await import("./secret-consumers");
const { storeRequestedSecret, sweepExpiredSecrets, takeRequestedSecret } = await import("./secret-requests");
const { claimAskUserAnswer } = await import("./ask-user-claim");
const { collectApprovalRequestIds } = await import("./tool-approval-claim");
const { SECRET_DECLINED_REASON, SECRET_TTL_MS } = await import("../tools/request-secret-constants");
const { applyToolPermissions, defaultToolPermission, resolveToolPermission, toolPermissionKey } = await import("./tool-permissions");
const { isGrantableKey } = await import("./tool-permission-grants");
const { decryptKey } = await import("../../lib/encryption");

type Harness = ReturnType<typeof lunoraTest>;

interface ToolDefinition {
    execute: (context: unknown, input: unknown, options: unknown) => Promise<unknown>;
    inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    needsApproval: unknown;
}

const OWNER = "owner-user";
const STRANGER = "other-user";
const SECRET = "sk-live-0123456789-supersecret";
const PROVIDER_USE = { kind: "provider_key", provider: "openai" } as const;
const HEADER_USE = { header: "Authorization", kind: "mcp_header", server: "Files" } as const;

const CONFIG = {
    autoMediaEnrichment: false,
    instructions: "system prompt",
    mcpServerNames: [],
    model: "test-model",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: true,
    toolNames: ["requestSecret", "askUser"],
};

const request = (approvalId: string, toolName: string, input: unknown) => {
    return {
        content: [
            { input, toolCallId: `call-${approvalId}`, toolName, type: "tool-call" },
            { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
        ],
        role: "assistant",
    };
};

const SECRET_INPUT = { label: "OpenAI API key", purpose: "To run the nightly summary", use: PROVIDER_USE };

let harness: Harness;
let threadId: string;

const insertMessage = async (order: number, message: unknown) =>
    await harness.run(
        async (ctx: any) => await ctx.db.insert("messages", { message, order, status: "success", stepOrder: 0, threadId, tool: true, userId: OWNER }),
    );

const insertRun = async (approvalId: string) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("toolApprovalRuns", { approvalId, config: CONFIG, createdAt: Date.now(), status: "pending", threadId, userId: OWNER }),
    );

const save = async (value: string | null, options: { approvalId?: string; callerId?: string } = {}) =>
    await harness.run(
        async (ctx: any) =>
            await claimSecretAnswer(ctx, {
                approvalId: options.approvalId ?? "sec-1",
                callerId: options.callerId ?? OWNER,
                now: Date.now(),
                reply: value === null ? { kind: "decline" } : { kind: "save", value },
                threadId: threadId as never,
            }),
    );

const statuses = async () =>
    await harness.run(async (ctx: any) => {
        const runs: { status: string }[] = await ctx.db.query("toolApprovalRuns").collect();

        return runs.map((run) => run.status);
    });

const secretRows = async () => await harness.run(async (ctx: any) => await ctx.db.query("requestedSecrets").collect());

const takeProvider = async (ref: string, options: { callerId?: string; now?: number; thread?: string } = {}) =>
    await harness.run(
        async (ctx: any) =>
            await consumeAsProviderKey(ctx, {
                now: options.now ?? Date.now(),
                ref,
                threadId: options.thread ?? threadId,
                userId: options.callerId ?? OWNER,
            }),
    );

const takeHeader = async (ref: string, options: { callerId?: string; now?: number } = {}) =>
    await harness.run(async (ctx: any) => await consumeAsMcpHeader(ctx, { now: options.now ?? Date.now(), ref, threadId, userId: options.callerId ?? OWNER }));

const preferences = async () => await harness.run(async (ctx: any) => await ctx.db.query("aiUserPreferences").first());

const storeSecret = async (use: typeof HEADER_USE | typeof PROVIDER_USE = PROVIDER_USE, now = Date.now()) =>
    await harness.run(
        async (ctx: any) =>
            await storeRequestedSecret(ctx, { approvalId: "sec-x", label: "L", now, threadId: threadId as never, use, userId: OWNER, value: SECRET }),
    );

/** Every row of every table the feature can touch, as text. */
const everythingStored = async () =>
    await harness.run(async (ctx: any) => {
        const tables = ["messages", "toolApprovalRuns", "requestedSecrets", "persistentChunks", "persistentStreams", "aiUserPreferences", "threads"] as const;
        const rows = await Promise.all(tables.map(async (table) => await ctx.db.query(table).collect()));

        return JSON.stringify(rows);
    });

const NOT_FOUND = /not found/iu;
const NOT_A_SECRET = /not a secret request/iu;
const NOT_A_QUESTION = /not a question/iu;
const REF_SHAPE = /^sec_[\w-]{32}$/u;
const BAD_VALUE = /Provide a value/iu;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

    await insertMessage(0, { content: "set up the nightly summary", role: "user" });
    await insertMessage(1, request("sec-1", "requestSecret", SECRET_INPUT));
    await insertRun("sec-1");
});

afterEach(() => {
    harness.close();
});

describe("the pause", () => {
    it("always asks, whatever the permission layer says", async () => {
        const { default: requestSecretTool } = await import("../tools/request-secret");

        expect((requestSecretTool as unknown as ToolDefinition).needsApproval).toBe(true);
    });

    it("records the request as a pending approval of the run", () => {
        expect(collectApprovalRequestIds([{ message: request("sec-1", "requestSecret", SECRET_INPUT) }])).toStrictEqual(["sec-1"]);
    });

    it("takes a label, an optional purpose and a destination, and no value", async () => {
        const { default: requestSecretTool } = await import("../tools/request-secret");
        const { inputSchema } = requestSecretTool as unknown as ToolDefinition;

        expect(inputSchema.safeParse(SECRET_INPUT).success).toBe(true);
        expect(inputSchema.safeParse({ label: "Token", use: HEADER_USE }).success).toBe(true);
        expect(inputSchema.safeParse({ label: "Token", use: { kind: "provider_key", provider: "nope" } }).success).toBe(false);
        expect(inputSchema.safeParse({ label: "Token", use: PROVIDER_USE, value: "sk-oops" }).success).toBe(false);
        expect(inputSchema.safeParse({ label: "", use: PROVIDER_USE }).success).toBe(false);
    });
});

describe("permissions", () => {
    const tool = { key: toolPermissionKey("builtin", "requestSecret"), source: "builtin" as const };

    it("asks by default and stays in an interactive run", () => {
        expect(defaultToolPermission("builtin", undefined, "requestSecret")).toBe("ask");
        expect(resolveToolPermission(tool, undefined)).toBe("ask");
    });

    it("is removed from a headless run, even set to auto or with an inherited approval", () => {
        expect(resolveToolPermission(tool, undefined, { headless: true })).toBe("off");
        expect(resolveToolPermission(tool, { [tool.key]: "auto" }, { headless: true })).toBe("off");
        expect(resolveToolPermission(tool, undefined, { headless: true, headlessApproved: new Set(["requestSecret"]) })).toBe("off");
    });

    it("never takes a time-boxed allow", () => {
        const now = 1000;

        expect(isGrantableKey(tool.key)).toBe(false);
        expect(resolveToolPermission(tool, undefined, { now, timedGrants: { [tool.key]: now + 60_000 } })).toBe("ask");
    });

    it("keeps the tool out of a headless tool set", () => {
        const tools = { requestSecret: { execute: async () => "ok" } } as never;
        const { removed } = applyToolPermissions(tools, () => tool, { [tool.key]: "auto" }, { headless: true });

        expect(removed).toStrictEqual(["requestSecret"]);
    });
});

describe("claimSecretAnswer", () => {
    it("saving approves the call once and returns a reference, with the value stored encrypted", async () => {
        const claim = await save(SECRET);

        expect(claim).toMatchObject({ kind: "claimed", ownerId: OWNER, toolName: "requestSecret" });
        expect(claim).toHaveProperty("ref");
        expect(await statuses()).toStrictEqual(["approved"]);

        const [row] = await secretRows();

        expect(row).toMatchObject({ approvalId: "sec-1", label: "OpenAI API key", status: "saved", threadId, use: PROVIDER_USE, userId: OWNER });
        expect(row.encryptedValue).not.toContain(SECRET);
        expect(await decryptKey(row.encryptedValue, "provider-keys")).toBe(SECRET);
        expect(row.expiresAt - row.createdAt).toBe(SECRET_TTL_MS);
    });

    it("trims the value", async () => {
        await save(`  ${SECRET}\n`);

        const [row] = await secretRows();

        expect(await decryptKey(row.encryptedValue, "provider-keys")).toBe(SECRET);
    });

    it("declining denies the call and stores nothing", async () => {
        const claim = await save(null);

        expect(claim).toMatchObject({ kind: "claimed" });
        expect(claim).not.toHaveProperty("ref");
        expect(await statuses()).toStrictEqual(["denied"]);
        expect(await secretRows()).toHaveLength(0);
    });

    it("a second answer (double submit, second tab) gets the first outcome back and stores no second value", async () => {
        await save(SECRET);

        expect(await save("sk-other-0123456789")).toMatchObject({ kind: "already-resolved", status: "approved" });
        expect(await secretRows()).toHaveLength(1);
    });

    it("refuses an empty value, or one longer than its destination takes, without storing", async () => {
        await expect(save(" ".repeat(3))).rejects.toThrow(BAD_VALUE);
        await expect(save("x".repeat(501))).rejects.toThrow(BAD_VALUE);
        expect(await secretRows()).toHaveLength(0);
    });

    it("lets a header value be longer than a provider key", async () => {
        await insertMessage(2, { content: "and the files server", role: "user" });
        await insertMessage(3, request("sec-2", "requestSecret", { label: "Files token", use: HEADER_USE }));
        await insertRun("sec-2");

        await save("t".repeat(2000), { approvalId: "sec-2" });

        expect(await secretRows()).toHaveLength(1);
    });

    it("refuses anyone but the owner", async () => {
        await expect(save(SECRET, { callerId: STRANGER })).rejects.toThrow(NOT_FOUND);
        expect(await statuses()).toStrictEqual(["pending"]);
        expect(await secretRows()).toHaveLength(0);
    });

    it("refuses a request for another tool", async () => {
        await insertMessage(2, { content: "and a question", role: "user" });
        await insertMessage(3, request("other-1", "mcp_Files__delete", {}));
        await insertRun("other-1");

        await expect(save(SECRET, { approvalId: "other-1" })).rejects.toThrow(NOT_A_SECRET);
    });

    it("is refused by the question procedure, which answers askUser requests only", async () => {
        await expect(
            harness.run(
                async (ctx: any) =>
                    await claimAskUserAnswer(ctx, {
                        approvalId: "sec-1",
                        callerId: OWNER,
                        reply: { answer: "yes", kind: "answer" },
                        threadId: threadId as never,
                    }),
            ),
        ).rejects.toThrow(NOT_A_QUESTION);
    });
});

describe("resuming the run", () => {
    it("a saved value resumes the run with the reference as the only answer", async () => {
        const claim = await save(SECRET);
        const resume = secretResumeArgs(claim as never);

        expect(resume).toStrictEqual({ answer: (claim as { ref: string }).ref, approved: true });
        expect(JSON.stringify(resume)).not.toContain(SECRET);
    });

    it("a decline resumes it with a denial and a reason", async () => {
        const resume = secretResumeArgs((await save(null)) as never);

        expect(resume).toStrictEqual({ approved: false, denyReason: SECRET_DECLINED_REASON });
    });

    it("the resumed tool returns the reference and a status, never the value", async () => {
        const claim = (await save(SECRET)) as { ref: string };
        const { createAnsweredRequestSecretTool } = await import("../tools/request-secret");
        const answered = createAnsweredRequestSecretTool(claim.ref) as unknown as ToolDefinition;
        const output = await answered.execute({}, SECRET_INPUT, { toolCallId: "call-sec-1" });

        expect(answered.needsApproval).toBe(true);
        expect(output).toStrictEqual({ ref: claim.ref, status: "saved" });
        expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it("the registered tool, run without an answer, reports that nothing was provided", async () => {
        const { default: requestSecretTool } = await import("../tools/request-secret");
        const output = await (requestSecretTool as unknown as ToolDefinition).execute({}, SECRET_INPUT, { toolCallId: "call-sec-1" });

        expect(output).toMatchObject({ status: "unavailable" });
    });

    it("the value is in no row but its own, and there only as ciphertext", async () => {
        const claim = (await save(SECRET)) as { ref: string };

        // The model's view of the thread after the resume: the call and its result.
        await insertMessage(2, {
            content: [
                {
                    output: { type: "json", value: { ref: claim.ref, status: "saved" } },
                    toolCallId: "call-sec-1",
                    toolName: "requestSecret",
                    type: "tool-result",
                },
            ],
            role: "tool",
        });

        const stored = await everythingStored();

        expect(stored).not.toContain(SECRET);
        expect(stored).toContain(claim.ref);

        // The consumer's write path keeps it out of the thread too.
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { userId: OWNER }));
        await takeProvider(claim.ref);

        expect(await everythingStored()).not.toContain(SECRET);
    });
});

describe("a reference", () => {
    const take = async (ref: string, options: { callerId?: string; kind?: "mcp_header" | "provider_key"; now?: number; thread?: string } = {}) =>
        await harness.run(
            async (ctx: any) =>
                await takeRequestedSecret(ctx, {
                    kind: options.kind ?? "provider_key",
                    now: options.now ?? Date.now(),
                    ref,
                    threadId: options.thread ?? threadId,
                    userId: options.callerId ?? OWNER,
                }),
        );

    it("is opaque and not guessable from the row", async () => {
        const ref = await storeSecret();

        expect(ref).toMatch(REF_SHAPE);
        expect(await storeSecret()).not.toBe(ref);
    });

    it("works once and fails the second time, the first call deleting the stored value", async () => {
        const ref = await storeSecret();

        expect(await take(ref)).toMatchObject({ ok: true, value: SECRET });

        const [row] = await secretRows();

        expect(row.status).toBe("used");
        expect(row.encryptedValue).toBeUndefined();
        expect(await take(ref)).toStrictEqual({ ok: false, status: "used" });
    });

    it("fails once it has expired, and the value is gone", async () => {
        const now = Date.now();
        const ref = await storeSecret(PROVIDER_USE, now);

        expect(await take(ref, { now: now + SECRET_TTL_MS })).toStrictEqual({ ok: false, status: "expired" });

        const [row] = await secretRows();

        expect(row.encryptedValue).toBeUndefined();
        expect(await take(ref, { now: now + SECRET_TTL_MS + 1 })).toStrictEqual({ ok: false, status: "expired" });
    });

    it("still works just before it expires", async () => {
        const now = Date.now();
        const ref = await storeSecret(PROVIDER_USE, now);

        expect(await take(ref, { now: now + SECRET_TTL_MS - 1 })).toMatchObject({ ok: true });
    });

    it("fails for another user, indistinguishably from a reference that never existed", async () => {
        const ref = await storeSecret();

        expect(await take(ref, { callerId: STRANGER })).toStrictEqual({ ok: false, status: "not_found" });
        expect(await take("sec_nope")).toStrictEqual({ ok: false, status: "not_found" });
        expect(await take(ref)).toMatchObject({ ok: true });
    });

    it("fails from another thread", async () => {
        const ref = await storeSecret();
        const other = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Fork", userId: OWNER }));

        expect(await take(ref, { thread: other })).toStrictEqual({ ok: false, status: "not_found" });
    });

    it("fails for a consumer other than the destination the user approved, leaving the value", async () => {
        const ref = await storeSecret(PROVIDER_USE);

        expect(await take(ref, { kind: "mcp_header" })).toStrictEqual({ ok: false, status: "wrong_use" });
        expect(await take(ref, { kind: "provider_key" })).toMatchObject({ ok: true });
    });

    it("is swept once it lapses, used or not, and not before", async () => {
        const now = Date.now();

        await storeSecret(PROVIDER_USE, now - SECRET_TTL_MS - 10);
        await storeSecret(PROVIDER_USE, now - SECRET_TTL_MS - 5);
        await storeSecret(PROVIDER_USE, now);

        const removed = await harness.run(async (ctx: any) => await sweepExpiredSecrets(ctx, now, 100));

        expect(removed).toBe(2);
        expect(await secretRows()).toHaveLength(1);
    });
});

describe("consuming as a provider key", () => {
    it("saves the key like a manual save and keeps every other provider's key", async () => {
        const { encryptKey } = await import("../../lib/encryption");

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    providerApiKeys: {
                        anthropic: { enabled: true, encryptedKey: await encryptKey("sk-ant-keep-0123456789"), last4: "6789" },
                        groq: { enabled: false, encryptedKey: await encryptKey("gsk-keep-0123456789") },
                    },
                    userId: OWNER,
                }),
        );

        const ref = await storeSecret();
        const result = await takeProvider(ref);

        expect(result).toMatchObject({ provider: "openai", status: "saved" });

        const { providerApiKeys } = await preferences();

        expect(Object.keys(providerApiKeys).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["anthropic", "groq", "openai"]);
        expect(providerApiKeys.openai).toMatchObject({ enabled: true, keyVersion: 1, last4: SECRET.slice(-4) });
        expect(await decryptKey(providerApiKeys.openai.encryptedKey, "provider-keys")).toBe(SECRET);
        expect(await decryptKey(providerApiKeys.anthropic.encryptedKey, "provider-keys")).toBe("sk-ant-keep-0123456789");
        expect(providerApiKeys.groq.enabled).toBe(false);
        expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("creates the preferences row when the user has none", async () => {
        await takeProvider(await storeSecret());

        const { providerApiKeys } = await preferences();

        expect(providerApiKeys.openai.enabled).toBe(true);
    });

    it("works once", async () => {
        const ref = await storeSecret();

        expect(await takeProvider(ref)).toMatchObject({ status: "saved" });
        expect(await takeProvider(ref)).toMatchObject({ status: "used" });
    });

    it("refuses another user's, another thread's and an expired reference, writing nothing", async () => {
        const ref = await storeSecret();

        expect(await takeProvider(ref, { callerId: STRANGER })).toMatchObject({ status: "not_found" });
        expect(await takeProvider(ref, { thread: "other-thread" })).toMatchObject({ status: "not_found" });
        expect(await takeProvider(ref, { now: Date.now() + SECRET_TTL_MS + 1 })).toMatchObject({ status: "expired" });
        expect(await preferences()).toBeNull();
    });

    it("refuses a reference requested for an MCP header", async () => {
        expect(await takeProvider(await storeSecret(HEADER_USE))).toMatchObject({ status: "wrong_use" });
        expect(await preferences()).toBeNull();
    });
});

describe("consuming as an MCP server header", () => {
    const server = (name: string, headers?: { key: string; value: string }[]) => {
        return { enabled: true, ...(headers && { headers }), name, protocol: "http" as const, url: `https://${name.toLowerCase()}.example.com/mcp` };
    };

    const withServers = async (...mcpServers: ReturnType<typeof server>[]) =>
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { mcpServers, userId: OWNER }));

    it("sets the header on the named server and leaves the rest alone", async () => {
        await withServers(server("Files", [{ key: "X-Team", value: "a" }]), server("Other"));

        const result = await takeHeader(await storeSecret(HEADER_USE));

        expect(result).toMatchObject({ header: "Authorization", server: "Files", status: "saved" });
        expect(JSON.stringify(result)).not.toContain(SECRET);

        const { mcpServers } = await preferences();

        expect(mcpServers[0].headers).toStrictEqual([
            { key: "X-Team", value: "a" },
            { key: "Authorization", value: SECRET },
        ]);
        expect(mcpServers[1]).toStrictEqual(server("Other"));
    });

    it("replaces a header of the same name, whatever its case", async () => {
        await withServers(server("Files", [{ key: "authorization", value: "old" }]));
        await takeHeader(await storeSecret(HEADER_USE));

        const { mcpServers } = await preferences();

        expect(mcpServers[0].headers).toStrictEqual([{ key: "Authorization", value: SECRET }]);
    });

    it("leaves the reference unused when the server does not exist", async () => {
        await withServers(server("Other"));

        const ref = await storeSecret(HEADER_USE);

        expect(await takeHeader(ref)).toMatchObject({ status: "destination_missing" });

        // The reference survived: it is still the user's to spend once the server is there.
        const [row] = await secretRows();

        expect(row.status).toBe("saved");
        expect(row.encryptedValue).toBeDefined();
    });

    it("works once, and not for another user or a reference meant for a provider", async () => {
        await withServers(server("Files"));

        const ref = await storeSecret(HEADER_USE);

        expect(await takeHeader(ref, { callerId: STRANGER })).toMatchObject({ status: "not_found" });
        expect(await takeHeader(ref)).toMatchObject({ status: "saved" });
        expect(await takeHeader(ref)).toMatchObject({ status: "used" });
        expect(await takeHeader(await storeSecret(PROVIDER_USE))).toMatchObject({ status: "wrong_use" });
    });
});
