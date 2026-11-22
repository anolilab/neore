/**
 * The saved-login fill: it signs in only in a turn the verdict allows, only on the login's own site, only while no person
 * drives the browser, and the password reaches the renderer alone: never the tool's result, the model's output, a log
 * line, the action history or the session row, whatever the page sends back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../../test/registered-api";

// `lib/encryption` reads the key when it loads.
const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { registry, renderer } = vi.hoisted(() => {
    return { registry: new Map<string, unknown>(), renderer: vi.fn() };
});

vi.mock("../../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../../lib/shard-context", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../../lib/shard-context")>()), servesUser: () => true };
});

vi.mock("../../lib/services", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../../lib/services")>()), isServiceBound: () => true, serviceFetch: () => fetch };
});

vi.mock("@neore/service-sdk/browser-renderer", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("@neore/service-sdk/browser-renderer")>()), browserLogin: renderer };
});

const { default: schema } = await import("../../schema");
const { encryptKey } = await import("../../lib/encryption");
const { DEFAULT_CHAT_MODEL } = await import("@neore/ai/constants");
const { NO_USABLE_LOGIN, PASSWORD_TOO_SHORT, PASSWORD_UNREADABLE, SCRIPT_SIGN_IN, SIGN_IN_RETIRED, WITHHELD_FIELD, withoutLogin, withoutPassword } =
    await import("./site-login-node");
const { applyLimit } = await import("../../lib/rate-limiter-mutations");
const { PERSON_HAS_CONTROL } = await import("./browser-node");
const { default: signInWithSavedLoginTool } = await import("./site-login");
const { applyToolPermissions, BUILTIN_TOOLS_NEEDING_A_PERSON } = await import("../lib/tool-permissions");

const OWNER = "user-owner";
const SITE = "https://example.com";
const LOGIN_PAGE = `${SITE}/login`;
const USERNAME = "ada@example.com";
// Random, so a match anywhere can only be a leak; with a space and a `&`, so its address and form encodings differ.
const PASSWORD = `pw ${crypto.randomUUID()}&x`;
const CALL_ID = "call-fill-1";

let harness: ReturnType<typeof lunoraTest>;
let threadId = "";
let promptId = "";

const insert = async (table: string, row: Record<string, unknown>) => (await harness.run(async (ctx: any) => await ctx.db.insert(table, row))) as string;
const all = async (table: string) => (await harness.run(async (ctx: any) => await ctx.db.query(table).collect())) as Record<string, unknown>[];

/** The lead model's reply that asked to sign in: its tool call and the call's approval request (`tool-approval.ts` reads both). */
const insertApprovalRow = async (callId = CALL_ID, extra: Record<string, unknown>[] = [], stepOrder = 2) =>
    await insert("messages", {
        agentName: DEFAULT_CHAT_MODEL,
        message: {
            content: [
                { input: { site: SITE }, toolCallId: callId, toolName: "signInWithSavedLogin", type: "tool-call" },
                { approvalId: `approval-${callId}`, toolCallId: callId, type: "tool-approval-request" },
                ...extra,
            ],
            role: "assistant",
        },
        order: 0,
        status: "success",
        stepOrder,
        threadId,
        tool: true,
        userId: OWNER,
    });

/** The lead model's own text replies in the turn, at the given steps: rows a sign-in's path may hold. */
const insertReplies = async (steps: number[]) => {
    for (const stepOrder of steps) {
        await insert("messages", {
            agentName: DEFAULT_CHAT_MODEL,
            message: { content: [{ text: `Step ${stepOrder}`, type: "text" }], role: "assistant" },
            order: 0,
            status: "success",
            stepOrder,
            threadId,
            tool: false,
            userId: OWNER,
        });
    }
};

interface Call {
    context?: Record<string, unknown>;
    messages?: Record<string, unknown>[];
    /** The site the model names. */
    site?: string;
    toolCallId?: string;
}

