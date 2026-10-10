import { v } from "lunorash/server";

import { internalAction } from "../_generated/server";
import { withDependency } from "../lib/dependency";

export const startImportWorkflow = internalAction
    .input({
        jobId: v.id("chatImportJobs"),
        provider: v.string(),
        r2Key: v.string(),
        totalConversations: v.number(),
        userId: v.string(),
    })
    .action(async ({ args, ctx: context }) => {
        await withDependency("workflow engine", () => context.workflows.get("chatImportWorkflow").create({ params: args }));
    });

export default startImportWorkflow;
