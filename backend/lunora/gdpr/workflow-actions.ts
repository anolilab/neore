import { v } from "lunorash/server";

import { internalAction } from "../_generated/server";
import { withDependency } from "../lib/dependency";

export const startExportWorkflow = internalAction
    .input({
        requestId: v.id("gdprRequests"),
        userEmail: v.string(),
        userId: v.string(),
    })
    .action(async ({ args, ctx: context }) => {
        // `create` starts a durable instance and resolves once it is ACCEPTED, not
        // once it completes — the same contract the earlier export component had.
        await withDependency("workflow engine", () => context.workflows.get("dataExportWorkflow").create({ params: args }));
    });

export const startDeletionWorkflow = internalAction
    .input({
        requestId: v.id("gdprRequests"),
        userEmail: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .action(async ({ args, ctx: context }) => {
        await withDependency("workflow engine", () => context.workflows.get("accountDeletionWorkflow").create({ params: args }));

        // Declared `.output(v.null())`; return it rather than falling off the
        // end, which yields `undefined` and does not match the contract.
        return null;
    });
