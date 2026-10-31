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
const { deleteThreadSecrets, discardThreadSecrets, invalidSecretUse, replyKeyOfStream, storeRequestedSecret, sweepExpiredSecrets, takeRequestedSecret } =
    await import("./secret-requests");
const { headersForConnectionTest, mcpServersWithSecretHeaders, pruneMcpSecretHeaders } = await import("../../auth/lib/mcp-secret-headers");
const agentThreads = await import("../../agent/threads");
const { redactPreferences } = await import("../../auth/lib/byok-keys");
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
/** What the answer stores: the card's destination plus the URL of the server it named at that moment. */
const FILES_URL = "https://files.example.com/mcp";
const STORED_HEADER_USE = { ...HEADER_USE, url: FILES_URL } as const;

const CONFIG = {
    autoMediaEnrichment: false,
    instructions: "system prompt",
    mcpServerNames: [],
    model: "test-model",
    replyKey: "stream-A",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: true,
    startedBy: OWNER,
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

const insertRun = async (approvalId: string, config: Record<string, unknown> = CONFIG, streamId?: string) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("toolApprovalRuns", {
                approvalId,
                config,
                createdAt: Date.now(),
                status: "pending",
                ...(streamId !== undefined && { streamId }),
                threadId,
                userId: OWNER,
            }),
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

const takeProvider = async (ref: string, options: { callerId?: string; now?: number; startedBy?: string; thread?: string } = {}) =>
    await harness.run(
        async (ctx: any) =>
            await consumeAsProviderKey(ctx, {
                now: options.now ?? Date.now(),
                ref,
                startedBy: options.startedBy ?? options.callerId ?? OWNER,
                threadId: options.thread ?? threadId,
                userId: options.callerId ?? OWNER,
            }),
    );

const takeHeader = async (ref: string, options: { callerId?: string; now?: number; startedBy?: string } = {}) =>
    await harness.run(
        async (ctx: any) =>
            await consumeAsMcpHeader(ctx, {
                now: options.now ?? Date.now(),
                ref,
                startedBy: options.startedBy ?? options.callerId ?? OWNER,
                threadId,
                userId: options.callerId ?? OWNER,
            }),
    );

const preferences = async () => await harness.run(async (ctx: any) => await ctx.db.query("aiUserPreferences").first());

const storeSecret = async (use: typeof PROVIDER_USE | typeof STORED_HEADER_USE = PROVIDER_USE, now = Date.now(), replyKey?: string) =>
    await harness.run(
        async (ctx: any) =>
            await storeRequestedSecret(ctx, {
                approvalId: "sec-x",
                label: "L",
                now,
                ...(replyKey !== undefined && { replyKey }),
                threadId: threadId as never,
                use,
                userId: OWNER,
                value: SECRET,
            }),
    );

/** Every row of every table the feature can touch, as text. */
const everythingStored = async () =>
    await harness.run(async (ctx: any) => {
        const tables = [
            "messages",
            "toolApprovalRuns",
            "requestedSecrets",
            "persistentChunks",
            "persistentStreams",
            "aiUserPreferences",
            "threads",
            "documentHistory",
        ] as const;
        const rows = await Promise.all(tables.map(async (table) => await ctx.db.query(table).collect()));

        return JSON.stringify(rows);
    });

const NOT_FOUND = /not found/iu;
const NOT_A_SECRET = /not a secret request/iu;
const NOT_A_QUESTION = /not a question/iu;
const REF_SHAPE = /^sec_[\w-]{32}$/u;
const BAD_VALUE = /Provide a value/iu;
const NO_SERVER = /no saved MCP server/iu;
const AMBIGUOUS_SERVER = /more than one/iu;
const BAD_HEADER_VALUE = /line break|control/iu;
const COLLABORATOR_TURN = /only a reply you started/iu;

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

    it("records which reply the snapshot belongs to on the stored reference", async () => {
        await save(SECRET);

        expect(await secretRows()).toMatchObject([{ replyKey: "stream-A" }]);
    });

    it("refuses a value for a turn a collaborator started, rolling the claim back and storing nothing", async () => {
        await insertMessage(2, { content: "and again", role: "user" });
        await insertMessage(3, request("sec-2", "requestSecret", SECRET_INPUT));
        await insertRun("sec-2", { ...CONFIG, startedBy: STRANGER });

        await expect(save(SECRET, { approvalId: "sec-2" })).rejects.toThrow(COLLABORATOR_TURN);
        expect(await secretRows()).toHaveLength(0);
        expect(await statuses()).toStrictEqual(["pending", "pending"]);
        // Declining is still possible.
        expect(await save(null, { approvalId: "sec-2" })).toMatchObject({ kind: "claimed" });
    });

    it("refuses a value for a snapshot that names nobody as the starter", async () => {
        const legacy: Record<string, unknown> = { ...CONFIG };

        delete legacy.startedBy;

        await insertMessage(2, { content: "and again", role: "user" });
        await insertMessage(3, request("sec-2", "requestSecret", SECRET_INPUT));
        await insertRun("sec-2", legacy);

        await expect(save(SECRET, { approvalId: "sec-2" })).rejects.toThrow(COLLABORATOR_TURN);
        expect(await secretRows()).toHaveLength(0);
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
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", { mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }], userId: OWNER }),
        );
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

        // The claim of the other call is rolled back with the refusal, not left approved.
        expect(await statuses()).toStrictEqual(["pending", "pending"]);
        expect(await secretRows()).toHaveLength(0);
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
    const take = async (
        ref: string,
        options: { callerId?: string; kind?: "mcp_header" | "provider_key"; now?: number; startedBy?: string; thread?: string } = {},
    ) =>
        await harness.run(
            async (ctx: any) =>
                await takeRequestedSecret(ctx, {
                    kind: options.kind ?? "provider_key",
                    now: options.now ?? Date.now(),
                    ref,
                    startedBy: options.startedBy ?? options.callerId ?? OWNER,
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
        expect(await takeProvider(await storeSecret(STORED_HEADER_USE))).toMatchObject({ status: "wrong_use" });
        expect(await preferences()).toBeNull();
    });
});

describe("consuming as an MCP server header", () => {
    const server = (name: string, headers?: { key: string; value: string }[], url = `https://${name.toLowerCase()}.example.com/mcp`) => {
        return { enabled: true, ...(headers && { headers }), name, protocol: "http" as const, url };
    };

    const withServers = async (...mcpServers: ReturnType<typeof server>[]) =>
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { mcpServers, userId: OWNER }));

    it("stores the header encrypted beside the server, never in the server's own header list", async () => {
        await withServers(server("Files", [{ key: "X-Team", value: "a" }]), server("Other"));

        const result = await takeHeader(await storeSecret(STORED_HEADER_USE));

        expect(result).toMatchObject({ header: "Authorization", server: "Files", status: "saved" });
        expect(JSON.stringify(result)).not.toContain(SECRET);

        const { mcpSecretHeaders, mcpServers } = await preferences();

        expect(mcpServers[0].headers).toStrictEqual([{ key: "X-Team", value: "a" }]);
        expect(mcpServers[1]).toStrictEqual(server("Other"));
        expect(mcpSecretHeaders).toHaveLength(1);
        expect(mcpSecretHeaders[0]).toMatchObject({ header: "Authorization", server: "Files", url: FILES_URL });
        expect(mcpSecretHeaders[0].encryptedValue).not.toContain(SECRET);
        expect(await decryptKey(mcpSecretHeaders[0].encryptedValue, "mcp-headers")).toBe(SECRET);
    });

    it("removes a manual header of the same name from that server, so the secret is the one in effect", async () => {
        await withServers(
            server("Files", [
                { key: "authorization", value: "old-manual-token" },
                { key: "X-Team", value: "a" },
            ]),
            server("Other", [{ key: "Authorization", value: "other" }]),
        );
        await takeHeader(await storeSecret(STORED_HEADER_USE));

        const { mcpServers } = await preferences();

        expect(mcpServers[0].headers).toStrictEqual([{ key: "X-Team", value: "a" }]);
        expect(mcpServers[1].headers).toStrictEqual([{ key: "Authorization", value: "other" }]);
    });

    it("leaves the plaintext in no row at all, the audit history included", async () => {
        await withServers(server("Files"));
        await takeHeader(await storeSecret(STORED_HEADER_USE));

        const history = await harness.run(async (ctx: any) => await ctx.db.query("documentHistory").collect());

        // The write was audited (a snapshot of the preferences row exists), and it holds only ciphertext.
        expect(history.some((row: { tableName: string }) => row.tableName === "aiUserPreferences")).toBe(true);
        expect(await everythingStored()).not.toContain(SECRET);
    });

    it("replaces a secret header of the same name, whatever its case, on the same server", async () => {
        await withServers(server("Files"));
        await takeHeader(await storeSecret({ ...STORED_HEADER_USE, header: "authorization" } as never));

        const second = await storeSecret(STORED_HEADER_USE);

        await takeHeader(second);

        const { mcpSecretHeaders } = await preferences();

        expect(mcpSecretHeaders).toHaveLength(1);
        expect(mcpSecretHeaders[0].header).toBe("Authorization");
    });

    it("leaves the reference unused when the server does not exist", async () => {
        await withServers(server("Other"));

        const ref = await storeSecret(STORED_HEADER_USE);

        expect(await takeHeader(ref)).toMatchObject({ status: "destination_missing" });

        const [row] = await secretRows();

        expect(row.status).toBe("saved");
        expect(row.encryptedValue).toBeDefined();
    });

    it("refuses when the server of that name now lives at another URL, or two servers match", async () => {
        await withServers(server("Files", undefined, "https://elsewhere.example.com/mcp"));

        const ref = await storeSecret(STORED_HEADER_USE);

        expect(await takeHeader(ref)).toMatchObject({ status: "destination_missing" });
        expect(((await preferences()) as { mcpSecretHeaders?: unknown[] }).mcpSecretHeaders ?? []).toHaveLength(0);

        await harness.run(async (ctx: any) => {
            const row = await ctx.db.query("aiUserPreferences").first();

            await ctx.db.patch(row._id, { mcpServers: [server("Files"), server("Files")] });
        });

        expect(await takeHeader(ref)).toMatchObject({ status: "destination_missing" });
        expect(await secretRows()).toHaveLength(1);
        const kept = await secretRows();

        expect(kept.map((row: { encryptedValue?: string }) => row.encryptedValue)).not.toContain(undefined);
    });

    it("refuses a reference stored without the server's URL", async () => {
        await withServers(server("Files"));

        expect(await takeHeader(await storeSecret(HEADER_USE as never))).toMatchObject({ status: "destination_missing" });
    });

    it("works once, and not for another user or a reference meant for a provider", async () => {
        await withServers(server("Files"));

        const ref = await storeSecret(STORED_HEADER_USE);

        expect(await takeHeader(ref, { callerId: STRANGER })).toMatchObject({ status: "not_found" });
        expect(await takeHeader(ref)).toMatchObject({ status: "saved" });
        expect(await takeHeader(ref)).toMatchObject({ status: "used" });
        expect(await takeHeader(await storeSecret(PROVIDER_USE))).toMatchObject({ status: "wrong_use" });
    });
});

