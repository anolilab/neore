import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Gateway usage views and budget-alert notification rules for the settings dashboard.",
    tables: ["gatewayNotifications"],
});
