import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Develop mode: pull requests across Git hosts, read through one host adapter. Holds no table yet; the client caches what it reads.",
    tables: [],
});