describe("the turn that spends a reference", () => {
    it("is refused when it was not started by the owner, writing nothing", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { userId: OWNER }));

        const ref = await storeSecret();

        // A collaborator's fresh turn runs as the collaborator; a continuation runs as the owner but keeps who started it.
        expect(await takeProvider(ref, { callerId: STRANGER })).toMatchObject({ status: "not_found" });
        expect(await takeProvider(ref, { startedBy: STRANGER })).toMatchObject({ status: "wrong_run" });
        const unchanged = await preferences();

        expect(unchanged).not.toHaveProperty("providerApiKeys");
        expect(await takeProvider(ref)).toMatchObject({ status: "saved" });
    });

    it("is refused for a header too", async () => {
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }],
                    userId: OWNER,
                }),
        );

        expect(await takeHeader(await storeSecret(STORED_HEADER_USE), { startedBy: STRANGER })).toMatchObject({ status: "wrong_run" });
    });
});

describe("the audit history of the stored header secrets", () => {
    it("never holds the ciphertext of a saved header, on a write or a delete", async () => {
        const id = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    mcpSecretHeaders: [{ encryptedValue: "v1:CIPHERTEXT-ONE", header: "Authorization", server: "Files", url: FILES_URL }],
                    mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }],
                    userId: OWNER,
                }),
        );

        await harness.run(
            async (ctx: any) =>
                await ctx.db.patch(id, {
                    mcpSecretHeaders: [{ encryptedValue: "v1:CIPHERTEXT-TWO", header: "Authorization", server: "Files", url: FILES_URL }],
                }),
        );
        await harness.run(async (ctx: any) => await ctx.db.delete(id));

        const history = JSON.stringify(await harness.run(async (ctx: any) => await ctx.db.query("documentHistory").collect()));

        expect(history).toContain("Files");
        expect(history).not.toContain("CIPHERTEXT-ONE");
        expect(history).not.toContain("CIPHERTEXT-TWO");
    });
});

