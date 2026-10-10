import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Product changelog, fetched from Featurebase and cached.",
    tables: ["changelogCache"],
});
