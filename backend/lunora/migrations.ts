import { defineMigration } from "lunorash/server";

export const backfillToolapprovalruns = defineMigration({
    id: "backfill-toolapprovalruns",
    table: "toolApprovalRuns",
    // `organizationId` is optional: a row written before it existed already fits the shape, so nothing is rewritten.
    up: (document) => document,
});
