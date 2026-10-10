import { v } from "lunorash/server";

import { internalAction } from "../../_generated/server";
import { queueEmail } from "../../email/mailer";

export const sendDeletionConfirmedEmailAction = internalAction
    .input({ userEmail: v.string() })
    .output(v.null())
    .action(async ({ args: { userEmail } }) => {
        const { default: AccountDeletionConfirmedEmail } = await import("../../email/templates/account-deletion-confirmed");

        await queueEmail({ react: AccountDeletionConfirmedEmail(), subject: "Your account has been deleted", to: userEmail });

        // Declared `.output(v.null())`; return it rather than falling off the
        // end, which yields `undefined` and does not match the contract.
        return null;
    });

export default sendDeletionConfirmedEmailAction;