/** Runs the tool as an approved call does (no messages), unless a test says otherwise; returns its result and model output. */
const signIn = async ({ context = {}, messages = [], site = SITE, toolCallId = CALL_ID }: Call = {}) =>
    (await harness.action(async (ctx: any) => {
        const toolCtx = {
            ...ctx,
            dispatchOrigin: "lead",
            headless: false,
            runToolSources: ["builtin", "builtin"],
            runTurn: { impersonated: false, promptMessageId: promptId, systemContext: ["instructions"] },
            startedBy: OWNER,
            threadId,
            userId: OWNER,
            ...context,
        };
        const tool = { ...signInWithSavedLoginTool, ctx: toolCtx } as any;
        const output = await tool.execute({ site }, { context: {}, messages, toolCallId });
        const modelOutput = await tool.toModelOutput({ input: { site }, output, toolCallId });

        return { modelOutput, output };
    })) as { modelOutput: unknown; output: { error?: string; site?: string; success: boolean; url?: string } };

const answered = (data: Record<string, unknown>) => {
    return { data, error: undefined, response: { ok: true, status: 200 } };
};

const logged: string[] = [];

beforeAll(async () => {
    registerModule(registry, "browser_functions", await import("../../browser/functions"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../../lib/rate-limiter-mutations"));
    registerModule(registry, "vault_site_logins", await import("../../vault/site-logins"));
    registerModule(registry, "chat_tools_site_login_node", await import("./site-login-node"));
}, 30_000);

beforeEach(async () => {
    logged.length = 0;

    for (const level of ["debug", "error", "info", "log", "warn"] as const) {
        vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
            logged.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
        });
    }

    harness = lunoraTest(schema as never);
    threadId = await insert("threads", { tags: ["chat"], title: "Mine", userId: OWNER });
    promptId = await insert("messages", {
        message: { content: [{ text: "Sign in to example.com and check my order", type: "text" }], role: "user" },
        order: 0,
        status: "success",
        stepOrder: 0,
        threadId,
        tool: false,
        userId: OWNER,
    });
    await insert("savedSiteLogins", {
        createdAt: 1,
        encryptedPassword: await encryptKey(PASSWORD, "site-logins"),
        origin: SITE,
        signInUrl: LOGIN_PAGE,
        updatedAt: 1,
        userId: OWNER,
        username: USERNAME,
    });
    renderer.mockResolvedValue(
        answered({
            passwordFieldRemains: false,
            sessionId: "s-1",
            submitted: true,
            success: true,
            title: `Welcome back — ${PASSWORD}`,
            url: `${SITE}/account?p=${encodeURIComponent(PASSWORD)}&q=${new URLSearchParams({ p: PASSWORD }).toString().slice(2)}`,
        }),
    );
});

afterEach(() => {
    vi.restoreAllMocks();
    renderer.mockReset();
    harness.close();
});

/** Nothing the model, the logs or the stored rows hold carries the password or the username. */
const expectNoSecret = async (result: unknown) => {
    const stored = JSON.stringify([await all("browserActions"), await all("browserSessions")]);

    for (const text of [JSON.stringify(result), stored, logged.join("\n")]) {
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(encodeURIComponent(PASSWORD));
        expect(text).not.toContain(USERNAME);
    }
};

