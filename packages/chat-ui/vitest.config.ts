import { defineConfig } from "vitest/config";

import { timeSharding } from "../../scripts/vitest/time-sharding";

export default defineConfig({
    test: {
        ...timeSharding(import.meta.url),
    },
});
