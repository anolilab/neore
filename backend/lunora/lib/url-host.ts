/** `host` lower case and without trailing dots: the spelling a host-keyed check compares, also for a host a person typed. */
export const hostSpelling = (host: string): string => {
    let end = host.length;

    while (end > 0 && host[end - 1] === ".") {
        end -= 1;
    }

    return host.slice(0, end).toLowerCase();
};

/**
 * The host a URL names, in the one spelling every host-keyed check compares: lower case, ASCII (the URL parser writes an
 * IDN host as punycode) and without trailing dots. `shop.example.` is the fully-qualified spelling of `shop.example`,
 * and `shop.example..` resolves nowhere else, so all three are one host; a check keyed on the dotted spelling would let
 * the dotless one past it, and the other way round. `""` when `url` does not parse or names no host.
 */
export const urlHost = (url: string | undefined): string => {
    if (url === undefined) {
        return "";
    }

    let hostname: string;

    try {
        ({ hostname } = new URL(url));
    } catch {
        return "";
    }

    return hostSpelling(hostname);
};