describe("keeping the stored header secrets in step with the server list", () => {
    const secret = (server: string, url: string, header = "Authorization") => {
        return { encryptedValue: "v1:x", header, server, url };
    };
    const entry = (name: string, url: string, headers?: { key: string; value: string }[]) => {
        return { enabled: true, ...(headers && { headers }), name, protocol: "http" as const, url };
    };

    it("drops a secret whose server was deleted or moved, or whose header the user now sets by hand", () => {
        const kept = pruneMcpSecretHeaders(
            [
                secret("Files", FILES_URL),
                secret("Gone", "https://gone.example.com/mcp"),
                secret("Moved", "https://old.example.com/mcp"),
                secret("Typed", "https://typed.example.com/mcp"),
            ],
            [
                entry("Files", FILES_URL, [{ key: "X-Team", value: "a" }]),
                entry("Moved", "https://new.example.com/mcp"),
                entry("Typed", "https://typed.example.com/mcp", [{ key: "authorization", value: "typed-by-hand" }]),
            ],
        );

        expect(kept).toStrictEqual([secret("Files", FILES_URL)]);
    });

    it("looks at every server with that name and address, not just the first", () => {
        const kept = pruneMcpSecretHeaders(
            [secret("Files", FILES_URL)],
            [entry("Files", FILES_URL), entry("Files", FILES_URL, [{ key: "Authorization", value: "typed-by-hand" }])],
        );

        expect(kept).toStrictEqual([]);
    });
});

