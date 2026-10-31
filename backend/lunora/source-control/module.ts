import { defineModule } from "lunorash/server";

export default defineModule({
    description:
        "Develop mode: pull requests across Git hosts, read and reviewed through one host adapter. Owns the review drafts; the client caches what it reads.",
    tables: ["reviewDrafts"],
});
