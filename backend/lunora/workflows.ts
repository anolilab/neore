/**
 * Workflow registry.
 *
 * `@lunora/workflow`'s codegen scans THIS FILE for `defineWorkflow(...)` calls:
 * each one becomes a generated `WorkflowEntrypoint` class, a wrangler
 * `workflows[]` entry, and a key on `ctx.workflows`.
 *
 * A re-export does not count. `export { dataExportWorkflow } from "./gdpr/…"`
 * left every `ctx.workflows.get(...)` unresolved, and codegen reported it only as
 * an ERROR-level advisory buried in generated output — the
 * build stayed green. So the handler bodies live next to the code they
 * orchestrate as plain `WorkflowConfig` objects, and the `defineWorkflow` call
 * happens here.
 *
 * The export NAME is what `ctx.workflows.get(...)` addresses and what the binding
 * is derived from — renaming one is a deployment-visible change.
 */
import { defineWorkflow } from "@lunora/workflow";

import { chatImportWorkflowConfig } from "./chat-import/workflows/import-workflow";
import { accountDeletionWorkflowConfig } from "./gdpr/workflows/deletion-workflow";
import { dataExportWorkflowConfig } from "./gdpr/workflows/export-workflow";

export type { ImportParams } from "./chat-import/workflows/import-workflow";
export type { DeletionParams } from "./gdpr/workflows/deletion-workflow";
export type { ExportParams } from "./gdpr/workflows/export-workflow";

export const dataExportWorkflow = defineWorkflow({ handler: dataExportWorkflowConfig.handler });
export const accountDeletionWorkflow = defineWorkflow({ handler: accountDeletionWorkflowConfig.handler });
export const chatImportWorkflow = defineWorkflow({ handler: chatImportWorkflowConfig.handler });