describe("the headers of a connection test", () => {
    it("lets a header typed in the form win over a saved secret of the same name, as saving the form would", () => {
        const headers = headersForConnectionTest(
            [{ key: "authorization", value: "typed-new-token" }],
            [
                { key: "Authorization", value: "saved-old-token" },
                { key: "X-Team", value: "saved-team" },
            ],
        );

        expect(headers).toStrictEqual([
            { key: "authorization", value: "typed-new-token" },
            { key: "X-Team", value: "saved-team" },
        ]);
    });

    it("sends the saved secrets when the form holds nothing", () => {
        expect(headersForConnectionTest(undefined, [{ key: "Authorization", value: "saved" }])).toStrictEqual([{ key: "Authorization", value: "saved" }]);
    });
});

describe("what the preferences row shows a client", () => {
    it("drops the encrypted headers of saved secrets and keeps the server list", () => {
        const doc: Record<string, unknown> = {
            mcpSecretHeaders: [{ encryptedValue: "v1:abc", header: "Authorization", server: "Files", url: FILES_URL }],
            mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }],
        };

        redactPreferences(doc);

        expect(JSON.stringify(doc)).not.toContain("v1:abc");
        expect(doc.mcpServers).toHaveLength(1);
    });
});

describe("the runtime's view of the servers", () => {
    type Entry = { enabled: boolean; headers?: { key: string; value: string }[]; name: string; protocol: "http"; url: string };

    const servers: Entry[] = [
        { enabled: true, headers: [{ key: "X-Team", value: "a" }], name: "Files", protocol: "http", url: FILES_URL },
        { enabled: true, name: "Other", protocol: "http", url: "https://other.example.com/mcp" },
    ];

    it("adds a saved secret to its own server only, as a plain header the client builds the request from", async () => {
        const { encryptKey: encrypt } = await import("../../lib/encryption");
        const secret = { encryptedValue: await encrypt(SECRET, "mcp-headers"), header: "Authorization", server: "Files", url: FILES_URL };
        const out = await mcpServersWithSecretHeaders(servers, [secret]);

        expect(out[0]?.headers).toStrictEqual([
            { key: "X-Team", value: "a" },
            { key: "Authorization", value: SECRET },
        ]);
        expect(out[1]?.headers).toBeUndefined();
    });

    it("lets a secret replace a manual header of the same name, and skips one it cannot read", async () => {
        const { encryptKey } = await import("../../lib/encryption");
        const manual: Entry[] = [{ ...servers[0]!, headers: [{ key: "authorization", value: "old" }] }];
        const out = await mcpServersWithSecretHeaders(manual, [
            { encryptedValue: await encryptKey(SECRET, "mcp-headers"), header: "Authorization", server: "Files", url: FILES_URL },
            { encryptedValue: "v1:garbage", header: "X-Bad", server: "Files", url: FILES_URL },
        ]);

        expect(out[0]?.headers).toStrictEqual([{ key: "Authorization", value: SECRET }]);
    });

    it("ignores a secret whose server changed URL", async () => {
        const { encryptKey } = await import("../../lib/encryption");
        const out = await mcpServersWithSecretHeaders(servers, [
            { encryptedValue: await encryptKey(SECRET, "mcp-headers"), header: "Authorization", server: "Files", url: "https://evil.example.com/mcp" },
        ]);

        expect(JSON.stringify(out)).not.toContain(SECRET);
    });
});

