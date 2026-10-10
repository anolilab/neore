import { consumeQueuedSend } from "@lunora/mail";
import { LunoraError, v } from "lunorash/server";
import { createElement } from "react";

import { internalAction, internalMutation } from "../_generated/server";
import { ENVIRONMENT } from "../env";
import { emailLogger } from "../lib/logger";
import { mailer, queueEmail } from "./mailer";

export const insertExpectation = internalMutation
    .input({
        email: v.string(),
        expectation: v.union(v.literal("delivered"), v.literal("bounced"), v.literal("complained")),
    })
    .output(v.null())
    .mutation(async ({ args: arguments_, ctx: context }) => {
        await context.db.insert("emails", {
            email: arguments_.email,
            expectation: arguments_.expectation,
        });

        return null;
    });

export const handleEmailEvent = internalMutation
    // Was `vOnEmailEventArgsFields`, exported by the Resend component. The component
    // is gone, so the shape is declared here; `webhook.ts` is the only caller.
    .input({
        event: v.object({ type: v.string() }),
        id: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: arguments_, ctx: context }) => {
        const emailId = arguments_.id as string;
        const email = await context.db.emails.findUnique({ where: { email: emailId } });

        if (!email) {
            if (ENVIRONMENT === "development") {
                emailLogger.debug("No test email found for id", emailId);
            }

            return null;
        }

        const eventType = arguments_.event.type;

        if (eventType === "email.delivered") {
            if (email.expectation === "bounced") {
                throw new LunoraError("INTERNAL", "Email was delivered but expected to be bounced");
            }

            if (email.expectation === "complained") {
                if (ENVIRONMENT === "development") {
                    emailLogger.debug("Complained email was delivered, expecting complaint coming...");
                }

                return null;
            }

            await context.db.delete(email._id);
        }

        if (eventType === "email.bounced") {
            if (email.expectation !== "bounced") {
                throw new LunoraError("INTERNAL", `Email was bounced but expected to be ${email.expectation}`);
            }

            await context.db.delete(email._id);
        } else if (eventType === "email.complained") {
            if (email.expectation !== "complained") {
                throw new LunoraError("INTERNAL", `Email was complained but expected to be ${email.expectation}`);
            }

            await context.db.delete(email._id);
        }

        return null;
    });

/**
 * The queue half of `mailer().queue()` (`./mailer.ts`): sends one rendered
 * message. `consumeQueuedSend` re-checks the body's shape, which is why it is
 * `v.any()` here. A throw fails the job, so the jobs queue retries it and then
 * dead-letters it.
 */
export const deliverEmail = internalAction
    .input({ message: v.any() })
    .output(v.null())
    .action(async ({ args: { message } }) => {
        await consumeQueuedSend(mailer(), message);

        return null;
    });

export const sendEmailVerification = async ({ to, url }: { to: string; url: string }) => {
    const { default: VerifyEmail } = await import("./templates/verify-email");

    await queueEmail({ react: createElement(VerifyEmail, { url }), subject: "Verify your email address", to });
};

export const sendOTPVerification = async ({ code, to }: { code: string; to: string }) => {
    const { default: VerifyOTP } = await import("./templates/verify-otp");

    await queueEmail({ react: createElement(VerifyOTP, { code }), subject: "Verify your email address", to });
};

export const sendMagicLink = async ({ to, url }: { to: string; url: string }) => {
    const { default: MagicLinkEmail } = await import("./templates/magic-link");

    await queueEmail({ react: createElement(MagicLinkEmail, { url }), subject: "Sign in to your account", to });
};

export const sendResetPassword = async ({ to, url }: { to: string; url: string }) => {
    const { default: ResetPasswordEmail } = await import("./templates/reset-password");

    await queueEmail({ react: createElement(ResetPasswordEmail, { url }), subject: "Reset your password", to });
};

export const sendOrganizationInvite = async ({
    acceptUrl,
    invitationId,
    inviterEmail,
    inviterName,
    organizationName,
    role,
    to,
}: {
    acceptUrl: string;
    invitationId: string;
    inviterEmail: string;
    inviterName: string;
    organizationName: string;
    role: string;
    to: string;
}) => {
    const { default: OrganizationInviteEmail } = await import("./templates/organization-invite");

    await queueEmail({
        react: createElement(OrganizationInviteEmail, {
            acceptUrl,
            invitationId,
            inviterEmail,
            inviterName,
            organizationName,
            role,
            to,
        }),
        subject: `${inviterName} invited you to join ${organizationName}`,
        to,
    });
};
