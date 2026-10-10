import { describe, expect, it } from "vitest";

import classifyQuery from "./query-classifier";

describe("classifyQuery", () => {
    describe("direct_answer classifications", () => {
        it("classifies greetings as direct_answer", () => {
            const result = classifyQuery("hello", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.confidence).toBeGreaterThanOrEqual(0.8);
            expect(result.reason).toBe("greeting");
        });

        it("classifies 'hi there' as direct_answer", () => {
            const result = classifyQuery("Hi there", "web");

            expect(result.classification).toBe("direct_answer");
        });

        it("classifies 'good morning' as direct_answer", () => {
            const result = classifyQuery("Good morning", "web");

            expect(result.classification).toBe("direct_answer");
        });

        it("classifies math expressions as direct_answer", () => {
            const result = classifyQuery("2 + 2", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("math_expression");
        });

        it("classifies 'what is 5 * 3' as direct_answer", () => {
            const result = classifyQuery("what is 5 * 3", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("math_query");
        });

        it("classifies 'calculate 100 / 4' as direct_answer", () => {
            const result = classifyQuery("calculate 100 / 4", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("math_query");
        });

        it("classifies concept explanations as direct_answer", () => {
            const result = classifyQuery("explain recursion", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("cs_concept");
        });

        it("classifies 'what is polymorphism' as direct_answer", () => {
            const result = classifyQuery("what is polymorphism", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("cs_concept");
        });

        it("classifies code generation requests as direct_answer", () => {
            const result = classifyQuery("write a function to sort an array", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("code_generation");
        });

        it("classifies 'create a React component' as direct_answer", () => {
            const result = classifyQuery("create a React component for a button", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("code_generation");
        });

        it("classifies code howto queries as direct_answer", () => {
            const result = classifyQuery("how do I use async/await in JavaScript", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("code_howto");
        });

        it("classifies translation requests as direct_answer", () => {
            const result = classifyQuery("translate hello world to French", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("translation");
        });

        it("classifies creative requests as direct_answer", () => {
            const result = classifyQuery("tell me a joke about programming", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("creative_request");
        });

        it("classifies summarize requests as direct_answer", () => {
            const result = classifyQuery("summarize the key points of object-oriented programming", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("text_transform");
        });

        it("classifies short non-factual questions as direct_answer", () => {
            const result = classifyQuery("why?", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("short_question");
        });

        it("classifies empty queries as ambiguous", () => {
            const result = classifyQuery("", "web");

            expect(result.classification).toBe("ambiguous");
            expect(result.confidence).toBe(0.5);
            expect(result.reason).toBe("empty_query");
        });

        it("classifies whitespace-only as ambiguous", () => {
            const result = classifyQuery(" ".repeat(3), "web");

            expect(result.classification).toBe("ambiguous");
            expect(result.reason).toBe("empty_query");
        });

        it("classifies very short messages as direct_answer", () => {
            const result = classifyQuery("ok", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("short_message");
        });
    });

    describe("search_required classifications", () => {
        it("classifies queries with 'latest' as search_required", () => {
            const result = classifyQuery("latest news about AI regulation", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("time_sensitive");
        });

        it("classifies queries with 'today' as search_required", () => {
            const result = classifyQuery("what happened today in tech", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("time_sensitive");
        });

        it("classifies queries with recent year references as search_required", () => {
            const result = classifyQuery("best programming languages 2026", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("recent_year_reference");
        });

        it("classifies stock price queries as search_required", () => {
            const result = classifyQuery("price of Bitcoin", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("market_data");
        });

        it("classifies 'how much does X cost' as search_required", () => {
            const result = classifyQuery("how much does a Tesla Model 3 cost", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("pricing_query");
        });

        it("classifies 'who is' queries as search_required", () => {
            const result = classifyQuery("who is the CEO of OpenAI", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("entity_lookup");
        });

        it("classifies URL-containing queries as search_required", () => {
            const result = classifyQuery("summarize https://example.com/article", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("url_reference");
        });

        it("classifies comparison queries as search_required", () => {
            const result = classifyQuery("compare React vs Vue for enterprise apps", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("comparison_query");
        });

        it("classifies weather queries as search_required", () => {
            const result = classifyQuery("what's the weather in Berlin", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("weather_query");
        });

        it("classifies breaking news queries as search_required", () => {
            const result = classifyQuery("breaking news about the election", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("time_sensitive");
        });

        it("classifies product review queries as search_required", () => {
            const result = classifyQuery("best laptop review for developers", "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("comparison_query");
        });
    });

    describe("search mode handling", () => {
        it("always returns search_required for stocks mode", () => {
            const result = classifyQuery("hello", "stocks");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("specialized_mode");
        });

        it("always returns search_required for crypto mode", () => {
            const result = classifyQuery("explain blockchain", "crypto");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("specialized_mode");
        });

        it("always returns search_required for spotify mode", () => {
            const result = classifyQuery("hi", "spotify");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("specialized_mode");
        });

        it("always returns search_required for youtube mode", () => {
            const result = classifyQuery("thanks", "youtube");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("specialized_mode");
        });

        it("returns direct_answer for chat mode", () => {
            const result = classifyQuery("latest news about AI", "chat");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("chat_mode");
        });

        it("classifies normally for web mode", () => {
            const result = classifyQuery("explain recursion", "web");

            expect(result.classification).toBe("direct_answer");
        });

        it("classifies normally for academic mode", () => {
            const result = classifyQuery("explain recursion", "academic");

            expect(result.classification).toBe("direct_answer");
        });

        it("classifies normally for reddit mode", () => {
            const result = classifyQuery("hello", "reddit");

            expect(result.classification).toBe("direct_answer");
        });
    });

    describe("ambiguous classifications", () => {
        it("classifies general questions as ambiguous", () => {
            const result = classifyQuery("tell me about the history of programming languages", "web");

            expect(result.classification).toBe("ambiguous");
            expect(result.reason).toBe("no_clear_signal");
        });

        it("classifies medium-length statements as ambiguous", () => {
            const result = classifyQuery("tell me about machine learning applications in healthcare", "web");

            expect(result.classification).toBe("ambiguous");
        });

        it("classifies factual short questions with 'who' as not direct_answer", () => {
            const result = classifyQuery("who?", "web");

            // "who" looks factual, so should not be classified as direct_answer
            expect(result.classification).not.toBe("direct_answer");
        });
    });

    describe("confidence levels", () => {
        it("returns high confidence for clear direct_answer patterns", () => {
            const result = classifyQuery("2 + 2", "web");

            expect(result.confidence).toBeGreaterThanOrEqual(0.9);
        });

        it("returns high confidence for clear search_required patterns", () => {
            const result = classifyQuery("latest news about AI", "web");

            expect(result.confidence).toBeGreaterThanOrEqual(0.9);
        });

        it("returns low confidence for ambiguous queries", () => {
            const result = classifyQuery("tell me about machine learning", "web");

            expect(result.confidence).toBeLessThanOrEqual(0.6);
        });

        it("returns 1.0 confidence for specialized modes", () => {
            const result = classifyQuery("anything", "stocks");

            expect(result.confidence).toBe(1);
        });
    });

    describe("search_required takes priority over direct_answer", () => {
        it("search patterns override greeting if query has time markers", () => {
            // "hello, what's the latest on AI?" — has both greeting and time-sensitive
            const result = classifyQuery("hello, what are the latest developments in AI", "web");

            expect(result.classification).toBe("search_required");
        });

        it("URL presence overrides code-like patterns", () => {
            const result = classifyQuery("explain what this code does https://github.com/example", "web");

            expect(result.classification).toBe("search_required");
        });
    });

    describe("edge cases", () => {
        it("handles queries with only special characters", () => {
            const result = classifyQuery("???", "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("short_question");
        });

        it("handles very long queries", () => {
            const longQuery = `I want to understand ${"the concept of ".repeat(50)}recursion`;
            const result = classifyQuery(longQuery, "web");

            // Should still work without errors
            expect(["direct_answer", "search_required", "ambiguous"]).toContain(result.classification);
        });

        it("handles queries with mixed case", () => {
            const result = classifyQuery("EXPLAIN RECURSION", "web");

            expect(result.classification).toBe("direct_answer");
        });

        it("handles queries with unicode", () => {
            const result = classifyQuery("what is 日本語?", "web");

            // Should handle gracefully
            expect(["direct_answer", "ambiguous"]).toContain(result.classification);
        });
    });

    // ── Multilingual support ────────────────────────────────────────────

    describe("multilingual greetings", () => {
        it.each([
            ["German", "Hallo"],
            ["German", "Guten Morgen"],
            ["German", "Danke"],
            ["Spanish", "Hola"],
            ["Spanish", "Buenos días"],
            ["Spanish", "Gracias"],
            ["French", "Bonjour"],
            ["French", "Salut"],
            ["French", "Merci"],
            ["Portuguese", "Olá"],
            ["Portuguese", "Bom dia"],
            ["Portuguese", "Obrigado"],
            ["Italian", "Ciao"],
            ["Italian", "Buongiorno"],
            ["Italian", "Grazie"],
            ["Russian", "Привет"],
            ["Russian", "Здравствуйте"],
            ["Russian", "Спасибо"],
            ["Chinese", "你好"],
            ["Chinese", "谢谢"],
            ["Japanese", "こんにちは"],
            ["Japanese", "ありがとう"],
            ["Korean", "안녕하세요"],
            ["Korean", "감사합니다"],
            ["Hindi", "नमस्ते"],
            ["Arabic", "مرحبا"],
            ["Turkish", "Merhaba"],
            ["Turkish", "Teşekkürler"],
            ["Polish", "Cześć"],
            ["Polish", "Dziękuję"],
            ["Dutch", "Hoi"],
            ["Swedish", "Hej"],
            ["Czech", "Ahoj"],
            ["Ukrainian", "Привіт"],
            ["Vietnamese", "Xin chào"],
            ["Thai", "สวัสดี"],
            ["Indonesian", "Selamat pagi"],
            ["Hebrew", "שלום"],
            ["Swahili", "Jambo"],
        ])("classifies %s greeting '%s' as direct_answer", (_language, greeting) => {
            const result = classifyQuery(greeting, "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("greeting");
        });
    });

    describe("multilingual time-sensitive markers", () => {
        it.each([
            ["German", "neueste Nachrichten über KI"],
            ["German", "Was ist heute passiert"],
            ["Spanish", "últimas noticias sobre IA"],
            ["Spanish", "¿Qué pasó hoy?"],
            ["French", "dernières nouvelles sur l'IA"],
            ["French", "Qu'est-ce qui s'est passé aujourd'hui"],
            ["Russian", "последние новости об ИИ"],
            ["Russian", "Что произошло сегодня"],
            ["Chinese", "最新的AI新闻"],
            ["Chinese", "今天发生了什么"],
            ["Japanese", "最新のAIニュース"],
            ["Japanese", "今日何があった"],
            ["Korean", "최신 AI 뉴스"],
            ["Korean", "오늘 무슨 일이 있었나요"],
            ["Turkish", "en son AI haberleri"],
            ["Polish", "najnowsze wiadomości o AI"],
            ["Dutch", "nieuwste AI nieuws"],
            ["Vietnamese", "tin tức mới nhất về AI"],
            ["Indonesian", "berita terbaru tentang AI"],
        ])("classifies %s time-sensitive query '%s' as search_required", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("search_required");
        });
    });

    describe("multilingual weather queries", () => {
        it.each([
            ["German", "Wetter in Berlin"],
            ["Spanish", "clima en Madrid"],
            ["French", "météo à Paris"],
            ["Russian", "погода в Москве"],
            ["Chinese", "北京天气"],
            ["Japanese", "東京の天気"],
            ["Korean", "서울 날씨"],
            ["Turkish", "İstanbul hava durumu"],
            ["Polish", "pogoda w Warszawie"],
            ["Dutch", "weer in Amsterdam"],
            ["Italian", "meteo Roma"],
            ["Portuguese", "clima em Lisboa"],
            ["Thai", "อากาศกรุงเทพ"],
            ["Vietnamese", "thời tiết Hà Nội"],
            ["Indonesian", "cuaca Jakarta"],
        ])("classifies %s weather query '%s' as search_required", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("weather_query");
        });
    });

    describe("multilingual code generation", () => {
        it.each([
            ["German", "Schreibe eine Funktion zum Sortieren"],
            ["German", "Erstelle eine Klasse für Benutzer"],
            ["Spanish", "Escribe una función para ordenar"],
            ["Spanish", "Crea una clase para usuarios"],
            ["French", "Écris une fonction de tri"],
            ["French", "Crée un composant React"],
        ])("classifies %s code generation '%s' as direct_answer", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("code_generation");
        });
    });

    describe("multilingual code howto", () => {
        it.each([
            ["German", "Wie kann man async/await in JavaScript verwenden"],
            ["Spanish", "Cómo puedo usar TypeScript con React"],
            ["French", "Comment utiliser les hooks React"],
        ])("classifies %s code howto '%s' as direct_answer", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("code_howto");
        });
    });

    describe("multilingual math queries", () => {
        it.each([
            ["German", "Was ist 5 mal 3"],
            ["German", "Berechne 100 geteilt durch 4"],
            ["Spanish", "Qué es 5 más 3"],
            ["French", "Combien fait 12 fois 3"],
        ])("classifies %s math query '%s' as direct_answer", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("math_query");
        });
    });

    describe("multilingual creative requests", () => {
        it.each([
            ["German", "Erzähl mir einen Witz"],
            ["Spanish", "Cuéntame un chiste"],
            ["French", "Raconte-moi une blague"],
        ])("classifies %s creative request '%s' as direct_answer", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("creative_request");
        });
    });

    describe("multilingual text transforms", () => {
        it.each([
            ["German", "Zusammenfassen der wichtigsten Punkte"],
            ["Spanish", "Resumir los puntos principales"],
            ["French", "Résumer les points clés"],
            ["Portuguese", "Resumir os pontos principais"],
            ["Italian", "Riassumere i punti chiave"],
        ])("classifies %s text transform '%s' as direct_answer", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("text_transform");
        });
    });

    describe("multilingual market data", () => {
        it.each([
            ["German", "Preis von Bitcoin"],
            ["German", "Aktienkurs von Apple"],
            ["Spanish", "Precio de Bitcoin"],
            ["French", "Prix de Bitcoin"],
        ])("classifies %s market query '%s' as search_required", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("market_data");
        });
    });

    describe("multilingual pricing queries", () => {
        it.each([
            ["German", "Wie viel kostet ein Tesla Model 3"],
            ["Spanish", "Cuánto cuesta un iPhone"],
            ["French", "Combien coûte un MacBook"],
        ])("classifies %s pricing query '%s' as search_required", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("pricing_query");
        });
    });

    describe("multilingual entity lookup", () => {
        it.each([
            ["German", "Wer ist der CEO von OpenAI"],
            ["Spanish", "Quién es el presidente de España"],
            ["French", "Qui est le président de la France"],
        ])("classifies %s entity query '%s' as search_required", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("entity_lookup");
        });
    });

    describe("multilingual factual question heuristic", () => {
        it.each([
            ["German", "wer?"],
            ["Spanish", "quién?"],
            ["French", "qui?"],
            ["Korean", "누구?"],
        ])("classifies %s factual question '%s' as not direct_answer", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).not.toBe("direct_answer");
        });
    });

    describe("multilingual search verb heuristic", () => {
        it.each([
            ["German", "suche AI"],
            ["Spanish", "buscar IA"],
            ["French", "chercher IA"],
            ["Russian", "найди ИИ"],
        ])("classifies %s search verb '%s' as ambiguous (not short_message)", (_language, query) => {
            const result = classifyQuery(query, "web");

            // Should NOT be classified as "short_message" because it contains a search verb
            if (result.reason === "short_message") {
                expect.fail(`"${query}" should not be classified as short_message`);
            }
        });
    });

    describe("multilingual translation requests", () => {
        it.each([
            ["German", "Übersetze Hallo auf Spanisch"],
            ["Spanish", "Traduce hola al francés"],
            ["French", "Traduis bonjour en allemand"],
        ])("classifies %s translation '%s' as direct_answer", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("translation");
        });
    });

    describe("multilingual concept explanations", () => {
        it.each([
            ["German", "Erkläre den Unterschied zwischen SQL und NoSQL"],
            ["Spanish", "Explica el concepto de herencia en programación"],
            ["French", "Explique la différence entre REST et GraphQL"],
        ])("classifies %s concept explanation '%s' as direct_answer", (_language, query) => {
            const result = classifyQuery(query, "web");

            expect(result.classification).toBe("direct_answer");
            expect(result.reason).toBe("concept_explanation");
        });
    });

    describe("writing mode", () => {
        it("classifies any query in writing mode as direct_answer", () => {
            const result = classifyQuery("latest news about AI", "writing");

            expect(result.classification).toBe("direct_answer");
            expect(result.confidence).toBe(1);
            expect(result.reason).toBe("chat_mode");
        });

        it("classifies time-sensitive query in writing mode as direct_answer", () => {
            const result = classifyQuery("what happened today", "writing");

            expect(result.classification).toBe("direct_answer");
        });
    });

    describe("wolfram mode", () => {
        it("classifies any query in wolfram mode as search_required", () => {
            const result = classifyQuery("integrate x^2 dx", "wolfram");

            expect(result.classification).toBe("search_required");
            expect(result.confidence).toBe(1);
            expect(result.reason).toBe("specialized_mode");
        });

        it("classifies simple query in wolfram mode as search_required", () => {
            const result = classifyQuery("hello", "wolfram");

            expect(result.classification).toBe("search_required");
            expect(result.reason).toBe("specialized_mode");
        });
    });

    // `"convert" + 50k spaces + "x"` took 63s here, on a request path with no
    // length cap. The trailing character matters: `classifyQuery` trims, so pure
    // trailing padding never reaches the patterns — interior padding does.
    //
    // If someone widens a `\s` back to `\s+` next to a wildcard that also matches
    // whitespace, this is what catches it.
    describe("pathological input", () => {
        it.each([
            ["translation", "translate"],
            ["conversion", "convert"],
            ["code generation", "write"],
        ])(
            "classifies a %s prefix padded with interior whitespace in well under a second",
            (_label, prefix) => {
                const started = performance.now();

                classifyQuery(`${prefix}${" ".repeat(20_000)}x`, "web");

                // One second, matching what this test's own name claims. The
                // failure being guarded against is catastrophic backtracking,
                // which on 20k characters takes seconds to minutes — so a
                // second-scale bound catches it just as reliably as the 100ms
                // that was here, and does not also fail whenever the machine is
                // busy (observed at 246ms with no code change).
                expect(performance.now() - started).toBeLessThan(1000);
            },
            30_000,
        );
    });
});