describe("the audit history of the preferences row", () => {
    it("blanks the value of a header saved by hand, which the Settings page stores as plaintext", async () => {
        const id = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    mcpServers: [
                        { enabled: true, headers: [{ key: "Authorization", value: "manual-token-0123" }], name: "Files", protocol: "http", url: FILES_URL },
                    ],
                    userId: OWNER,
                }),
        );

        await harness.run(
            async (ctx: any) =>
                await ctx.db.patch(id, {
                    mcpServers: [
                        { enabled: false, headers: [{ key: "Authorization", value: "rotated-token-4567" }], name: "Files", protocol: "http", url: FILES_URL },
                    ],
                }),
        );

        const history = JSON.stringify(await harness.run(async (ctx: any) => await ctx.db.query("documentHistory").collect()));

        expect(history).toContain("Files");
        expect(history).not.toContain("manual-token-0123");
        expect(history).not.toContain("rotated-token-4567");
    });
});

describe("what a request may name", () => {
    it("refuses header names the transport owns, whatever their case", () => {
        for (const header of ["Host", "cookie", "CONNECTION", "Transfer-Encoding", "content-length", "Upgrade", "Proxy-Authorization", "proxy-anything"]) {
            expect(invalidSecretUse({ header, kind: "mcp_header", server: "Files" })).toBeDefined();
        }

        expect(invalidSecretUse({ header: "Authorization", kind: "mcp_header", server: "Files" })).toBeUndefined();
        expect(invalidSecretUse({ header: "X-Api-Key", kind: "mcp_header", server: "Files" })).toBeUndefined();
    });

    it("is refused at the tool's own schema too", async () => {
        const { default: requestSecretTool } = await import("../tools/request-secret");
        const { inputSchema } = requestSecretTool as unknown as ToolDefinition;

        expect(inputSchema.safeParse({ label: "T", use: { ...HEADER_USE, header: "Host" } }).success).toBe(false);
        expect(inputSchema.safeParse({ label: "T", use: { ...HEADER_USE, header: "Proxy-Authorization" } }).success).toBe(false);
        expect(inputSchema.safeParse({ label: "T", use: HEADER_USE }).success).toBe(true);
    });
});

