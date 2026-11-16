import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Storybook only
// ---------------------------------------------------------------------------
// A separate stack from `alchemy.run.ts`: it declares only the static Storybook site, so a
// preview can publish it without the app's secrets or the resources the app needs (D1, R2,
// Queues, Vectorize). Deploy it with
//   alchemy deploy alchemy-storybook.run.ts --stage <stage>
// The build runs before this, in CI, with no secrets; `command` is a no-op because the
// output is already in `outdir`.

const stage = process.env.DEPLOY_ENV ?? process.env.ALCHEMY_STAGE ?? "preview";

if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/u.test(stage)) {
    throw new Error(`Cannot deploy — the stage ${JSON.stringify(stage)} must be 1-20 lowercase letters, digits or hyphens, not starting or ending with one.`);
}

const named = (name: string): string => (stage === "production" ? name : `${name}-${stage}`);

const COMPATIBILITY_DATE = "2026-09-01";

/** Workers Logs bill per event; 10% head sampling, as in `alchemy.run.ts`. */
const WORKER_OBSERVABILITY = { enabled: true, headSamplingRate: 0.1 };

export default Alchemy.Stack(
    "neore-storybook",
    {
        providers: Cloudflare.providers(),
        // Its own state, separate from the app stack's.
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        yield* Cloudflare.Website.StaticSite("storybook", {
            command: "true",
            compatibility: { date: COMPATIBILITY_DATE },
            name: named("neore-storybook"),
            observability: WORKER_OBSERVABILITY,
            outdir: "./apps/web/storybook-static",
        });
    }),
);
