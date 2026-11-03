/**
 * Where the data we store on Cloudflare is pinned: one per-stage setting, read by
 * `alchemy.run.ts` for every D1 database and R2 bucket it creates.
 *
 * Cloudflare fixes a D1 database's, an R2 bucket's and a Durable Object's
 * jurisdiction when it is created and never moves it, so a stage's value is
 * chosen before its first deploy. Unset or empty means `eu`; `default` opts a
 * non-production test stage out explicitly. Production refuses `default`: a
 * production resource created un-pinned cannot be fixed afterwards.
 *
 * Durable Objects are NOT driven by this value: codegen reads the schema's
 * `.jurisdiction("eu")` as a string literal, so that stays `eu` on every stage
 * (`data-jurisdiction.test.ts` pins it).
 */

export type DataJurisdiction = "default" | "eu";

const DATA_JURISDICTIONS: ReadonlyArray<DataJurisdiction> = ["default", "eu"];

export const DATA_JURISDICTION_ENV = "DATA_JURISDICTION";

export const resolveDataJurisdiction = (stage: string, env: Record<string, string | undefined> = process.env): DataJurisdiction => {
    const raw = env[DATA_JURISDICTION_ENV]?.trim().toLowerCase();

    if (raw === undefined || raw === "") {
        return "eu";
    }

    const match = DATA_JURISDICTIONS.find((jurisdiction) => jurisdiction === raw);

    if (match === undefined) {
        throw new Error(`${DATA_JURISDICTION_ENV} must be one of ${DATA_JURISDICTIONS.join(", ")}, not ${JSON.stringify(raw)}.`);
    }

    if (match === "default" && stage === "production") {
        throw new Error(`${DATA_JURISDICTION_ENV}=default is not allowed on the production stage: its data stays in the EU jurisdiction.`);
    }

    return match;
};