describe("answering for an MCP server", () => {
    const answerHeader = async (value: string | null) => {
        await insertMessage(2, { content: "and the files server", role: "user" });
        await insertMessage(3, request("sec-2", "requestSecret", { label: "Files token", use: HEADER_USE }));
        await insertRun("sec-2");

        return await save(value, { approvalId: "sec-2" });
    };

    const servers = async (...mcpServers: { name: string; url: string }[]) =>
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    mcpServers: mcpServers.map((entry) => {
                        return { enabled: true, protocol: "http", ...entry };
                    }),
                    userId: OWNER,
                }),
        );

    it("records the server's URL at that moment in the stored destination", async () => {
        await servers({ name: "Files", url: FILES_URL });
        await answerHeader(SECRET);

        const [row] = await secretRows();

        expect(row.use).toStrictEqual(STORED_HEADER_USE);
    });

    it("refuses, rolling the claim back, when the user has no server of that name or more than one", async () => {
        await expect(answerHeader(SECRET)).rejects.toThrow(NO_SERVER);
        expect(await secretRows()).toHaveLength(0);

        await servers({ name: "Files", url: FILES_URL }, { name: "Files", url: "https://dup.example.com/mcp" });
        await expect(save(SECRET, { approvalId: "sec-2" })).rejects.toThrow(AMBIGUOUS_SERVER);
        expect(await secretRows()).toHaveLength(0);
        expect(await statuses()).toStrictEqual(["pending", "pending"]);
    });

    it("refuses a value that could split the header or smuggle another", async () => {
        await servers({ name: "Files", url: FILES_URL });
        await insertMessage(2, { content: "and the files server", role: "user" });
        await insertMessage(3, request("sec-2", "requestSecret", { label: "Files token", use: HEADER_USE }));
        await insertRun("sec-2");

        for (const value of ["tok\r\nX-Evil: 1", "tok\nen", "to\0ken", "a\rb", "tok\u{100}en", "tok\u{1F600}en"]) {
            await expect(save(value, { approvalId: "sec-2" })).rejects.toThrow(BAD_HEADER_VALUE);
        }

        expect(await secretRows()).toHaveLength(0);
        expect(await statuses()).toStrictEqual(["pending", "pending"]);
    });
});