describe("an approved sign-in in the owner's own turn", () => {
    it("types the saved login on its own site in one renderer call, and nothing read back carries the password", async () => {
        await insertApprovalRow();

        const result = await signIn();

        expect(renderer).toHaveBeenCalledTimes(1);
        expect(renderer.mock.lastCall?.[0].body).toMatchObject({
            budgetMs: expect.any(Number),
            origin: SITE,
            password: PASSWORD,
            url: LOGIN_PAGE,
            username: USERNAME,
        });
        // An address that names the login is withheld whole: scrubbed, it would be a page that does not exist.
        expect(result.output).toMatchObject({ site: SITE, submitted: true, success: true, url: WITHHELD_FIELD });
        await expectNoSecret(result);

        // The history names the site only.
        const [action] = await all("browserActions");

        expect(action).toMatchObject({ action: "login", success: 1, target: SITE });
        expect(action?.["value"]).toBeUndefined();
    });

    it("keeps the saved username out of what the site sends back, and withholds a title that spells the password in escapes", async () => {
        await insertApprovalRow();
        renderer.mockResolvedValue(
            answered({
                error: `Signed in as ${USERNAME}`,
                sessionId: "s-1",
                submitted: true,
                success: true,
                title: [...PASSWORD].map((character) => String.raw`\u` + (character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")).join(""),
                url: `${SITE}/account?user=${encodeURIComponent(USERNAME)}`,
            }),
        );

        const result = await signIn();

        expect(result.output).toMatchObject({ error: "Signed in as [username]", title: WITHHELD_FIELD, url: WITHHELD_FIELD });
        await expectNoSecret(result);
    });

    it("scrubs a common username only where it stands alone, and withholds an address that names it", async () => {
        await insertApprovalRow();
        await harness.run(async (ctx: any) => {
            const [login] = await ctx.db.query("savedSiteLogins").collect();

            await ctx.db.patch("savedSiteLogins", login._id, { username: "admin" });
        });
        renderer.mockResolvedValue(
            answered({ sessionId: "s-1", submitted: true, success: true, title: "Welcome admin, to the administrator panel", url: `${SITE}/admin/home` }),
        );

        const result = await signIn();

        expect(result.output).toMatchObject({ title: "Welcome [username], to the administrator panel", url: WITHHELD_FIELD });
        // The thread's browser row keeps no address that does not exist.
        const [row] = await all("browserSessions");

        expect(row?.["currentUrl"]).not.toBe(WITHHELD_FIELD);
        expect(String(row?.["currentUrl"])).not.toContain("[username]");
    });

    it("scrubs the password from a renderer failure too", async () => {
        await insertApprovalRow();
        renderer.mockResolvedValue({ data: undefined, error: { error: `fill failed near ${PASSWORD}`, success: false }, response: { ok: false, status: 500 } });

        const result = await signIn();

        expect(result.output.success).toBe(false);
        expect(result.output.error).toContain("[password]");
        await expectNoSecret(result);
    });

    it("never types while a person drives the browser, and says so", async () => {
        await insertApprovalRow();
        await insert("browserSessions", {
            connectUrl: "service:browserRenderer",
            control: { by: OWNER, claim: "c-1", since: Date.now(), until: Date.now() + 60_000 },
            lastActivityAt: Date.now(),
            providerSessionId: "s-1",
            source: "browserbase",
            startedAt: Date.now(),
            status: "active",
            threadId,
            userId: OWNER,
        });

        const result = await signIn();

        expect(result.output).toMatchObject({ error: PERSON_HAS_CONTROL, success: false });
        expect(renderer).not.toHaveBeenCalled();
    });
});

describe("an approved call in a long turn", () => {
    const steps = (from: number, count: number): number[] => Array.from({ length: count }, (_, at) => from + at);

    it.each([
        [
            "its request sits below more than a page of newer rows",
            async () => {
                await insertApprovalRow(CALL_ID, [], 1);
                await insertReplies(steps(2, 150));
            },
        ],
        [
            "more than a page of rows lies between the prompt and its request",
            async () => {
                await insertReplies(steps(1, 150));
                await insertApprovalRow(CALL_ID, [], 151);
            },
        ],
    ])("still signs in when %s", async (_why, setup) => {
        await setup();

        const result = await signIn();

        expect(result.output).toMatchObject({ success: true });
        expect(renderer).toHaveBeenCalledOnce();
    });
});

describe("the page the sign-in opens", () => {
    it("is the sign-in page saved with the login, whatever page of the site the model names", async () => {
        await insertApprovalRow();

        await signIn({ site: `${SITE}/forum/post/42` });

        expect(renderer.mock.lastCall?.[0].body).toMatchObject({ origin: SITE, url: LOGIN_PAGE });
    });

    it("is the site's front page when the login saved none", async () => {
        await insertApprovalRow();
        await harness.run(async (ctx: any) => {
            const [login] = await ctx.db.query("savedSiteLogins").collect();

            await ctx.db.delete("savedSiteLogins", login._id);
            await ctx.db.insert("savedSiteLogins", {
                createdAt: login.createdAt,
                encryptedPassword: login.encryptedPassword,
                origin: login.origin,
                updatedAt: login.updatedAt,
                userId: login.userId,
                username: login.username,
            });
        });

        await signIn();

        expect(renderer.mock.lastCall?.[0].body).toMatchObject({ url: `${SITE}/` });
    });
});

describe("what the renderer answers", () => {
    /** The browser session row of the thread, holding browser `s-1`. */
    const withBrowser = async () =>
        await insert("browserSessions", {
            connectUrl: "service:browserRenderer",
            lastActivityAt: Date.now(),
            providerSessionId: "s-1",
            source: "browserbase",
            startedAt: Date.now(),
            status: "active",
            threadId,
            userId: OWNER,
        });
    const session = async () => {
        const [row] = await all("browserSessions");

        return row as { inUseHolds?: number[]; providerSessionId?: string };
    };

    it("runs the sign-in once on a new browser when the renderer retired the thread's one", async () => {
        await insertApprovalRow();
        await withBrowser();
        renderer.mockResolvedValueOnce({
            data: undefined,
            error: { code: "SESSION_RETIRED", error: "retired", success: false },
            response: { ok: false, status: 410 },
        });
        renderer.mockResolvedValueOnce(answered({ sessionId: "s-2", submitted: true, success: true, url: `${SITE}/account` }));

        const result = await signIn();

        expect(renderer.mock.calls.map(([options]) => (options as { body: { sessionId?: string } }).body.sessionId)).toStrictEqual(["s-1", undefined]);
        expect(result.output).toMatchObject({ success: true });
        await expect(session()).resolves.toMatchObject({ providerSessionId: "s-2" });
    });

    it.each([
        ["another call holds the session", 409, "busy with another call"],
        ["the session's lock does not answer", 503, "lock did not answer"],
    ])("types nothing, ends the hold and gives the charge back when %s", async (_why, status, words) => {
        await insertApprovalRow();
        await withBrowser();
        renderer.mockResolvedValueOnce({
            data: undefined,
            error: { error: `The browser session's ${words}`, success: false },
            response: { ok: false, status },
        });

        // The hour's 20 spent, this sign-in's unit with them: only a refund leaves one.
        await harness.run(async (ctx: any) => await applyLimit(ctx, { count: 19, identifier: OWNER, key: "browser/action:free" }));

        const result = await signIn();

        expect(result.output).toMatchObject({ error: expect.stringContaining(words), success: false });
        expect(await session()).not.toHaveProperty("inUseHolds");
        await expect(session()).resolves.toMatchObject({ providerSessionId: "s-1" });
        await expect(harness.run(async (ctx: any) => await applyLimit(ctx, { identifier: OWNER, key: "browser/action:free" }))).resolves.toMatchObject({
            ok: true,
        });
    });

    it("drops a session the renderer says is gone, and runs no second sign-in when too little time is left after a retirement", async () => {
        await insertApprovalRow();
        await withBrowser();
        vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
        renderer.mockImplementationOnce(async () => {
            // The retirement answers only once most of the hold is spent: under 20 s of it is left for a second call.
            vi.setSystemTime(Date.now() + 55_000);

            return { data: undefined, error: { code: "SESSION_RETIRED", error: "retired", success: false }, response: { ok: false, status: 410 } };
        });

        let result: Awaited<ReturnType<typeof signIn>>;

        try {
            result = await signIn();
        } finally {
            vi.useRealTimers();
        }

        expect(renderer).toHaveBeenCalledTimes(1);
        expect(result.output).toMatchObject({ error: SIGN_IN_RETIRED, success: false });
        await expect(session()).resolves.toMatchObject({ providerSessionId: "cf-browser-rendering" });
        expect(await session()).not.toHaveProperty("inUseHolds");
    });

    it("says a site that signs in from a script is a refusal, not a wrong password", async () => {
        await insertApprovalRow();
        renderer.mockResolvedValueOnce(answered({ error: "The page sends its own sign-in", scriptSignIn: true, submitted: false, success: false }));

        const result = await signIn();

        expect(result.output).toMatchObject({ error: SCRIPT_SIGN_IN, success: false });
    });

    it("never reuses a session whose close the renderer could not confirm", async () => {
        await insertApprovalRow();
        await withBrowser();
        renderer.mockResolvedValueOnce(
            answered({ error: "The password could not be cleared from the page", sessionCloseUnconfirmed: true, submitted: true, success: false }),
        );

        const result = await signIn();

        expect(result.output.error).toContain("will not be used again");
        await expect(session()).resolves.toMatchObject({ providerSessionId: "cf-browser-rendering" });
    });

    it("types nothing, and gives the charge back, when the saved password cannot be decrypted", async () => {
        await insertApprovalRow();
        await withBrowser();
        await harness.run(async (ctx: any) => {
            const [login] = await ctx.db.query("savedSiteLogins").collect();

            // Random text, not a ciphertext of this key: decrypting it fails.
            await ctx.db.patch("savedSiteLogins", login._id, { encryptedPassword: crypto.randomUUID() });
        });
        // The hour's 20 spent, this sign-in's unit with them: only a refund leaves one.
        await harness.run(async (ctx: any) => await applyLimit(ctx, { count: 19, identifier: OWNER, key: "browser/action:free" }));

        const result = await signIn();

        expect(result.output).toMatchObject({ error: PASSWORD_UNREADABLE, success: false });
        expect(renderer).not.toHaveBeenCalled();
        expect(await session()).not.toHaveProperty("inUseHolds");
        await expect(harness.run(async (ctx: any) => await applyLimit(ctx, { identifier: OWNER, key: "browser/action:free" }))).resolves.toMatchObject({
            ok: true,
        });
    });

    it("types nothing, keeps the thread's browser and gives the charge back when the browser did not start in time", async () => {
        await insertApprovalRow();
        await withBrowser();
        renderer.mockResolvedValueOnce({
            data: undefined,
            error: { error: "The browser did not start in time, so nothing was typed. Try it again.", success: false },
            response: { ok: false, status: 504 },
        });
        // The hour's 20 spent, this sign-in's unit with them: only a refund leaves one.
        await harness.run(async (ctx: any) => await applyLimit(ctx, { count: 19, identifier: OWNER, key: "browser/action:free" }));

        const result = await signIn();

        expect(result.output).toMatchObject({ error: expect.stringContaining("did not start in time"), success: false });
        await expect(session()).resolves.toMatchObject({ providerSessionId: "s-1" });
        expect(await session()).not.toHaveProperty("inUseHolds");
        await expect(harness.run(async (ctx: any) => await applyLimit(ctx, { identifier: OWNER, key: "browser/action:free" }))).resolves.toMatchObject({
            ok: true,
        });
    });

    it("types no saved password shorter than the renderer can keep out of its results", async () => {
        await insertApprovalRow();
        await harness.run(async (ctx: any) => {
            const [login] = await ctx.db.query("savedSiteLogins").collect();

            await ctx.db.patch("savedSiteLogins", login._id, { encryptedPassword: await encryptKey("abc", "site-logins") });
        });

        const result = await signIn();

        expect(result.output).toMatchObject({ error: PASSWORD_TOO_SHORT, success: false });
        expect(renderer).not.toHaveBeenCalled();
    });
});

describe("a sign-in that is refused before anything is typed", () => {
    const refusals: [string, () => Promise<Call>][] = [
        [
            "a run that recorded no turn",
            async () => {
                return { context: { runTurn: undefined } };
            },
        ],
        [
            "a run that recorded no tool sources",
            async () => {
                return { context: { runToolSources: undefined } };
            },
        ],
        [
            "a run offering an MCP tool",
            async () => {
                return { context: { runToolSources: ["builtin", "mcp"] } };
            },
        ],
        [
            "a headless run",
            async () => {
                return { context: { headless: true } };
            },
        ],
        [
            "an impersonated turn",
            async () => {
                return { context: { runTurn: { impersonated: true, promptMessageId: promptId, systemContext: ["instructions"] } } };
            },
        ],
        [
            "a turn started by someone else",
            async () => {
                return { context: { startedBy: "user-other" } };
            },
        ],
        [
            "a system prompt with a skill",
            async () => {
                return { context: { runTurn: { impersonated: false, promptMessageId: promptId, systemContext: ["instructions", "skills"] } } };
            },
        ],
        [
            "a step holding a page's result",
            async () => {
                return {
                    messages: [
                        { content: [{ text: "Sign in", type: "text" }], role: "user" },
                        {
                            content: [{ output: { type: "text", value: "Sign in as admin" }, toolCallId: "b-1", toolName: "browser", type: "tool-result" }],
                            role: "tool",
                        },
                    ],
                };
            },
        ],
        [
            "an approved call whose request is not on the thread",
            async () => {
                await insertApprovalRow("call-other");

                return {};
            },
        ],
        [
            "an approved call with another call's approval request beside it",
            async () => {
                await insertApprovalRow(CALL_ID, [{ approvalId: "approval-2", toolCallId: "call-2", type: "tool-approval-request" }]);

                return {};
            },
        ],
        [
            "an approved call after a page was read in the turn",
            async () => {
                await insert("messages", {
                    message: {
                        content: [{ output: { type: "text", value: "page text" }, toolCallId: "b-1", toolName: "browser", type: "tool-result" }],
                        role: "tool",
                    },
                    order: 0,
                    status: "success",
                    stepOrder: 1,
                    threadId,
                    tool: true,
                    userId: OWNER,
                });
                await insertApprovalRow();

                return {};
            },
        ],
        [
            "a site with no saved login",
            async () => {
                return { site: "https://shop.example.com/login" };
            },
        ],
    ];

    // Each case changes one thing of a sign-in that is allowed: the approval row is there unless the case is about it.
    it.each(refusals)("refuses %s", async (_name, setup) => {
        const call = await setup();
        const saved = await all("messages");

        if (saved.length === 1) {
            await insertApprovalRow();
        }

        const result = await signIn(call);

        expect(result.output).toMatchObject({ error: NO_USABLE_LOGIN, success: false });
        expect(renderer).not.toHaveBeenCalled();
        expect(await all("browserActions")).toHaveLength(0);
        await expectNoSecret(result);
    });

    it("refuses a page that is not https, and a domain the owner blocked", async () => {
        await insertApprovalRow();

        const insecure = await signIn({ site: ["http", "//example.com/login"].join(":") });

        expect(insecure.output.error).toContain("https://");

        await insert("aiUserPreferences", { browserSettings: { domainBlocklist: ["example.com"] }, userId: OWNER });
        const blocked = await signIn();

        expect(blocked.output.success).toBe(false);
        expect(blocked.output.error).toContain("example.com");
        expect(renderer).not.toHaveBeenCalled();
    });
});

describe("the approval", () => {
    it("is asked for every sign-in, whatever the person's overrides, and a headless run never has the tool", () => {
        const tools = { signInWithSavedLogin: signInWithSavedLoginTool } as never;

        expect(BUILTIN_TOOLS_NEEDING_A_PERSON.has("signInWithSavedLogin")).toBe(true);
        expect(applyToolPermissions(tools, () => undefined, null).requiresApproval).toStrictEqual(["signInWithSavedLogin"]);

        const allowed = applyToolPermissions(tools, () => undefined, { "builtin:signInWithSavedLogin": "auto" }).tools;

        expect((allowed["signInWithSavedLogin"] as { needsApproval?: unknown } | undefined)?.needsApproval).toBeTypeOf("function");
        expect(
            (allowed["signInWithSavedLogin"] as unknown as { needsApproval: (input: unknown, options: unknown) => unknown }).needsApproval.call(
                allowed["signInWithSavedLogin"],
                { site: SITE },
                { messages: [], toolCallId: CALL_ID },
            ),
        ).toBe(true);
        expect(applyToolPermissions(tools, () => undefined, null, { headless: true }).removed).toStrictEqual(["signInWithSavedLogin"]);
    });
});

describe("withoutPassword", () => {
    it("replaces the password as typed, in an address and in a form body", () => {
        const password = `${PASSWORD}!'()~`;
        const text = `${password} ${encodeURIComponent(password)} ${new URLSearchParams({ p: password }).toString().slice(2)}`;

        expect(withoutPassword(text, password)).toBe("[password] [password] [password]");
    });
});

describe("withoutLogin", () => {
    /** `text` with every character written as a JS `\\uXXXX` escape. */
    const escapedAll = (text: string): string =>
        [...text].map((character) => String.raw`\u` + (character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")).join("");

    it("replaces the username too, as typed and URI-encoded in either case", () => {
        const lower = encodeURIComponent(USERNAME).replaceAll(/%[\dA-F]{2}/g, (escape) => escape.toLowerCase());

        expect(withoutLogin(`Hi ${USERNAME} (${lower})`, { password: PASSWORD, username: USERNAME })).toBe("Hi [username] ([username])");
    });

    it.each([
        ["the password", PASSWORD],
        ["the username", USERNAME],
    ])("withholds a field that spells %s in escapes, whole", (_what, secret) => {
        expect(withoutLogin(`Welcome back, ${escapedAll(secret)}`, { password: PASSWORD, username: USERNAME })).toBe(WITHHELD_FIELD);
        expect(
            withoutLogin(`Signed in &#x2014; ${[...secret].map((character) => `&#${character.codePointAt(0)};`).join("")}`, {
                password: PASSWORD,
                username: USERNAME,
            }),
        ).toBe(WITHHELD_FIELD);
    });

    it("withholds a field that names the username behind more layers of percent-encoding", () => {
        const twice = [...encodeURIComponent(USERNAME)].map((character) => `%25${character.codePointAt(0)?.toString(16)}`).join("");

        expect(withoutLogin(`${SITE}/welcome?u=${twice}`, { password: PASSWORD, username: USERNAME })).toBe(WITHHELD_FIELD);
    });

    it("withholds a field that names a username too short to replace, and leaves one that does not", () => {
        expect(withoutLogin("Signed in as jo", { password: PASSWORD, username: "jo" })).toBe(WITHHELD_FIELD);
        expect(withoutLogin("Join the journey", { password: PASSWORD, username: "jo" })).toBe("Join the journey");
    });

    it("leaves a field with escapes that spell neither as it is", () => {
        expect(withoutLogin(String.raw`Caf\u00e9 &#233;`, { password: PASSWORD, username: USERNAME })).toBe(String.raw`Caf\u00e9 &#233;`);
    });
});

describe("the tool sources a run records", () => {
    it("counts the snapshot's tools on a continuation, fails closed without one, and reads a key with no source as unknown", async () => {
        const { setRunToolSources } = await import("../lib/agent-run");
        const ctx: { runToolSources?: ReadonlyArray<string> } = {};

        // The step that made the call offered an MCP tool; the rebuilt run no longer does: it still counts.
        setRunToolSources(ctx, { lookup: "mcp:server:lookup" }, { signInWithSavedLogin: "builtin:signInWithSavedLogin" });
        expect(ctx.runToolSources).toStrictEqual(["mcp", "builtin"]);

        setRunToolSources(ctx, undefined, { signInWithSavedLogin: "builtin:signInWithSavedLogin" });
        expect(ctx.runToolSources).toBeUndefined();

        setRunToolSources(ctx, { odd: "nocolon" });
        expect(ctx.runToolSources).toStrictEqual(["unknown"]);
    });
});
