import { defineModule } from "lunorash/server";

export default defineModule({
    description: "The usage page's daily rollup (usageDaily), recorded once per reply, plus its one-shot backfill.",
    tables: ["usageBackfill", "usageDaily", "usageReplies"],
});