describe("when a run ends", () => {
    it("drops the ciphertext of that reply's saved references and keeps their rows", async () => {
        const ref = await storeSecret(PROVIDER_USE, Date.now(), "stream-A");

        expect(await harness.run(async (ctx: any) => await discardThreadSecrets(ctx, { replyKey: "stream-A", threadId: threadId as never }))).toBe(1);

        const [row] = await secretRows();

        expect(row).toMatchObject({ ref, status: "saved" });
        expect(row.encryptedValue).toBeUndefined();
        expect(await takeProvider(ref)).toMatchObject({ status: "used" });
    });

    it("leaves another reply's references on the same thread alone", async () => {
        const first = await storeSecret(PROVIDER_USE, Date.now(), "stream-A");
        const second = await storeSecret(PROVIDER_USE, Date.now(), "stream-B");

        expect(await harness.run(async (ctx: any) => await discardThreadSecrets(ctx, { replyKey: "stream-A", threadId: threadId as never }))).toBe(1);

        expect(await takeProvider(first)).toMatchObject({ status: "used" });
        expect(await takeProvider(second)).toMatchObject({ status: "saved" });
    });

    it("leaves other threads' references alone, and a second pass finds nothing", async () => {
        await storeSecret(PROVIDER_USE, Date.now(), "stream-A");

        const other = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "O", userId: OWNER }));
        const otherRef = await harness.run(
            async (ctx: any) =>
                await storeRequestedSecret(ctx, {
                    approvalId: "sec-o",
                    label: "L",
                    now: Date.now(),
                    replyKey: "stream-A",
                    threadId: other,
                    use: PROVIDER_USE,
                    userId: OWNER,
                    value: SECRET,
                }),
        );

        await harness.run(async (ctx: any) => await discardThreadSecrets(ctx, { replyKey: "stream-A", threadId: threadId as never }));

        expect(await harness.run(async (ctx: any) => await discardThreadSecrets(ctx, { replyKey: "stream-A", threadId: threadId as never }))).toBe(0);
        expect(await takeProvider(otherRef, { thread: other })).toMatchObject({ status: "saved" });
    });

    it("names a continuation's reply by the key its snapshot carries, and a first run's by its own stream", async () => {
        await insertRun("sec-c", { ...CONFIG, replyKey: "stream-A" }, "stream-C1");

        const keyOf = async (streamId: string) => await harness.run(async (ctx: any) => await replyKeyOfStream(ctx, { streamId, threadId: threadId as never }));

        expect(await keyOf("stream-C1")).toBe("stream-A");
        expect(await keyOf("stream-A")).toBe("stream-A");
        expect(await keyOf("stream-unrelated")).toBe("stream-unrelated");
    });
});

describe("when a thread is deleted", () => {
    it("removes its saved references, ciphertext and rows, and no other thread's", async () => {
        await storeSecret();

        const other = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "O", userId: OWNER }));

        await harness.run(
            async (ctx: any) =>
                await storeRequestedSecret(ctx, {
                    approvalId: "sec-o",
                    label: "L",
                    now: Date.now(),
                    threadId: other,
                    use: PROVIDER_USE,
                    userId: OWNER,
                    value: SECRET,
                }),
        );

        expect(await harness.run(async (ctx: any) => await deleteThreadSecrets(ctx, { threadId: threadId as never }))).toBe(1);
        expect(await secretRows()).toMatchObject([{ threadId: other }]);
    });

    it("goes through the one routine every thread deletion path ends in", async () => {
        await storeSecret();
        await harness.run(async (ctx: any) => await ctx.runMutation(agentThreads.deleteAllForThreadIdAsync, { threadId }));

        expect(await secretRows()).toHaveLength(0);
    });
});

