import { defineMigration } from "lunorash/server";

/** The approval snapshot fields this migration reads and writes; the rest of the row is copied through unchanged. */
interface ApprovalConfig {
    group?: { organizationId?: string };
    organizationId?: string;
}

/**
 * Records the organization on paused approvals that predate `config.organizationId`. Only pending rows can be
 * continued, so resolved rows are left as they are. The continuation already reads the thread's stored organization
 * first, then the group snapshot's, so this only makes the snapshot self-contained: no cap decision changes.
 */
export const backfillApprovalOrganization = defineMigration({
    down: (document) => {
        const config = { ...(document.config as ApprovalConfig) };

        delete config.organizationId;

        return { ...document, config };
    },
    id: "backfill-approval-organization",
    table: "toolApprovalRuns",
    up: async (document, ctx) => {
        const config = document.config as ApprovalConfig;

        if (document.status !== "pending" || config.organizationId !== undefined) {
            return undefined;
        }

        const thread = await ctx.db.get("threads", String(document.threadId));
        const threadOrganizationId = thread?.organizationId;
        const organizationId = typeof threadOrganizationId === "string" ? threadOrganizationId : config.group?.organizationId;

        if (!organizationId) {
            return undefined;
        }

        return { ...document, config: { ...config, organizationId } };
    },
});
