/**
 * What is wrong with a callback host as it was typed. A hint for the field, not the rule: the server decides, and refuses any host
 * it does not accept (`backend/lunora/public-api/events-webhook.ts`). The codes are mapped to words by the card, so this file has
 * no copy to translate.
 */
export type HostProblem = "empty" | "invalid_characters" | "ip_address" | "long" | "path" | "port" | "scheme";

const MAX_HOST_LENGTH = 253;
const IP_LITERAL = /^[\d.]+$/u;
const PATH_CHARACTERS = /[/?#@]/u;
const HOST_CHARACTERS = /^[\da-z.-]+$/iu;

export const hostProblemOf = (value: string): HostProblem | null => {
    const host = value.trim();

    if (host === "") {
        return "empty";
    }

    if (host.length > MAX_HOST_LENGTH) {
        return "long";
    }

    if (host.includes("://")) {
        return "scheme";
    }

    if (PATH_CHARACTERS.test(host)) {
        return "path";
    }

    if (host.includes(":")) {
        return "port";
    }

    if (IP_LITERAL.test(host) || host.includes("[")) {
        return "ip_address";
    }

    if (!HOST_CHARACTERS.test(host)) {
        return "invalid_characters";
    }

    return null;
};
