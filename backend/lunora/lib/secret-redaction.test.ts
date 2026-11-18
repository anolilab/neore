import { describe, expect, it } from "vitest";

import { containsSecret, REDACTED, redactSecrets } from "./secret-redaction";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ALPHANUMERIC = `${LETTERS}0123456789`;
const LOWER_ALPHANUMERIC = ALPHANUMERIC.slice(26);

/** A deterministic random-looking string, assembled at runtime so no literal in this file reads as a real credential. */
const randomLike = (length: number, alphabet = ALPHANUMERIC, seed = 7): string => {
    let state = seed;
    let out = "";

    for (let index = 0; index < length; index += 1) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        out += alphabet[(state >>> 16) % alphabet.length];
    }

    return out;
};

const join = (...parts: string[]): string => parts.join("");

/** An AWS secret access key's shape: 40 base64 characters, one digit, two slashes. */
const AWS_SECRET = join(randomLike(12, LETTERS, 3), "/", randomLike(14, LETTERS, 5), "7/", randomLike(11, LETTERS, 9));

describe("redactSecrets", () => {
    it.each([
        ["an sk- key", join("sk", "-proj-", randomLike(40))],
        ["a Stripe key", join("sk", "_live_", randomLike(24))],
        ["a GitHub token", join("gh", "p_", randomLike(36))],
        ["a fine-grained GitHub token", join("github", "_pat_", randomLike(40))],
        ["a GitLab token", join("gl", "pat-", randomLike(20))],
        ["a Slack token", join("xo", "xb-", "1234567890-", randomLike(24))],
        ["an AWS access key id", join("AK", "IA", randomLike(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"))],
        ["a Google API key", join("AI", "za", randomLike(35))],
        ["a JWT", join("ey", "J", randomLike(20), ".", "eyJ", randomLike(30), ".", randomLike(32))],
        ["a long random string", randomLike(40)],
        ["a long hex secret", randomLike(64, "0123456789abcdef")],
        ["a Slack webhook", join("https://hooks.", "slack.com/services/T0", randomLike(8), "/B0", randomLike(8), "/", randomLike(24))],
        ["a random URL path segment", join("https://example.com/hook/", randomLike(40), "/run")],
        ["an AWS secret access key with one digit and slashes", AWS_SECRET],
        ["an AWS secret access key across URL path segments", join("https://example.com/", AWS_SECRET, "/run")],
        ["an AWS secret access key across file path segments", join("/srv/keys/", AWS_SECRET, "/run")],
        ["an AWS secret access key as one URL path segment", join("https://example.com/", randomLike(39, LETTERS), "7/run")],
        [
            "an AWS secret access key with a short lower-case segment in a path",
            join("https://example.com/", randomLike(16, LETTERS, 21), "/kq/", randomLike(19, LETTERS, 23), "7/run"),
        ],
        ["an AWS secret access key ending a sentence", join("https://example.com/", AWS_SECRET, ".")],
        ["an AWS secret access key before a query", join("(https://example.com/", AWS_SECRET, "?v=1)")],
        ["an AWS secret access key without a slash", join(randomLike(39, LETTERS), "7")],
    ])("removes %s", (_label, secret) => {
        const redacted = redactSecrets(`The user's key is ${secret} for the staging box`);

        expect(redacted).not.toContain(secret);
        expect(redacted).toContain(REDACTED);
        expect(redacted).toContain("for the staging box");
    });

    it("removes a private key block whole", () => {
        const label = join("OPENSSH ", "PRIVATE ", "KEY");
        const block = `-----BEGIN ${label}-----\n${randomLike(64)}\n${randomLike(64)}\n-----END ${label}-----`;

        expect(redactSecrets(`Deploy key:\n${block}\nUsed on the build host.`)).toBe(`Deploy key:\n${REDACTED}\nUsed on the build host.`);
    });

    it("keeps the scheme of a Bearer or Basic credential", () => {
        expect(redactSecrets(`Authorization: Bearer ${randomLike(12)}.x9`)).toBe(`Authorization: Bearer ${REDACTED}`);
        expect(redactSecrets(`send it with bearer abc123def456`)).toBe(`send it with bearer ${REDACTED}`);
        expect(redactSecrets(`Basic ${btoa(join("user:", randomLike(10)))}`)).toBe(`Basic ${REDACTED}`);
    });

    it("removes a letter-only Bearer or Basic credential", () => {
        expect(redactSecrets(`Authorization: Bearer ${"abcd".repeat(6)}`)).toBe(`Authorization: ${REDACTED}`);
        expect(redactSecrets(`curl it with Bearer ${randomLike(24, LETTERS)}`)).toBe(`curl it with Bearer ${REDACTED}`);
        expect(redactSecrets(`Basic ${btoa(join("us", "er:pa", "ss"))}`)).toBe(`Basic ${REDACTED}`);
    });

    it("removes a short Basic credential that decodes to a user name and password", () => {
        expect(redactSecrets(`Uses Basic ${btoa(join("us", "er:1"))} on the router`)).toBe(`Uses Basic ${REDACTED} on the router`);
        expect(redactSecrets(`Basic ${btoa(join("a:", "b"))}`)).toBe(`Basic ${REDACTED}`);
    });

    it.each([
        ["password: hunter2", `password: ${REDACTED}`],
        ["DB_PASSWORD=correct horse", `DB_PASSWORD=${REDACTED}`],
        [join("password: ", "correcthorse", "batterystaple"), `password: ${REDACTED}`],
        ["password: hunter, from the old laptop", `password: ${REDACTED}, from the old laptop`],
        ["My password is correct horse battery staple!", `My password is ${REDACTED}`],
        ["The default password is admin and nobody changed it.", `The default password is ${REDACTED} and nobody changed it.`],
        ['Their passphrase was "blue whale sings"', `Their passphrase was ${REDACTED}`],
        [`password=${REDACTED}${join("hun", "ter2")}`, `password=${REDACTED}`],
        [`my password is ${REDACTED}${join("hun", "ter2")}`, `my password is ${REDACTED}`],
        [`The secret is ${REDACTED}${join("s3c", "ret!")}`, `The secret is ${REDACTED}`],
        ["The API secret is p@ss-word here", `The API secret is ${REDACTED} here`],
        ['{"api_key": "abc def"}', `{"api_key": ${REDACTED}}`],
        ["OPENAI_API_KEY=whatever", `OPENAI_API_KEY=${REDACTED}`],
        ["client-secret = s3cr3t", `client-secret = ${REDACTED}`],
        ["token=abc", `token=${REDACTED}`],
        ["My wifi password is Tr0ub4dor&3 at home", `My wifi password is ${REDACTED} at home`],
        [join("My password is blue green.", "Orange42"), `My password is ${REDACTED}`],
        ["WIFI_PASSWORD=walk to the park", `WIFI_PASSWORD=${REDACTED}`],
        [`DB_PASSWORD=${"word ".repeat(40).trim()}. Done`, `DB_PASSWORD=${REDACTED}. Done`],
        [`My password is ${"x1".repeat(75)} and more`, `My password is ${REDACTED}`],
        [join("DB_PASSWORD=hun", "ter2 DB_USER=bob"), `DB_PASSWORD=${REDACTED} DB_USER=bob`],
        [join("Password: hun", "ter2, 16 characters"), `Password: ${REDACTED}, 16 characters`],
        ["requireStrongPassword=hunter", `requireStrongPassword=${REDACTED}`],
        [join("WIFI_PASSWORD=yes we can ", "2024!"), `WIFI_PASSWORD=${REDACTED}`],
        ["WIFI_PASSWORD=Off Road Rally", `WIFI_PASSWORD=${REDACTED}`],
        [join("password: 10 chars Tr0ub", "4dor&3"), `password: ${REDACTED}`],
        ["password: 4 words: correct horse battery staple", `password: ${REDACTED}`],
        ["my password is butterfly", `my password is ${REDACTED}`],
        ["password: darling", `password: ${REDACTED}`],
        ["My password is morning.", `My password is ${REDACTED}.`],
        ["db_password: correct horse", `db_password: ${REDACTED}`],
        ["Password: optional, db_password: correct horse", `Password: optional, db_password: ${REDACTED}`],
        ["Password: optional db_password: correct horse", `Password: optional db_password: ${REDACTED}`],
        ['"password": correct horse', `"password": ${REDACTED}`],
        ["wifiPassword: walk to the park", `wifiPassword: ${REDACTED}`],
        [join(String.raw`DB_TOKEN="prefix\"hun`, 'ter2" in prod'), `DB_TOKEN=${REDACTED} in prod`],
        [join(String.raw`DB_PASSWORD='it\'s hun`, "ter2' on staging"), `DB_PASSWORD=${REDACTED} on staging`],
        [join('DB_PASSWORD="alpha\nbe', 'ta2" on staging'), `DB_PASSWORD=${REDACTED} on staging`],
        [join('password: "alpha\nbe', 'ta2"'), `password: ${REDACTED}`],
        [join('{"api_key": "abc\nde', 'f"}'), `{"api_key": ${REDACTED}}`],
        ['Their password: "see the wiki"\nUser likes "green" tea.', `Their password: ${REDACTED}\nUser likes "green" tea.`],
        ['Their token: "abc\nUser likes "green" tea.', `Their token: ${REDACTED}\nUser likes "green" tea.`],
        [join('Password: "hun', 'ter2\nUser likes "green" tea and coffee.'), `Password: ${REDACTED}\nUser likes "green" tea and coffee.`],
        ['token: "abc\nUser buys 27" monitors, likes tea.', `token: ${REDACTED}\nUser buys 27" monitors, likes tea.`],
        [join("session_id=", randomLike(32, ALPHANUMERIC, 11), " on staging"), `session_id=${REDACTED} on staging`],
        [join("Cookie sid=", randomLike(24, ALPHANUMERIC, 13), "; path=/"), `Cookie sid=${REDACTED}; path=/`],
        [
            join("Opens https://example.com/app?session_id=", randomLike(24, ALPHANUMERIC, 17), "&tab=2 daily"),
            `Opens https://example.com/app?session_id=${REDACTED}&tab=2 daily`,
        ],
        [join("Saw ", randomLike(24, ALPHANUMERIC, 13), "=", randomLike(24, ALPHANUMERIC, 23), " in the log"), `Saw ${REDACTED} in the log`],
        [join("Saw ", randomLike(16, ALPHANUMERIC, 13), "=", randomLike(16, ALPHANUMERIC, 23), " there"), `Saw ${REDACTED} there`],
        [join("Saw ", randomLike(18, ALPHANUMERIC, 13), "=", randomLike(21, ALPHANUMERIC, 23), " there"), `Saw ${REDACTED} there`],
        [
            join("https://example.com/x?a=b&sig=", randomLike(16, ALPHANUMERIC, 13), "=", randomLike(16, ALPHANUMERIC, 23)),
            `https://example.com/x?a=b&${REDACTED}`,
        ],
        [join("Saw ", randomLike(16, LETTERS, 29), "=", randomLike(16, ALPHANUMERIC, 31), " there"), `Saw ${REDACTED} there`],
        [join("Saw ", randomLike(15, LOWER_ALPHANUMERIC, 37), "1=", randomLike(16, ALPHANUMERIC, 31), " there"), `Saw ${REDACTED} there`],
        [join("Saw session_id=", randomLike(12, ALPHANUMERIC, 41), "-", randomLike(12, ALPHANUMERIC, 43), " there"), `Saw session_id=${REDACTED} there`],
        [join("Saw ", randomLike(18, LOWER_ALPHANUMERIC, 47), "=", randomLike(21, ALPHANUMERIC, 23), " there"), `Saw ${REDACTED} there`],
        [join("Saw auth_session_identifier=", randomLike(18, ALPHANUMERIC, 13), " there"), `Saw auth_session_identifier=${REDACTED} there`],
        [join("Cookie PHPSESSID=", randomLike(32, "0123456789abcdef", 53)), `Cookie PHPSESSID=${REDACTED}`],
        [
            join("Signed https://cdn.example.com/f.png?expires=1700000000&sig=", randomLike(40, "0123456789abcdef", 59)),
            `Signed https://cdn.example.com/f.png?expires=1700000000&sig=${REDACTED}`,
        ],
        [join("brand_token_api_key=hunter-", "2024"), `brand_token_api_key=${REDACTED}`],
        [join("color.\ntoken: hunter-", "2024"), `color.\ntoken: ${REDACTED}`],
        [join("secret: summer-", "2024"), `secret: ${REDACTED}`],
        [join("API token: summer-", "2024"), `API token: ${REDACTED}`],
        [join("access_token=letmein-", "2024"), `access_token=${REDACTED}`],
        [join("My GitHub token is hunter-", "2024"), `My GitHub token is ${REDACTED}`],
        [join("token: '#dead", "beef'"), `token: ${REDACTED}`],
        [join("The API token is s3c", "r3t-value"), `The API token is ${REDACTED}`],
        [`API_KEY="${"ab12 ".repeat(250)}" and User likes tea`, `API_KEY=${REDACTED} and User likes tea`],
        [`My password is "${"ab12 ".repeat(60)}" today`, `My password is ${REDACTED} today`],
        [join("DB_PASS", "WORD", "= ", "hun", "ter2\nDB_HOST=localhost"), join("DB_PASS", "WORD", "= ", REDACTED, "\nDB_HOST=localhost")],
        [join("api_key=Xy7-color token: blue-", "600"), `api_key=${REDACTED} token: ${REDACTED}`],
        [join("DB_PASS", "WORD=gh", "p_", randomLike(36), " correct horse battery"), join("DB_PASS", "WORD=", REDACTED)],
        [join("API_", "KEY=\nhun", "ter2secret"), join("API_", "KEY=\n", REDACTED)],
        [join("API_", "KEY=\n  Xk9p", "Q2mZ7"), join("API_", "KEY=\n  ", REDACTED)],
        [join("api_key=x_color token: blue-", "600"), `api_key=${REDACTED} token: ${REDACTED}`],
        [join("Cookie sid=", randomLike(22, ALPHANUMERIC, 13), "==; path=/"), `Cookie sid=${REDACTED}; path=/`],
        [
            join("Pass", 'word: "hun', "ter2", '\nUser said hi."', "\nUser likes tea."),
            join("Pass", "word: ", REDACTED, '\nUser said hi."', "\nUser likes tea."),
        ],
    ])("removes the value of %j", (input, expected) => {
        expect(redactSecrets(input)).toBe(expected);
    });

    it.each([join("api_key=Xy7-color token: blue-", "600"), join("api_key=x_color token: blue-", "600"), join("my secret='abc'", "tail")])(
        "finds nothing left on a second pass over %j",
        (input) => {
            const once = redactSecrets(input);

            expect(redactSecrets(once)).toBe(once);
        },
    );

    it.each([
        "User prefers TypeScript over JavaScript and works at Acme since 2019-04-01.",
        "Born on 12/05/1990, lives in Berlin, phone +49 30 1234567.",
        "The secret to good bread is patience.",
        "Their password manager is 1Password and they rotate passwords yearly.",
        "The token is expired, so they log in again.",
        "Has a basic understanding of Rust; bearer bonds came up once.",
        "Order 123456789012 shipped; ticket NEO-4211 tracks it.",
        "Project id 3f2b8c9e-1a4d-4e6b-9c7f-2d8e5a1b0c3d is the staging one.",
        "Pinned commit 9fceb02d0ae598e95dc970b74767f19372d61af8 in the lockfile.",
        "Main component is ReleaseNotesDashboardWidgetContainer2024 in src/features/release-notes/v2/index.tsx.",
        "Reads https://example.com/blog/2024/05/a-very-long-article-slug-about-memory-systems-3 often.",
        "Uses sk-learn style pipelines and the gh_ CLI prefix in aliases.",
        "Asked what an sk- key looks like.",
        "Sets max_tokens=4096 for long answers.",
        "TokenService: handles refresh for the mobile app.",
        "Their login is passwordless: true for staff.",
        "Password: forgotten often, so they use a manager.",
        "Uses Basic base64-encoded auth on the old intranet.",
        "Password: forgotten.",
        "My password is hard to remember.",
        "The password is twelve characters long.",
        "requireStrongPassword: false",
        "Password: none, they sign in with a passkey.",
        "My password is expired, so IT resets it monthly.",
        "Their password was stored in the shared vault.",
        "The password is the same as the wifi one.",
        "The secret is low-and-slow cooking.",
        "User's secret was self-taught piano.",
        "Has a basic understanding of Rust and a basic grasp of Go.",
        "Holds bearer instruments and bearer bonds.",
        "User sets requireStrongPassword=false in the admin config.",
        join("Sets ALLOW_EMPTY_", "PASSWORD=yes on the test database."),
        "User's work password is 16 characters long.",
        "Password: 12 characters minimum, per company policy.",
        "My password is blue green, like the sea.",
        "PASSWORD=16 characters long",
        "token=12 characters minimum",
        "My password is encrypted.",
        "My password was hacked.",
        "My password was hacked and I reset it.",
        "The Wi-Fi password is printed.",
        "Password: recommended.",
        "My password is expiring.",
        "My password is annoying.",
        "The password is confusing.",
        "My password is ugly.",
        "db_password: stored in the vault",
        "DB_PASSWORD: rotated weekly by Vault",
        "one-time-password: sent by SMS",
        "admin-password: see the wiki",
        "Works on components/ChatPanel/MessageListItemView today.",
        "Calls shouldRenderOAuth2ConsentScreenForNewUsr on sign-in.",
        "Their password was changed, so they log in again.",
        "The password is rotated weekly.",
        "Password: case sensitive",
        "Sets max_password_length: 16 characters.",
        "Knows basic math and basic cooking.",
        "Basic auth is used on the old intranet.",
        "Lives in apps/web/src/features/chat/ChatThreadViews most days.",
        "Opens https://github.com/acme/web/tree/main/components/ChatPanel/MessageListItemView daily.",
        "Edits /home/dev/projects/components/ChatPanel/MessageListItemView/index.tsx a lot.",
        "Reads https://example.com/Docs/GettingStarted/InstallGuide/Linux/v2 first.",
        "Says rock 'n' roll and it's fine.\nLikes 'jazz' too.",
        join("Shared https://www.figma.com/file/", "LKQ4FJ4bTnCS", "jedbRpk931", "/DesignSystem with the team."),
        "User's design token: blue-600",
        "The brand token is blue-600.",
        'Their "color-token": "#1e40af" in tokens.json',
        "Spacing token: --spacing-4, radius token: 8px, colour token: $gray-50.",
        "Ships sku=ABC-123-DEF-456-GHI-789-J and branch=feat-x2-y3-z4-w5-v6-u7 today.",
        "Builds with locale=en-US-x-twain-2024-v3b on the docs site.",
        "Links use utm_campaign=spring_sale_2024_newsletter_v2 for tracking.",
        "Tags builds ref=Release2024Q3Build17 and os=Win10x64Build19045Pro.",
        "Saved file=MyDocument2024Final3.pdf yesterday.",
        "Tracks utm_campaign=Photo5189Friday40Export326Backup and branch=19-1-24-Sales-User-File-Release-2402.",
        "Sets feature_flag_name=enable_new_dashboard_2024 for beta users.",
        "DB_PASSWORD=\nDB_HOST=localhost",
        "API_KEY=\nDB_HOST=localhost",
        "Sets --color token: blue-600 and brand-color token: blue-600.",
        "Uses theme.color token: #fff and h1-color token: #333 and heading2-color token: #222.",
        "API_KEY=\nUser likes green tea.",
        "DB_PASSWORD=\nUser is 42 years old",
        "DB_PASSWORD=\n\nThe user moved to Lisbon in 2021.",
        "DB_PASSWORD=\n- User likes green tea",
        "API_KEY=\n- User likes green tea",
        "Tags builds ref=Release2024Q3Build17== in the log.",
    ])("keeps %j", (text) => {
        expect(redactSecrets(text)).toBe(text);
        expect(containsSecret(text)).toBe(false);
    });

    // Dense `password=x` is linear but near the limit at 400 KB: every assignment is its own match for three passes.
    it.each(["token-", "sk-", "eyJ-", "my password is x ", "bearer ", "Basic abcdefghijkl ", "Basic abcd ", "password=x ", "db_password: x "])(
        "stays fast on a long run of %j",
        (unit) => {
            const text = unit.repeat(Math.ceil(200_000 / unit.length));

            expect(redactSecrets(redactSecrets(text))).toBe(redactSecrets(text));
        },
    );

    // No wall-clock check (docs/agents/testing.md): a pattern that backtracks badly hangs on these inputs instead.
    it.each([
        "my password is x ",
        "password: a.b",
        "PASSWORD=a a=",
        "password is a.b.c ",
        "x".repeat(50),
        String.raw`token="\"x" `,
        'password="a\n',
        "Ab/".repeat(20),
        "a=b",
        "sid=abcdefghij0123456789 ",
        "design token: a-",
        'token="x y \n',
        "api_key='x y \n",
        'my password is "x y \n',
        "x-color token: blue-600 ",
        "password=\n",
        "api_key=\n\n x ",
    ])("reads 400 KB of %j", (unit) => {
        const once = redactSecrets(unit.repeat(Math.ceil(400_000 / unit.length)));

        expect(redactSecrets(once)).toBe(once);
    });

    it("is idempotent", () => {
        const once = redactSecrets(`password: hunter2 and ${join("gh", "p_", randomLike(36))} and token is ${randomLike(40)}`);

        expect(redactSecrets(once)).toBe(once);
    });
});
