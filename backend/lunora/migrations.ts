import { defineMigration } from "lunorash/server";

/**
 * `headlessApproved` is a new optional key inside each pending approval's stored config (`chat/lib/tool-run-config.ts`).
 * A row written before it has no key, which means no inherited approval. This writes the key as an empty list on those
 * rows: the same meaning, now stored in the shape the schema describes. Rows that already carry the key keep it.
 */
export const addHeadlessApproved = defineMigration({
    id: "add-headless-approved",
    table: "toolApprovalRuns",
    up: (document) => {
        const config = (document.config ?? {}) as Record<string, unknown>;

        return { ...document, config: { ...config, headlessApproved: config.headlessApproved ?? [] } };
    },
});
