import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Browser automation sessions and their actions (Cloudflare Browser Rendering, browser extension).",
    tables: ["browserActions", "browserExtensions", "browserSessions"],
});
