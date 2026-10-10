import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Eval datasets and runs: cases run one at a time against a skill, a model or knowledge retrieval, then judged.",
    tables: ["evalCases", "evalDatasets", "evalResults", "evalRuns"],
});
