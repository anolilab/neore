import { defineModule } from "lunorash/server";

export default defineModule({
    description:
        "Develop mode: pull requests across Git hosts, read and reviewed through one host adapter. Owns the review drafts and the watched repositories (their cached review-request lists, poll schedule and webhook secrets).",
    tables: ["reviewDrafts", "watchedRepositories"],
});