describe("the consumer tools", () => {
    /** A tool ctx whose `runMutation` runs the real consumer against the harness, as the queue would. */
    const toolContext = (overrides: Record<string, unknown> = {}, consume: typeof consumeAsProviderKey = consumeAsProviderKey) => {
        const calls: Record<string, unknown>[] = [];

        return {
            calls,
            context: {
                runMutation: async (_reference: unknown, args: any) => {
                    calls.push(args);

                    return await harness.run(async (ctx: any) => await consume(ctx, { ...args, now: Date.now() }));
                },
                startedBy: OWNER,
                threadId,
                userId: OWNER,
                ...overrides,
            },
        };
    };

    const tools = async () => await import("../tools/use-secret");

    it("pass the run's user, thread and starter with the reference, and nothing else", async () => {
        const { saveSecretAsProviderKeyTool } = await tools();
        const { calls, context } = toolContext();
        const ref = await storeSecret();

        const output = await (saveSecretAsProviderKeyTool as unknown as ToolDefinition).execute(context, { ref }, {});

        expect(output).toStrictEqual({ provider: "openai", status: "saved" });
        expect(calls).toStrictEqual([{ ref, startedBy: OWNER, threadId, userId: OWNER }]);
        expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it("spend a header reference on the named server", async () => {
        const { setMcpServerSecretTool } = await tools();
        const { context } = toolContext({}, consumeAsMcpHeader);

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", { mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }], userId: OWNER }),
        );

        const output = await (setMcpServerSecretTool as unknown as ToolDefinition).execute(context, { ref: await storeSecret(STORED_HEADER_USE) }, {});

        expect(output).toStrictEqual({ header: "Authorization", server: "Files", status: "saved" });
        expect(((await preferences()) as { mcpSecretHeaders?: unknown[] }).mcpSecretHeaders).toHaveLength(1);
    });

    it("fail closed in a turn a collaborator started, even though the continuation runs as the owner", async () => {
        const { saveSecretAsProviderKeyTool } = await tools();
        const ref = await storeSecret();

        // Fresh turn of a write collaborator: the run's user is the collaborator.
        const fresh = toolContext({ startedBy: STRANGER, userId: STRANGER });

        expect(await (saveSecretAsProviderKeyTool as unknown as ToolDefinition).execute(fresh.context, { ref }, {})).toMatchObject({
            error: expect.any(String),
            status: "not_found",
        });

        // Its continuation after the owner answered some other card: the run's user is the owner, the starter is not.
        const continued = toolContext({ startedBy: STRANGER });

        expect(await (saveSecretAsProviderKeyTool as unknown as ToolDefinition).execute(continued.context, { ref }, {})).toMatchObject({ status: "wrong_run" });

        // A run that never said who started it (headless, an old snapshot) is refused the same way.
        const unknown = toolContext({ startedBy: undefined });

        expect(await (saveSecretAsProviderKeyTool as unknown as ToolDefinition).execute(unknown.context, { ref }, {})).toMatchObject({ status: "wrong_run" });
        expect(await preferences()).toBeNull();
        expect(await secretRows()).toHaveLength(1);
        const kept = await secretRows();

        expect(kept.map((row: { encryptedValue?: string }) => row.encryptedValue)).not.toContain(undefined);
    });

    it("refuse a context with no user or thread without touching the reference", async () => {
        const { setMcpServerSecretTool } = await tools();
        const { calls, context } = toolContext({ threadId: undefined });

        expect(await (setMcpServerSecretTool as unknown as ToolDefinition).execute(context, { ref: "sec_x" }, {})).toMatchObject({ status: "failed" });
        expect(calls).toHaveLength(0);
    });
});

describe("the header secrets of one server, for a connection test", () => {
    it("come back decrypted for that server only, and only at the address they were approved for", async () => {
        const { getMcpSecretHeadersQuery } = await import("../../auth/functions");

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("aiUserPreferences", {
                    mcpServers: [{ enabled: true, name: "Files", protocol: "http", url: FILES_URL }],
                    userId: OWNER,
                }),
        );
        await takeHeader(await storeSecret(STORED_HEADER_USE));

        const read = async (name: string, url: string) =>
            await harness.query(async (ctx: any) => await ctx.runQuery(getMcpSecretHeadersQuery, { name, url, userId: OWNER }));

        expect(await read("Files", FILES_URL)).toStrictEqual([{ key: "Authorization", value: SECRET }]);
        expect(await read("Files", "https://evil.example.com/mcp")).toStrictEqual([]);
        expect(await read("Other", FILES_URL)).toStrictEqual([]);
    });
});
