import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createPail } from "@visulima/pail";

import loggerMiddleware from "./middleware/logger.js";
import { corsMiddleware, securityMiddleware } from "./middleware/security.js";
import { classifyRouter } from "./routes/classify.js";
import { healthRouter } from "./routes/health.js";

export interface AppEnv {
    AI: Ai;
    NODE_ENV: string;
}

export const app = new OpenAPIHono<{ Bindings: AppEnv }>();
const logger = createPail();

// Global middleware
app.use("*", securityMiddleware);
app.use("*", corsMiddleware);
app.use("*", loggerMiddleware);

// Error handler
app.onError(async (error, c) => {
    const isDevelopment = c.env.NODE_ENV !== "production";

    logger.error(error.message, isDevelopment ? error : undefined);

    return c.json(
        {
            details: isDevelopment ? error.stack : undefined,
            error: error.message ?? "Internal Server Error",
        },
        500,
    );
});

// Routes
app.route("/", healthRouter);
app.route("/", classifyRouter);

// OpenAPI docs (dev only)
app.get("/openapi.json", (c) => {
    if (c.env.NODE_ENV === "production") {
        return c.json({ error: "Not found" }, 404);
    }

    return c.json(
        app.getOpenAPIDocument({
            info: {
                description: "Cloudflare Worker service for classifying images for NSFW content.",
                title: "NSFW Checker API",
                version: "1.0.0",
            },
            openapi: "3.1.0",
        }),
    );
});

// Swagger UI — only useful when NODE_ENV != production (openapi.json returns 404 in prod)
app.get("/doc", swaggerUI({ url: "/openapi.json" }));

// Cloudflare Workers requires default export
export default app;
