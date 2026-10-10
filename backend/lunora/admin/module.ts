import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Platform-admin tools: the audit log, bulk cleanup of inactive anonymous users, gateway analytics.",
    tables: ["auditLog", "cleanupConfigs", "cleanupLogs"],
});
