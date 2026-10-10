import { defineModule } from "lunorash/server";

export default defineModule({
    description: "In-app notifications, Web Push delivery (@lunora/notify) and the opt-in Daily Brief.",
    tables: ["dailyBriefState", "notifications"],
});
