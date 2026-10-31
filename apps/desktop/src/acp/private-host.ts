/**
 * True for a host that is plainly this machine or a private network: `localhost`, a `.local`/`.internal` name, or a
 * private, loopback or link-local address written out in the URL. Names are not resolved here, so a public name
 * that points inward is not caught; the download's checksum is what keeps its bytes from being installed.
 */
const PRIVATE_NAME = /(?:^localhost|\.localhost|\.local|\.internal)$/u;
const PRIVATE_V4 = [
    /^0\./u,
    /^10\./u,
    /^127\./u,
    /^169\.254\./u,
    /^172\.(?:1[6-9]|2\d|3[01])\./u,
    /^192\.168\./u,
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u,
];
const PRIVATE_V6 = /^(?:::1?|f[cd][\da-f]{2}:.*|fe[89ab][\da-f]:.*)$/u;
const BRACKETS = /^\[|\]$/gu;
const TRAILING_DOT = /\.$/u;
/** `new URL` writes an IPv4-mapped address as hex groups (`::ffff:7f00:1`). */
const MAPPED_V4 = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u;

const dotted = (high: number, low: number): string => `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`;

export const isPrivateHost = (hostname: string): boolean => {
    const host = hostname.toLowerCase().replaceAll(BRACKETS, "").replace(TRAILING_DOT, "");

    if (PRIVATE_NAME.test(host) || PRIVATE_V4.some((pattern) => pattern.test(host))) {
        return true;
    }

    const mapped = MAPPED_V4.exec(host);

    if (mapped) {
        return isPrivateHost(dotted(Number.parseInt(mapped[1] as string, 16), Number.parseInt(mapped[2] as string, 16)));
    }

    return PRIVATE_V6.test(host);
};
