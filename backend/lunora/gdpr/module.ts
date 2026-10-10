import { defineModule } from "lunorash/server";

/**
 * Owns only its request/consent/audit tables. Erasure (`steps/deletion-steps.ts`,
 * `steps/residual-deletion-steps.ts`) deletes rows of nearly every other module,
 * and its `cross_module_table_write` findings (317 on 2026-10-06) are ACCEPTED:
 * Article 17 erasure must reach every table, and the ordering, batch sizes and
 * crash/redelivery behaviour of those steps are pinned by the tests beside them,
 * so they stay together here rather than scattered across the owners.
 * A NEW module's erasure goes in its own `<module>/gdpr.ts` (devices, evals,
 * memory, pages, tasks, coding-agents, notifications already do), wired into
 * `workflows/deletion-workflow.ts` — writes the owner makes, so no finding.
 * `retention.ts` prunes `usageDaily`/`subAgentRuns` the same way, also accepted.
 */
export default defineModule({
    description: "GDPR data export and deletion workflows, consent records and retention sweeps across every module's data.",
    tables: ["gdprAuditLog", "gdprConsent", "gdprRequests"],
});
