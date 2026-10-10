import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Knowledge files and collections: chunking, embeddings, hybrid retrieval and citations.",
    tables: ["knowledgeChunks", "knowledgeCollectionLinks", "knowledgeCollections", "knowledgeFiles", "projectKnowledge", "threadKnowledge"],
});
