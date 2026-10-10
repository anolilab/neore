/**
 * Stand-in for the `cloudflare:workers` runtime module under Node vitest
 * (aliased in `vitest.config.ts`). `src/index.ts` exports the `InternalApi`
 * entrypoint, so every suite that imports the app imports this module; only
 * the `WorkerEntrypoint` base is needed, with the `ctx` / `env` it stores.
 */
export class WorkerEntrypoint<Env = unknown> {
    protected readonly ctx: ExecutionContext;

    protected readonly env: Env;

    public constructor(ctx: ExecutionContext, env: Env) {
        this.ctx = ctx;
        this.env = env;
    }
}
