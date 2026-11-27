import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Plugins: versioned installs of skills, triggers and group chats, with their children tracked by install.",
    tables: ["pluginInstallSlots", "pluginInstalls", "pluginItems"],
});
