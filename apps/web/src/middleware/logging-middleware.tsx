import { createMiddleware } from "@tanstack/react-start";

const preLogMiddleware = createMiddleware({ type: "function" })
    .client(async (context) => {
        const clientTime = new Date();

        return context.next({
            context: {
                clientTime,
            },
            sendContext: {
                clientTime,
            },
        });
    })
    .server(async (context) => {
        const serverTime = new Date();

        return context.next({
            sendContext: {
                durationToServer: serverTime.getTime() - context.context.clientTime.getTime(),
                serverTime,
            },
        });
    });

const logMiddleware = createMiddleware({ type: "function" })
    .middleware([preLogMiddleware])
    .client(async (context) => {
        const result = await context.next();

        const now = new Date();

        console.log("Client Req/Res:", {
            duration: result.context.clientTime.getTime() - now.getTime(),
            durationFromServer: now.getTime() - result.context.serverTime.getTime(),
            durationToServer: result.context.durationToServer,
        });

        return result;
    });

export default logMiddleware;
