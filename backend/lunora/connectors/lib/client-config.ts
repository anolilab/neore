/**
 * Pre-registered OAuth clients for connectors whose authorization server does
 * not support Dynamic Client Registration (GitHub, Slack, Google).
 *
 * A definition names an env PREFIX (`oauthClientEnvPrefix: "GITHUB_CONNECTOR"`)
 * and the operator sets `<PREFIX>_CLIENT_ID` / `<PREFIX>_CLIENT_SECRET`. The
 * secret is read from env at every token request rather than copied into the
 * database, so rotating it is an env change, not a data migration.
 *
 * A definition WITHOUT a prefix relies on DCR and is always "configured"; one
 * with a prefix but no client id is shown as "not configured" and cannot start
 * a flow.
 */

export interface EnvOAuthClient {
    clientId: string;
    clientSecret?: string;
}

/** Only these prefixes may be read, so a definition row cannot name an arbitrary env var (e.g. `BETTER_AUTH`). */
const CONNECTOR_CLIENT_ENV_PREFIXES = ["GITHUB_CONNECTOR", "GOOGLE_CONNECTOR", "SLACK_CONNECTOR"] as const;

type ConnectorClientEnvPrefix = (typeof CONNECTOR_CLIENT_ENV_PREFIXES)[number];

const isKnownPrefix = (prefix: string): prefix is ConnectorClientEnvPrefix => (CONNECTOR_CLIENT_ENV_PREFIXES as ReadonlyArray<string>).includes(prefix);

export const readEnvOAuthClient = (prefix: string, env: Record<string, string | undefined> = process.env): EnvOAuthClient | null => {
    if (!isKnownPrefix(prefix)) {
        return null;
    }

    const clientId = env[`${prefix}_CLIENT_ID`]?.trim();

    if (!clientId) {
        return null;
    }

    const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();

    return { clientId, ...(clientSecret && { clientSecret }) };
};

/** Whether a flow can start for this definition. */
export const isConnectorConfigured = (
    definition: { oauthClientEnvPrefix?: string; requiresOAuth: boolean },
    env?: Record<string, string | undefined>,
): boolean => {
    if (!definition.requiresOAuth || !definition.oauthClientEnvPrefix) {
        return true;
    }

    return readEnvOAuthClient(definition.oauthClientEnvPrefix, env) !== null;
};

/** Where the provider sends the browser back: the app's callback route, which completes the flow as the signed-in user. */
export const connectorRedirectUri = (siteUrl: string): string => `${new URL(siteUrl).origin}/dashboard/settings/connectors/callback`;
