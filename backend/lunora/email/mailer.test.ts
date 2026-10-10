/**
 * Mail is rendered at the call site and delivered from the jobs queue, so an
 * auth callback only pays for the render and a provider failure is retried by
 * the queue. This pins the hand-off: what `deliverEmail` receives is a complete,
 * pre-rendered message (a React element cannot cross the queue).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env, jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { sendMagicLink } from "./functions";
import { mailer } from "./mailer";

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

describe("the EMAIL binding", () => {
    it("delivers through Cloudflare Email Service, not Resend, when it is bound", async () => {
        const send = vi.fn(async () => undefined);

        env.EMAIL = { send };

        await mailer().send({ html: "<p>hi</p>", subject: "Hi", to: "user@example.com" });

        expect(send).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "noreply@neore.test", to: "user@example.com" }));
    });
});
