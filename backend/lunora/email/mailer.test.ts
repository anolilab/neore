/**
 * Mail is rendered at the call site and delivered from the jobs queue, so an
 * auth callback only pays for the render and a provider failure is retried by
 * the queue. This pins the hand-off: what `deliverEmail` receives is a complete,
 * pre-rendered message (a React element cannot cross the queue).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env, jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { sendMagicLink } from "./functions";
import { deliversMail, mailer } from "./mailer";

vi.mock("cloudflare:email", () => {
    return {
        EmailMessage: class {
            public constructor(
                public readonly from: string,
                public readonly to: string,
                public readonly raw: string,
            ) {}
        },
    };
});

beforeEach(() => {
    jobsQueueMessages.length = 0;
});

afterEach(() => {
    delete env.EMAIL;
});

describe("queued mail", () => {
    it("enqueues deliverEmail with the rendered message", async () => {
        await sendMagicLink({ to: "user@example.com", url: "https://app.test/magic/m1" });

        expect(jobsQueueMessages).toHaveLength(1);

        const body = jobsQueueMessages[0]?.body;

        expect(body?.functionPath).toBe("email_functions:deliverEmail");
        expect(body?.args).toMatchObject({
            message: {
                from: "Neore <noreply@neore.test>",
                html: expect.stringContaining('href="https://app.test/magic/m1"'),
                idempotencyKey: expect.any(String),
                subject: "Sign in to your account",
                text: expect.stringContaining("https://app.test/magic/m1"),
                to: "user@example.com",
            },
        });
        expect(body?.args?.["message"]).not.toHaveProperty("react");
    });
});

describe(deliversMail, () => {
    const stubEnv = env as typeof env & { LUNORA_MAIL_CAPTURE?: string };

    afterEach(() => {
        delete stubEnv.LUNORA_MAIL_CAPTURE;
    });

    it("is true with the EMAIL binding (Cloudflare Email Service)", () => {
        stubEnv.EMAIL = { send: vi.fn() };
        expect(deliversMail()).toBe(true);
    });

    it("is false without a sender, even with the binding", () => {
        const sender = stubEnv.MAIL_FROM;

        stubEnv.EMAIL = { send: vi.fn() };
        stubEnv.MAIL_FROM = " ";
        expect(deliversMail()).toBe(false);
        stubEnv.MAIL_FROM = sender;
    });

    it("is false without the binding, and while mail is captured", () => {
        expect(deliversMail()).toBe(false);

        stubEnv.EMAIL = { send: vi.fn() };
        stubEnv.LUNORA_MAIL_CAPTURE = "1";
        expect(deliversMail()).toBe(false);
    });
});

describe("a leftover Resend key", () => {
    it("never sends through Resend: without the EMAIL binding nothing delivers", async () => {
        vi.resetModules();

        const stub = (await import("cloudflare:workers")) as unknown as { env: Record<string, unknown> };
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        stub.env.RESEND_API_KEY = "re_leftover";

        try {
            const fresh = await import("./mailer");

            await expect(fresh.mailer().send({ html: "<p>hi</p>", subject: "Hi", to: "user@example.com" })).rejects.toThrow();
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(fresh.deliversMail()).toBe(false);
        } finally {
            delete stub.env.RESEND_API_KEY;
            fetchSpy.mockRestore();
        }
    });
});

describe("the EMAIL binding", () => {
    it("delivers through Cloudflare Email Service, not Resend, when it is bound", async () => {
        const send = vi.fn(async () => undefined);

        env.EMAIL = { send };

        await mailer().send({ html: "<p>hi</p>", subject: "Hi", to: "user@example.com" });

        expect(send).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "noreply@neore.test", to: "user@example.com" }));
    });
});
