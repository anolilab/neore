import { HealthCheck } from "@visulima/health-check";

/**
 * Workers AI health. Held on an object so the mark* helpers mutate properties
 * rather than rebinding module-level variables.
 */
const aiState: { isHealthy: boolean; lastError?: string } = {
    // Optimistic — assume healthy until a failure is observed.
    isHealthy: true,
};

export const markAiHealthy = (): void => {
    aiState.isHealthy = true;
    aiState.lastError = undefined;
};

export const markAiUnhealthy = (error: string): void => {
    aiState.isHealthy = false;
    aiState.lastError = error;
};

const health = new HealthCheck();

health.addChecker("workers-ai", async () => {
    return {
        displayName: "Workers AI",
        health: {
            healthy: aiState.isHealthy,
            ...(aiState.lastError && { message: aiState.lastError }),
            timestamp: new Date().toISOString(),
        },
    };
});

export { health };
