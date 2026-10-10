import type { CatalogRemote, CatalogServer, MCPHeader, MCPServerFormData, MCPServerSetup, MCPSetupField } from "./types";

export const EMPTY_SERVER: MCPServerFormData = {
    enabled: true,
    headers: [],
    icon: "",
    name: "",
    protocol: "http",
    url: "",
};

const SENSITIVE_KEY_PATTERNS = [/key/i, /token/i, /secret/i, /password/i, /auth/i, /credential/i, /bearer/i];

/** Detect header keys likely containing secrets. */
export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));

/** True when `value` parses as an absolute URL. */
export const isValidUrl = (value: string): boolean => {
    try {
        return Boolean(new URL(value));
    } catch {
        return false;
    }
};

/** Mask a value: show first 3 chars + bullets + last char. */
export const maskValue = (value: string): string => {
    if (!value) {
        return "";
    }

    if (value.length < 8) {
        return "\u{2022}".repeat(6);
    }

    return value.slice(0, 3) + "\u{2022}".repeat(Math.min(10, value.length - 4)) + value.slice(-1);
};

export const serverKey = (s: { name: string; url: string }): string => `${s.name}::${s.url}`;

const PLACEHOLDER_RE = /\{([\w.-]+)\}/g;

const escapeRegExp = (value: string): string => value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);

/** Placeholder names in a registry template, in order, without duplicates. */
export const templatePlaceholders = (template: string): string[] => [...new Set([...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1] as string))];

/** True while `value` still carries an unfilled `{placeholder}`. */
export const hasUnresolvedPlaceholder = (value: string): boolean => templatePlaceholders(value).length > 0;

/** Substitute filled values; unfilled placeholders are left visible. */
export const fillTemplate = (template: string, values: Record<string, string>): string =>
    template.replaceAll(PLACEHOLDER_RE, (whole, name: string) => {
        const value = values[name]?.trim();

        return value || whole;
    });

/** Streamable HTTP first — it is the transport the add form recommends. */
export const preferredRemote = (server: CatalogServer): CatalogRemote | undefined =>
    server.remotes.find((remote) => remote.protocol === "http") ?? server.remotes[0];

/**
 * Resolve the URL and headers a setup's current values produce.
 *
 * A header whose template still has an unfilled placeholder is emitted EMPTY, so
 * the save path's "drop blank headers" rule omits an optional header the user
 * skipped rather than sending `Bearer {api_key}` literally. A required one is
 * caught by the save-time check instead.
 */
export const resolveSetup = (setup: MCPServerSetup): { headers: MCPHeader[]; url: string } => {
    return {
        headers: setup.headerTemplates.map(({ key, template }) => {
            const value = fillTemplate(template, setup.values);

            return { key, value: hasUnresolvedPlaceholder(value) ? "" : value };
        }),
        url: fillTemplate(setup.urlTemplate, setup.values),
    };
};

/**
 * One field per `{placeholder}` in the remote URL, described by the registry's
 * `variables` where it declares them — and still present where it does not, since
 * an undeclared placeholder would otherwise block saving with no way to fill it.
 */
const urlSetupFields = (remote: CatalogRemote): { fields: MCPSetupField[]; values: Record<string, string> } => {
    const values: Record<string, string> = {};
    const names = [...new Set([...remote.variables.map((variable) => variable.name), ...templatePlaceholders(remote.url)])];

    const fields = names.map((name): MCPSetupField => {
        const variable = remote.variables.find((candidate) => candidate.name === name);
        const initial = variable?.value ?? variable?.choices?.[0];

        if (initial) {
            values[name] = initial;
        }

        return {
            choices: variable?.choices,
            description: variable?.description,
            isRequired: variable?.isRequired ?? true,
            isSecret: variable?.isSecret ?? false,
            key: name,
            label: name,
        };
    });

    return { fields, values };
};

/** Build the add-server form for a catalogue server: name, URL, icon and auth headers prefilled. */
export const catalogServerToFormData = (server: CatalogServer, remote: CatalogRemote | undefined = preferredRemote(server)): MCPServerFormData => {
    if (!remote) {
        return { ...EMPTY_SERVER, icon: server.icon ?? "", name: server.title };
    }

    const { fields, values } = urlSetupFields(remote);

    // A header with no template is itself the value: `X-API-Key` → `{X-API-Key}`.
    const headerTemplates = remote.headers.map((header) => {
        return { key: header.name, template: header.value ?? `{${header.name}}` };
    });

    for (const [index, header] of remote.headers.entries()) {
        const template = headerTemplates[index]?.template ?? "";

        for (const placeholder of templatePlaceholders(template)) {
            if (fields.every((field) => field.key !== placeholder)) {
                fields.push({
                    description: header.description,
                    isRequired: header.isRequired,
                    isSecret: header.isSecret,
                    key: placeholder,
                    // `{Authorization}` alone reads fine; `Bearer {smithery_api_key}`
                    // is better labelled by the placeholder than by `Authorization`.
                    label: template === `{${placeholder}}` ? header.name : placeholder,
                });
            }
        }
    }

    const setup: MCPServerSetup = { fields, headerTemplates, urlTemplate: remote.url, values };
    const resolved = resolveSetup(setup);

    return {
        enabled: true,
        headers: resolved.headers,
        icon: server.icon ?? "",
        name: server.title,
        protocol: remote.protocol,
        setup: fields.length > 0 ? setup : undefined,
        url: resolved.url,
    };
};

/** Apply one setup value to the form, re-deriving the URL and the templated header rows. */
export const applySetupValue = (form: MCPServerFormData, key: string, value: string): MCPServerFormData => {
    if (!form.setup) {
        return form;
    }

    const setup: MCPServerSetup = { ...form.setup, values: { ...form.setup.values, [key]: value } };
    const resolved = resolveSetup(setup);
    const byKey = new Map(resolved.headers.map((header) => [header.key, header.value]));
    const present = new Set(form.headers.map((header) => header.key));

    return {
        ...form,
        // Templated rows are updated in place; rows the user added are untouched.
        headers: [
            ...form.headers.map((header) => (byKey.has(header.key) ? { ...header, value: byKey.get(header.key) ?? "" } : header)),
            ...resolved.headers.filter((header) => !present.has(header.key)),
        ],
        setup,
        url: resolved.url,
    };
};

/** A required setup field that is still empty, if any — checked before saving a catalogue install. */
export const findMissingSetupField = (form: MCPServerFormData) =>
    form.setup?.fields.find((field) => field.isRequired && !form.setup?.values[field.key]?.trim());

/** Whether a catalogue server is already configured (matched on its resolved or template URL). */
export const isCatalogServerAdded = (server: CatalogServer, configuredUrls: ReadonlySet<string>): boolean =>
    server.remotes.some((remote) => {
        if (configuredUrls.has(remote.url)) {
            return true;
        }

        if (!hasUnresolvedPlaceholder(remote.url)) {
            return false;
        }

        // `https://mcp.example.com/{project}/mcp` matches any configured project.
        const pattern = new RegExp(
            `^${remote.url
                .split(PLACEHOLDER_RE)
                .map((part, index) => (index % 2 === 1 ? "[^/]+" : escapeRegExp(part)))
                .join("")}$`,
        );

        return [...configuredUrls].some((url) => pattern.test(url));
    });
