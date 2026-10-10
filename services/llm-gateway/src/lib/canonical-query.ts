/**
 * The canonical `path?query` string that HMAC signatures are computed over.
 *
 * Ported from PR #69, which extracted it for good reason: this rule was
 * duplicated in four places — the verifier (`middleware/auth.ts`), two signers
 * (`routes/v1/chat.ts`, `routes/v1/client-stream.ts`) and the test helper — and
 * a signing rule that exists four times is a signing rule that drifts. It
 * already did: the test helper once signed the bare pathname while the verifier
 * signed path *and* query, so every signed request carrying a query parameter
 * verified as tampered.
 *
 * Both ends now compute it here, so they cannot disagree.
 *
 * The query is sorted so a signature cannot be replayed against the same route
 * with its parameters reordered, and dropped entirely when empty so a
 * parameterless URL signs as a bare path rather than a trailing `?`.
 */

/**
 * Orders by UTF-16 code unit, which is what `URLSearchParams` preserves and what
 * both ends previously implemented by hand. NOT `localeCompare`: that is
 * locale-sensitive, so the same URL could canonicalise differently on two
 * machines and the signature would stop matching.
 */
const byCodeUnit = ([a]: [string, string], [b]: [string, string]): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

export const canonicalPathAndQuery = (url: URL): string => {
    const canonicalQuery = new URLSearchParams([...url.searchParams].toSorted(byCodeUnit)).toString();

    return canonicalQuery ? `${url.pathname}?${canonicalQuery}` : url.pathname;
};
