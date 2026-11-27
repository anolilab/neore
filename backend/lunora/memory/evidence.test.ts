import { describe, expect, it } from "vitest";

import { compressedEvidenceSources, type ThreadMemory } from "./compress";
import { EVIDENCE_QUOTE_MAX_CHARS, evidenceQuote, newestEvidence, typedEvidenceQuote } from "./evidence";
import { factEvidence } from "./extract";

/** An opaque all-letter token, built at run time so the commit secret scan does not take the fixture for a real one. */
const LETTER_TOKEN = "qwertyuiopasdfghjklzxcvbnm".repeat(2);

const USER_MESSAGE = "Hi!  I moved to\nLisbon last spring and I work as a nurse.";

describe(evidenceQuote, () => {
    it("keeps the user's own span of their words, matched whitespace and case aside", () => {
        expect.assertions(1);

        expect(evidenceQuote("i MOVED to lisbon last spring", USER_MESSAGE)).toBe("I moved to Lisbon last spring");
    });

    it("drops a quote that is not in the user's message, such as the assistant's words", () => {
        expect.assertions(2);

        expect(evidenceQuote("Lisbon is a lovely city", USER_MESSAGE)).toBeUndefined();
        expect(evidenceQuote(undefined, USER_MESSAGE)).toBeUndefined();
    });

    it("cuts a long quote", () => {
        expect.assertions(2);

        const long = "word ".repeat(100).trim();
        const quote = evidenceQuote(long, long)!;

        expect(quote.length).toBeLessThanOrEqual(EVIDENCE_QUOTE_MAX_CHARS);
        expect(quote.endsWith("…")).toBe(true);
    });

    it("cuts a long quote before an emoji, never through it", () => {
        expect.assertions(1);

        const long = `${"a".repeat(EVIDENCE_QUOTE_MAX_CHARS - 2)}😀 and more words after it`;

        expect(evidenceQuote(long, long)).toBe(`${"a".repeat(EVIDENCE_QUOTE_MAX_CHARS - 2)}…`);
    });

    it.each([
        "my api key is sk-proj-abcdefghijklmnop1234",
        "my\u{200B}pass\u{200B}word is hunter22",
        "the password: hunter22",
        "card 4111 1111 1111 1111",
        "the invoice is invoice_4111111111111 ok",
        "token ghp_abcdefghijklmnopqrstuvwxyz0123",
        // A token shape, built here so secret scanners do not flag the fixture.
        ["eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".dozjgNryP4J3jVmNHl0w5N"].join(""),
        "the server key 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffee1234",
        "my password hunter22",
        "mein Passwort lautet Sommer2024!",
        "my bank pin 4821",
        "my SSN is 123-45-6789",
        "my iban is de89370400440532013000",
        "my card expires 08/28",
        "my key is banana",
        "o número da conta é 12345-6",
        "il numero del conto è 12345",
        "meine Kreditkartennummer ist 1234",
        "mon mot de passe est hunter22",
        "mi contraseña es hunter22",
        "minha senha é hunter22",
        "moje hasło to hunter22",
        "il numero di conto è 1234",
        "minha conta bancária é esta",
        "o código de segurança é 123",
        "meu cartão de crédito vence em agosto",
        "meine Geheimzahl ist 4821",
        "meine Zugangsdaten sind im Tresor",
        "meine Bankverbindung ist hier",
        "パスワードはhunter22です",
        "我的密码是hunter22",
        ["open https://bob:", "hunter22@example.com/admin"].join(""),
        ["connect postgres:/", "/app:s3", "cretpass@db.internal:5432/main"].join(""),
        "fetch https://api.example.com/v1/items?password=hunter22",
        "fetch https://api.example.com/v1/items?access_token=abc123",
        "call https://api.example.com/x?client_secret=abc123",
        "call https://api.example.com/x?api_key=abc123",
        "call https://api.example.com/x?apikey=abc123",
        // A login cut off before its "@": the quote ends inside the password, so no "@" is in reach of the check.
        ["my db is https://admin:correct-horse", `my db is https://admin:correct-horse-${"x".repeat(80)}@db.example.com`].join(""),
        "my db is https://admin:correct-horse",
        // A percent-encoded token: its "%2F" must not split it into pieces too short to read as one.
        "see https://example.com/?ref=Zm9vYmFy%2FYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl",
    ])("never quotes secret-looking text: %s", (text) => {
        expect.assertions(1);

        expect(evidenceQuote(text, `Remember this: ${text}`)).toBeUndefined();
    });

    it("keeps the user's casing when another part of their text, or the claim, does not lower-case cleanly", () => {
        expect.assertions(3);

        expect(evidenceQuote("LIKE APPLES", "İ like apples")).toBeUndefined();
        expect(evidenceQuote("like apples", "İ like apples")).toBe("like apples");
        // Folded, the two match; the claim is a character shorter, so its span would drop the user's last letter.
        expect(evidenceQuote("İXY", "i\u{307}XY")).toBeUndefined();
    });

    it.each([
        ["hunter22", "My password is hunter22"],
        ["12345678901234567890", "my account 12345678901234567890"],
        // A zero-width space or joiner inside the label must not hide it.
        ["hunter22", "my pass\u{200B}word is hunter22"],
        ["hunter22", "my pass\u{200D}word is hunter22"],
        ["hunter22", "my pass\u{34F}word is hunter22"],
        ["hunter22", "my\u{200B}password is hunter22"],
        // An all-letter token has no digit for the long-token check, so the header or scheme has to mark it.
        [LETTER_TOKEN, `Authorization: Bearer ${LETTER_TOKEN}`],
        [LETTER_TOKEN, `use bearer ${LETTER_TOKEN} for the staging API`],
        [LETTER_TOKEN, `use bea\u{200B}rer ${LETTER_TOKEN} here`],
        [LETTER_TOKEN, `Cookie: session=${LETTER_TOKEN}`],
        [LETTER_TOKEN, `my auth: ${LETTER_TOKEN}`],
        // A cookie assignment, not only a "cookie:" header.
        ["redfox42", "cookie=redfox42"],
        // A fullwidth label folds to the ASCII one it spells.
        ["hunter22", "my ｐａｓｓｗｏｒｄ: hunter22"],
        // A URL login whose username pushes the scheme out of the 60-character window around the quote.
        ["hunter22", `https://${"a".repeat(80)}:hunter22@example.com`],
    ])("never quotes %s, a value whose own words around it mark it secret", (claimed, typed) => {
        expect.assertions(1);

        expect(evidenceQuote(claimed, typed)).toBeUndefined();
    });

    it.each([
        ["my grandmother's cookie recipe", "I love my grandmother's cookie recipe"],
        ["a long session with my coach", "I had a long session with my coach today"],
        ["the docs page https://example.com/guide?page=2&sort=asc", "see the docs page https://example.com/guide?page=2&sort=asc"],
        ["the repo https://github.com/neore/chat", "the repo https://github.com/neore/chat is public"],
        ["mail me at ana@example.com", "mail me at ana@example.com"],
        ["the dev server https://example.com:8080/x", "the dev server https://example.com:8080/x is up"],
        ["the host https://user@host/x", "the host https://user@host/x"],
    ])("still quotes %s, ordinary words and links without a login", (claimed, typed) => {
        expect.assertions(1);

        expect(evidenceQuote(claimed, typed)).toBe(claimed);
    });
});

describe("evidenceQuote and the shared secret detector", () => {
    it("quotes no value the backend's secret detector catches", () => {
        expect.assertions(2);

        const value = ["Kq8vR2mZ", "7pL4nX9w", "B3tY"].join("");

        expect(evidenceQuote(`my code=${value}`, `Remember my code=${value} please`)).toBeUndefined();
        expect(evidenceQuote("I like jazz", "I like jazz")).toBe("I like jazz");
    });
});

describe("typedEvidenceQuote and a quoted line between typed words", () => {
    it("quotes no phrase the person never wrote as one, joined only once a quoted line is taken out", () => {
        expect.assertions(1);

        const raw = "I am\n> a line from the reply\nvegetarian";

        expect(typedEvidenceQuote("I am vegetarian", "I am\nvegetarian", raw)).toBeUndefined();
    });
});

describe("evidenceQuote and repeated words", () => {
    it("quotes no words that appear again further on beside a credential label", () => {
        expect.assertions(1);

        const filler = "I spent the whole afternoon in the garden with the kids and the dog.";
        const text = `blue falcon 77 is my team name. ${filler} ${filler} My password is blue falcon 77`;

        expect(evidenceQuote("blue falcon 77", text)).toBeUndefined();
    });
});

describe(factEvidence, () => {
    it("links a quote from the typed prompt to the prompt's message", () => {
        expect.assertions(1);

        expect(
            factEvidence("I work as a nurse", 5, { promptMessageId: "m1", quotablePrompt: USER_MESSAGE, threadId: "t1", userMessage: USER_MESSAGE }),
        ).toStrictEqual({
            at: 5,
            messageId: "m1",
            quote: "I work as a nurse",
            threadId: "t1",
        });
    });

    it("links a quote from a message steered in later to the thread only", () => {
        expect.assertions(1);

        const userMessage = `Plan my week\n\nactually I am vegetarian`;

        expect(
            factEvidence("I am vegetarian", 5, { promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage }),
        ).toStrictEqual({
            at: 5,
            quote: "I am vegetarian",
            threadId: "t1",
        });
    });

    it("quotes no steered value whose label ends the prompt before it", () => {
        expect.assertions(1);

        const prompt = "Remember this, my password is";
        const userMessage = `${prompt}\n\nhunter22 and I love jazz`;

        expect(
            factEvidence("hunter22 and I love jazz", 5, { quotablePrompt: prompt, steeredFrom: prompt.length + 2, threadId: "t1", userMessage }),
        ).toBeUndefined();
    });

    it("quotes nothing the user did not type: an attachment in the message, or a run with no typed prompt", () => {
        expect.assertions(2);

        const userMessage = "[Document: cv.pdf]\n\nSenior nurse at the city hospital\n\nSummarise this";

        expect(factEvidence("Senior nurse at the city hospital", 5, { quotablePrompt: "Summarise this", threadId: "t1", userMessage })).toBeUndefined();
        expect(factEvidence("I work as a nurse", 5, { threadId: "t1", userMessage: USER_MESSAGE })).toBeUndefined();
    });

    it("quotes no steered value whose label sits in the prompt, however much steered text comes between", () => {
        expect.assertions(2);

        const prompt = "Remember my wifi password for me";
        const steered = "Sorry, I forgot to add it. Also my dog is called Rex and I like jazz a lot. It is hunter22";
        const userMessage = `${prompt}\n\n${steered}`;
        const turn = { quotablePrompt: prompt, steeredFrom: prompt.length + 2, threadId: "t1", userMessage };

        expect(factEvidence("It is hunter22", 5, turn)).toBeUndefined();
        // A prompt with no label leaves the same steer quotable.
        expect(
            factEvidence("It is hunter22", 5, { ...turn, quotablePrompt: "Plan my week", steeredFrom: 14, userMessage: `Plan my week\n\n${steered}` })?.quote,
        ).toBe("It is hunter22");
    });

    it("quotes no value whose label sits in an earlier steer of a continuation with no prompt", () => {
        expect.assertions(1);

        const userMessage = "Remember my wifi password for me\n\nSorry, I forgot to add it. Also my dog is called Rex and I like jazz a lot. It is hunter22";
        const turn = {
            quotablePrompt: "",
            steeredFrom: 0,
            steers: [
                { at: 200, from: 0 },
                { at: 300, from: 34 },
            ],
            threadId: "t1",
            userMessage,
        };

        expect(factEvidence("It is hunter22", 5, turn)).toBeUndefined();
    });

    it("links a quote to the steer extraction read, not to the part of a long prompt cut before the model saw it", () => {
        expect.assertions(2);

        // A prompt longer than extraction reads, whose cut-off end repeats the steer's words.
        const prompt = `${"Plan my week around the school run. ".repeat(80)}I am vegetarian`;
        const steer = "actually I am vegetarian";
        const userMessage = `${prompt}\n\n${steer}`;
        const steers = [{ at: 300, from: prompt.length + 2, messageId: "s1" }];
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: prompt, steeredFrom: prompt.length + 2, steers, threadId: "t1", userMessage };

        expect(factEvidence("I am vegetarian", 999, turn)?.messageId).toBe("s1");
        expect(factEvidence("I am vegetarian", 999, turn)?.at).toBe(300);
    });

    it("dates a typed quote by the steer that typed it, not by an earlier steer that blockquoted the same words", () => {
        expect.assertions(2);

        const userMessage = "Plan my week\n\n> I am vegetarian\n\nyes, I am vegetarian";
        const steers = [
            { at: 200, from: 14, messageId: "s1" },
            { at: 300, from: 33, messageId: "s2" },
        ];
        const turn = { promptAt: 100, quotablePrompt: "Plan my week", steeredFrom: 14, steers, threadId: "t1", userMessage };

        expect(factEvidence("I am vegetarian", 999, turn)?.at).toBe(300);
        expect(factEvidence("I am vegetarian", 999, turn)?.messageId).toBe("s2");
    });

    it("quotes no steer the user did not type, and still quotes a typed steer delivered beside it", () => {
        expect.assertions(4);

        const marked = "I own a gold mine";
        const typed = "I am vegetarian";
        const userMessage = `Plan my week\n\n${marked}\n\n${typed}`;
        const steers = [
            { at: 200, from: 14, messageId: "s1", notTyped: true },
            { at: 300, from: 14 + marked.length + 2, messageId: "s1" },
        ];
        const turn = { promptAt: 100, quotablePrompt: "Plan my week", steeredFrom: 14, steers, threadId: "t1", userMessage };

        expect(factEvidence(marked, 999, turn)).toBeUndefined();
        expect(factEvidence(typed, 999, turn)).toMatchObject({ at: 300, quote: typed });
        // The marked words repeated by a typed steer are the person's, dated by the steer that typed them.
        expect(
            factEvidence(marked, 999, { ...turn, steers: [...steers, { at: 400, from: userMessage.length + 2 }], userMessage: `${userMessage}\n\n${marked}` })
                ?.at,
        ).toBe(400);
        // Without the mark the same steer is quotable: the mark is what refuses it.
        expect(factEvidence(marked, 999, { ...turn, steers: steers.map(({ notTyped: _notTyped, ...rest }) => rest) })?.quote).toBe(marked);
    });

    it("quotes no sentence that names a health condition, and keeps one that does not", () => {
        expect.assertions(6);

        // A zero-width character inside the word does not hide it.
        expect(evidenceQuote("I have dia\u{200B}betes", "I have dia\u{200B}betes")).toBeUndefined();
        expect(evidenceQuote("I work as a teacher and was diagnosed with diabetes", "I work as a teacher and was diagnosed with diabetes")).toBeUndefined();
        expect(evidenceQuote("Ich bin schwanger", "Ich bin schwanger")).toBeUndefined();
        expect(["I have lupus", "I teach and have hypertension", "my arthritis is back", "I had anaemia"].map((text) => evidenceQuote(text, text))).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
        expect(evidenceQuote("I work as a teacher", "I work as a teacher and was diagnosed with diabetes")).toBe("I work as a teacher");
        // Ordinary words with a medical ending stay quotable.
        expect(evidenceQuote("I work in academia and love osmosis", "I work in academia and love osmosis")).toBe("I work in academia and love osmosis");
    });

    it("dates a quote by when its words were sent, not by when the job ran", () => {
        expect.assertions(5);

        const userMessage = `Plan my week\n\nactually I am vegetarian\n\nand I live in Porto`;
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage };
        const steers = [
            { at: 200, from: 14 },
            { at: 300, from: 40 },
        ];

        expect(factEvidence("Plan my week", 999, turn)?.at).toBe(100);
        // A job scheduled without the steers' times falls back to the time it was given.
        expect(factEvidence("I am vegetarian", 999, turn)?.at).toBe(999);
        expect(factEvidence("I am vegetarian", 999, { ...turn, steers })?.at).toBe(200);
        expect(factEvidence("I live in Porto", 999, { ...turn, steers })?.at).toBe(300);
        // Across two steers: never one phrase, so no quote.
        expect(factEvidence("vegetarian and I live", 999, { ...turn, steers })).toBeUndefined();
    });

    it("dates a quote by the one steer that holds it, and quotes nothing that runs from one steer into the next", () => {
        expect.assertions(4);

        const userMessage = `Plan my week\n\nactually I am vegetarian\n\nand I live in Porto\n\nand I like green tea`;
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage };
        const steers = [
            { at: 200, from: 14 },
            { at: 300, from: 40 },
            { at: 400, from: 61 },
        ];

        expect(factEvidence("vegetarian and I live", 999, { ...turn, steers })).toBeUndefined();
        expect(factEvidence("in Porto and I like", 999, { ...turn, steers })).toBeUndefined();
        expect(factEvidence("I live in Porto", 999, { ...turn, steers })?.at).toBe(300);
        expect(factEvidence("I like green tea", 999, { ...turn, steers })?.at).toBe(400);
    });

    it("quotes nothing from a quoted assistant line in a steer, and quotes the person's own words beside it", () => {
        expect.assertions(2);

        const userMessage = `> the sky is blue today\n\nactually I am vegetarian`;
        const turn = { quotablePrompt: "", steeredFrom: 0, steers: [{ at: 200, from: 0, messageId: "s1" }], threadId: "t1", userMessage };

        expect(factEvidence("the sky is blue today", 999, turn)).toBeUndefined();
        expect(factEvidence("I am vegetarian", 999, turn)).toStrictEqual({ at: 200, messageId: "s1", quote: "I am vegetarian", threadId: "t1" });
    });

    it("quotes a steer sent in an approval continuation, which has no prompt of its own", () => {
        expect.assertions(1);

        // What `afterRun` hands the job when a continuation took one steer: no prompt, the steer from 0, no quotable prompt.
        expect(
            factEvidence("I am vegetarian", 999, {
                quotablePrompt: "",
                steeredFrom: 0,
                steers: [{ at: 200, from: 0, messageId: "s1" }],
                threadId: "t1",
                userMessage: "actually I am vegetarian",
            }),
        ).toStrictEqual({ at: 200, messageId: "s1", quote: "I am vegetarian", threadId: "t1" });
    });

    it("links a quote from a steer to the message that steer was saved in", () => {
        expect.assertions(1);

        const userMessage = `Plan my week\n\nactually I am vegetarian\n\nand I live in Porto`;
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage };
        const steers = [
            { at: 200, from: 14, messageId: "s1" },
            { at: 300, from: 40, messageId: "s2" },
        ];

        expect(factEvidence("I am vegetarian", 999, { ...turn, steers })).toStrictEqual({
            at: 200,
            messageId: "s1",
            quote: "I am vegetarian",
            threadId: "t1",
        });
    });

    it("links a quote to the message of the steer that holds it, and quotes nothing across two steers", () => {
        expect.assertions(3);

        // Two steers were saved in one message ("s2"); a third, in a later message.
        const userMessage = `Plan my week\n\nactually I am vegetarian\n\nand I live in Porto\n\nand I like green tea`;
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage };
        const steers = [
            { at: 200, from: 14, messageId: "s2" },
            { at: 300, from: 40, messageId: "s2" },
            { at: 400, from: 61, messageId: "s3" },
        ];

        expect(factEvidence("I live in Porto", 999, { ...turn, steers })?.messageId).toBe("s2");
        expect(factEvidence("I like green tea", 999, { ...turn, steers })?.messageId).toBe("s3");
        // Across steers, in one message or two: the person never wrote it as one phrase.
        expect(factEvidence("vegetarian and I live", 999, { ...turn, steers })).toBeUndefined();
    });

    it("quotes nothing that starts in one steered message and ends in the next", () => {
        expect.assertions(1);

        const userMessage = `Plan my week\n\nactually I am vegetarian\n\nand I live in Porto`;
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage };
        const steers = [
            { at: 200, from: 14, messageId: "s1" },
            { at: 300, from: 40, messageId: "s2" },
        ];

        expect(factEvidence("vegetarian and I live", 999, { ...turn, steers })).toBeUndefined();
    });

    it("accepts a quote only inside one typed segment, never across a steer the owner did not type", () => {
        expect.assertions(5);

        // Typed steer A, a marked steer, typed steer B: the end of A and the start of B were never written together.
        const a = "I live in Porto";
        const b = "and I love jazz";
        const marked = "I own a gold mine";
        const userMessage = `Plan my week\n\n${a}\n\n${marked}\n\n${b}`;
        const steers = [
            { at: 200, from: 14, messageId: "s1" },
            { at: 300, from: 14 + a.length + 2, messageId: "s2", notTyped: true },
            { at: 400, from: 14 + a.length + marked.length + 4, messageId: "s3" },
        ];
        const turn = { promptAt: 100, quotablePrompt: "Plan my week", steeredFrom: 14, steers, threadId: "t1", userMessage };

        expect(factEvidence("in Porto and I love", 999, turn)).toBeUndefined();
        expect(factEvidence("Porto and I love jazz", 999, turn)).toBeUndefined();
        // Joined with no marked steer between them, the same two steers refuse it too.
        expect(
            factEvidence("in Porto and I love", 999, {
                ...turn,
                steers: [
                    { at: 200, from: 14, messageId: "s1" },
                    { at: 400, from: 14 + a.length + 2, messageId: "s3" },
                ],
                userMessage: `Plan my week\n\n${a}\n\n${b}`,
            }),
        ).toBeUndefined();
        // A quote inside A, or inside B, is still the person's, dated and linked by its own steer.
        expect(factEvidence("I live in Porto", 999, turn)).toStrictEqual({ at: 200, messageId: "s1", quote: "I live in Porto", threadId: "t1" });
        expect(factEvidence("and I love jazz", 999, turn)).toStrictEqual({ at: 400, messageId: "s3", quote: "and I love jazz", threadId: "t1" });
    });

    it("quotes no value typed under a quoted credential question, in a steer or in the prompt", () => {
        expect.assertions(4);

        const steered = `> What is your password?\nhunter22 and I love jazz`;
        const steerTurn = { quotablePrompt: "", steeredFrom: 0, steers: [{ at: 200, from: 0, messageId: "s1" }], threadId: "t1", userMessage: steered };

        expect(factEvidence("hunter22 and I love jazz", 999, steerTurn)).toBeUndefined();
        expect(
            factEvidence("hunter22 and I love jazz", 999, { quotablePrompt: "hunter22 and I love jazz", threadId: "t1", userMessage: steered }),
        ).toBeUndefined();

        // An ordinary short answer under a quoted question keeps its quote: the composer ends a quote with a blank line, and a
        // line straight under it would read as part of the quote (`withoutQuotedLines`).
        const answered = `> Where do you live?\n\nI live in Porto`;

        expect(factEvidence("I live in Porto", 999, { ...steerTurn, userMessage: answered })?.quote).toBe("I live in Porto");
        expect(factEvidence("I live in Porto", 999, { quotablePrompt: "I live in Porto", threadId: "t1", userMessage: answered })?.quote).toBe(
            "I live in Porto",
        );
    });

    it("reads steers labelled with their day as the person's words alone, each quote linked to its own steer", () => {
        expect.assertions(5);

        // As `afterRun` builds it: steers sent on another day than the prompt start with their day, and each offset
        // points at the label.
        const steerTexts = [
            "I fly to Lisbon",
            "[sent on 2026-11-18] and no nuts",
            "[sent on 2026-11-18] I am vegetarian now",
            "[sent on 2026-11-18] > I am a pilot\nok",
        ];
        const userMessage = ["Plan my week", ...steerTexts].join("\n\n");
        let from = "Plan my week".length + 2;
        const steers = steerTexts.map((text, index) => {
            const offset = { at: 200 + index, from, messageId: `s${String(index + 1)}` };

            from += text.length + 2;

            return offset;
        });
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, steers, threadId: "t1", userMessage };

        expect(factEvidence("I am vegetarian", 999, turn)).toStrictEqual({ at: 202, messageId: "s3", quote: "I am vegetarian", threadId: "t1" });
        expect(factEvidence("I fly to Lisbon", 999, turn)).toMatchObject({ at: 200, messageId: "s1" });
        // The label is the app's, never a quote.
        expect(factEvidence("[sent on 2026-11-18] I am vegetarian", 999, turn)).toBeUndefined();
        expect(factEvidence("sent on 2026-11-18", 999, turn)).toBeUndefined();
        // A labelled steer that opens with a blockquote still quotes nothing from it.
        expect(factEvidence("I am a pilot", 999, turn)).toBeUndefined();
    });

    it("links no message for a steer that carries none", () => {
        expect.assertions(1);

        const userMessage = `Plan my week\n\nactually I am vegetarian`;
        const turn = { promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage };

        expect(factEvidence("I am vegetarian", 5, { ...turn, steers: [{ at: 200, from: 14 }] })).toStrictEqual({
            at: 200,
            quote: "I am vegetarian",
            threadId: "t1",
        });
    });

    it("dates a quote by the steer that holds it whole, not by an earlier pair of steers that only run together into it", () => {
        expect.assertions(2);

        // The words run across the first two steers (no quote there), then appear whole in the third.
        const userMessage = `Plan my week\n\nI am vegetarian\n\nand I live in Porto\n\nvegetarian and I live in Porto, as I said`;
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage };
        const steers = [
            { at: 200, from: 14 },
            { at: 300, from: 31 },
            { at: 400, from: 52 },
        ];
        const evidence = factEvidence("vegetarian and I live", 999, { ...turn, steers });

        expect(evidence?.quote).toBe("vegetarian and I live");
        expect(evidence?.at).toBe(400);
    });

    it("quotes the first steer that holds the words, in the casing that steer has", () => {
        expect.assertions(2);

        // Each steer is read on its own: the first one holds the words, so it quotes and dates them, whatever the later steer's casing.
        const userMessage = `Plan my week\n\nI am VEGETARIAN\n\nvegetarian in İzmir`;
        const turn = { promptAt: 100, promptMessageId: "m1", quotablePrompt: "Plan my week", steeredFrom: 14, threadId: "t1", userMessage };
        const steers = [
            { at: 200, from: 14 },
            { at: 300, from: 31 },
        ];
        const evidence = factEvidence("vegetarian", 999, { ...turn, steers });

        expect(evidence?.quote).toBe("VEGETARIAN");
        expect(evidence?.at).toBe(200);
    });
});

describe(newestEvidence, () => {
    it("takes the evidence said last", () => {
        expect.assertions(1);

        const rows = [
            { _creationTime: 1, evidence: { at: 10, quote: "old" } },
            { _creationTime: 3, evidence: { at: 20, quote: "newer" } },
            { _creationTime: 4 },
        ];

        expect(newestEvidence(rows)).toStrictEqual({ at: 20, quote: "newer" });
    });
});

describe(compressedEvidenceSources, () => {
    const inputs: ThreadMemory[] = [
        { _id: "a", memory: "A", type: "identity" },
        { _id: "b", memory: "B", type: "identity" },
    ];

    it("names the inputs a fact was built from, with the text the synthesis read", () => {
        expect.assertions(1);

        expect(compressedEvidenceSources([1, 2], inputs)).toStrictEqual([
            { id: "a", memory: "A" },
            { id: "b", memory: "B" },
        ]);
    });

    it("names nothing when a fact names no valid input", () => {
        expect.assertions(2);

        expect(compressedEvidenceSources([0, 7], inputs)).toStrictEqual([]);
        expect(compressedEvidenceSources(undefined, inputs)).toStrictEqual([]);
    });
});
