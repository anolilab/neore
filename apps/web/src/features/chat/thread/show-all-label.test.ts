/**
 * The "Show all earlier messages" control's label, through the compiled catalogs: one earlier message reads
 * in the singular, more in the plural, in every locale's own plural forms.
 */
import { createHash } from "node:crypto";

import type { Messages } from "@lingui/core";
import { setupI18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

const SOURCE = "{earlierCount, plural, one {Show # earlier message} other {Show all # earlier messages}}";

const catalogs = import.meta.glob<{ messages: Messages }>("../../../locales/*/messages.js", { eager: true });

const LOCALE_OF = /locales\/([^/]+)\/messages\.js$/u;

/** The id Lingui gives a message without a context. */
const ID = createHash("sha256").update(`${SOURCE}\u{1F}`).digest("base64url").slice(0, 6);

const label = (locale: string, earlierCount: number): string => {
    const catalog = catalogs[`../../../locales/${locale}/messages.js`];

    if (!catalog) {
        throw new Error(`No compiled catalog for ${locale}`);
    }

    return setupI18n({ locale, messages: { [locale]: catalog.messages } })._({ id: ID, message: SOURCE, values: { earlierCount } });
};

describe("show all earlier messages label", () => {
    it("reads in the singular for one message and the plural for more", () => {
        expect(label("en", 1)).toBe("Show 1 earlier message");
        expect(label("en", 170)).toBe("Show all 170 earlier messages");
        expect(label("de", 1)).toBe("1 frühere Nachricht anzeigen");
        expect(label("de", 170)).toBe("Alle 170 früheren Nachrichten anzeigen");
    });

    it("uses each locale's plural forms", () => {
        expect(label("pl", 1)).toBe("Pokaż 1 wcześniejszą wiadomość");
        expect(label("pl", 3)).toBe("Pokaż wszystkie 3 wcześniejsze wiadomości");
        expect(label("pl", 170)).toBe("Pokaż wszystkie 170 wcześniejszych wiadomości");
        expect(label("ja", 1)).toBe("以前のメッセージ1件をすべて表示");
    });

    it("is translated in every locale", () => {
        for (const [path, catalog] of Object.entries(catalogs)) {
            expect(catalog.messages[ID], LOCALE_OF.exec(path)?.[1]).toBeDefined();
        }
    });
});
