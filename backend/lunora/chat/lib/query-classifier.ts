/**
 * Query Classifier
 * @deprecated Use the unified classification from the LLM Gateway's
 * `/internal/route` endpoint (classification.searchMode) instead.
 * This file is kept for backward compatibility during the migration.
 * See: services/llm-gateway/src/routing/classify.ts
 *
 * Lightweight heuristic-based classifier that determines whether a query
 * actually needs web search or can be answered from LLM knowledge alone.
 *
 * This saves API costs (Tavily/Exa calls) and reduces response latency
 * by 1-3 seconds for queries that don't benefit from web search.
 *
 * Supports all 123 languages from the composer language picker.
 *
 * Categories:
 * - "search_required": Query needs real-time / external web data
 * - "direct_answer": LLM can answer from training data
 * - "ambiguous": Default to using search (safe fallback)
 */
import type { SearchMode } from "./tool-builder";

const WHITESPACE_RE = /\s+/;

export type QueryClassification = "search_required" | "direct_answer" | "ambiguous";

export interface ClassificationResult {
    classification: QueryClassification;
    confidence: number;
    reason: string;
}

// ---------------------------------------------------------------------------
// Multilingual keyword sets
// ---------------------------------------------------------------------------

// Greetings across supported languages (covers ~95% of user base)
// Format: word boundaries are handled by the regex builder
const GREETING_WORDS = [
    // English
    "hi",
    "hello",
    "hey",
    "howdy",
    "thanks",
    "thank you",
    "bye",
    "goodbye",
    // German (de)
    "hallo",
    "guten morgen",
    "guten tag",
    "guten abend",
    "danke",
    "tschüss",
    "auf wiedersehen",
    "tschuess",
    // Spanish (es)
    "hola",
    "buenos días",
    "buenas tardes",
    "buenas noches",
    "gracias",
    "adiós",
    "buenos dias",
    "adios",
    // French (fr)
    "bonjour",
    "bonsoir",
    "salut",
    "merci",
    "au revoir",
    "coucou",
    // Portuguese (pt)
    "olá",
    "oi",
    "bom dia",
    "boa tarde",
    "boa noite",
    "obrigado",
    "obrigada",
    "tchau",
    "ola",
    // Italian (it)
    "ciao",
    "buongiorno",
    "buonasera",
    "buonanotte",
    "grazie",
    "arrivederci",
    // Dutch (nl)
    "hoi",
    "hallo",
    "goedemorgen",
    "goedemiddag",
    "goedenavond",
    "dank je",
    "dag",
    "doei",
    // Russian (ru)
    "привет",
    "здравствуйте",
    "добрый день",
    "доброе утро",
    "добрый вечер",
    "спасибо",
    "пока",
    "до свидания",
    // Arabic (ar)
    "مرحبا",
    "السلام عليكم",
    "صباح الخير",
    "مساء الخير",
    "شكرا",
    "مع السلامة",
    // Chinese (zh)
    "你好",
    "早上好",
    "下午好",
    "晚上好",
    "谢谢",
    "再见",
    // Japanese (ja)
    "こんにちは",
    "おはよう",
    "こんばんは",
    "ありがとう",
    "さようなら",
    "おはようございます",
    // Korean (ko)
    "안녕하세요",
    "안녕",
    "감사합니다",
    "고마워",
    "안녕히 가세요",
    // Hindi (hi)
    "नमस्ते",
    "धन्यवाद",
    "शुक्रिया",
    "अलविदा",
    // Turkish (tr)
    "merhaba",
    "selam",
    "günaydın",
    "iyi akşamlar",
    "teşekkürler",
    "hoşça kal",
    "gunaydin",
    "hosca kal",
    "tesekkurler",
    // Polish (pl)
    "cześć",
    "dzień dobry",
    "dobry wieczór",
    "dziękuję",
    "do widzenia",
    "czesc",
    "dziekuje",
    // Czech (cs)
    "ahoj",
    "dobrý den",
    "dobré ráno",
    "děkuji",
    "na shledanou",
    "dobry den",
    "dekuji",
    // Swedish (sv)
    "hej",
    "god morgon",
    "god kväll",
    "tack",
    "hejdå",
    "god kvall",
    "hejda",
    // Danish (da)
    "hej",
    "god morgen",
    "god aften",
    "tak",
    "farvel",
    // Norwegian (no)
    "hei",
    "god morgen",
    "god kveld",
    "takk",
    "ha det",
    // Finnish (fi)
    "hei",
    "moi",
    "huomenta",
    "kiitos",
    "näkemiin",
    "nakemiin",
    // Hungarian (hu)
    "szia",
    "jó napot",
    "jó reggelt",
    "jó estét",
    "köszönöm",
    "viszlát",
    "jo napot",
    "koszonom",
    // Romanian (ro)
    "bună",
    "bună ziua",
    "bună seara",
    "mulțumesc",
    "la revedere",
    "buna",
    "multumesc",
    // Ukrainian (uk)
    "привіт",
    "доброго дня",
    "добрий ранок",
    "дякую",
    "до побачення",
    // Bulgarian (bg)
    "здравей",
    "добро утро",
    "добър ден",
    "благодаря",
    "довиждане",
    // Croatian/Serbian/Bosnian (hr/sr/bs)
    "zdravo",
    "dobar dan",
    "dobro jutro",
    "hvala",
    "doviđenja",
    "dovidenja",
    // Slovak (sk)
    "ahoj",
    "dobrý deň",
    "ďakujem",
    "dovidenia",
    "dobry den",
    "dakujem",
    // Slovenian (sl)
    "živjo",
    "dober dan",
    "dobro jutro",
    "hvala",
    "nasvidenje",
    "zivjo",
    // Greek (el)
    "γεια σου",
    "καλημέρα",
    "καλησπέρα",
    "ευχαριστώ",
    "αντίο",
    // Thai (th)
    "สวัสดี",
    "ขอบคุณ",
    "ลาก่อน",
    // Vietnamese (vi)
    "xin chào",
    "cảm ơn",
    "tạm biệt",
    "chào",
    // Indonesian/Malay (id/ms)
    "halo",
    "selamat pagi",
    "selamat siang",
    "selamat malam",
    "terima kasih",
    "sampai jumpa",
    // Bengali (bn)
    "নমস্কার",
    "ধন্যবাদ",
    // Urdu (ur)
    "سلام",
    "شکریہ",
    "خدا حافظ",
    // Persian (fa)
    "سلام",
    "صبح بخیر",
    "ممنون",
    "خداحافظ",
    // Hebrew (he)
    "שלום",
    "בוקר טוב",
    "ערב טוב",
    "תודה",
    "להתראות",
    // Swahili (sw)
    "jambo",
    "habari",
    "asante",
    "kwaheri",
    // Catalan (ca)
    "hola",
    "bon dia",
    "bona tarda",
    "gràcies",
    "adéu",
    "gracies",
    "adeu",
    // Afrikaans (af)
    "hallo",
    "goeie môre",
    "dankie",
    "totsiens",
    "goeie more",
];

/**
 * Escape regex special characters in a string.
 */
const escapeRegex = (s: string): string => s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// Regex to detect CJK, Thai, Arabic, Hebrew characters (scripts without space-delimited words)
const NON_SPACE_DELIMITED = /[\u{3000}-\u{9FFF}\u{F900}-\u{FAFF}\u{E00}-\u{E7F}\u{600}-\u{6FF}\u{590}-\u{5FF}\u{AC00}-\u{D7AF}\u{1100}-\u{11FF}]/u;

/**
 * Build a regex that matches any of the given words with Unicode-safe boundaries.
 * - Latin/Cyrillic words use (?:^|\s) and (?:\s|[?!.,;:]|$) instead of \b
 * - CJK/Thai/Arabic/Hebrew words match anywhere (these scripts don't use spaces between words).
 */
const buildWordBoundaryPattern = (words: string[], flags: string, anchor?: "start"): RegExp => {
    const spacedWords: string[] = [];
    const nonSpacedWords: string[] = [];

    for (const w of words) {
        if (NON_SPACE_DELIMITED.test(w)) {
            nonSpacedWords.push(w);
        } else {
            spacedWords.push(w);
        }
    }

    const parts: string[] = [];

    if (spacedWords.length > 0) {
        const escaped = spacedWords.map((item) => escapeRegex(item)).join("|");
        const prefix = anchor === "start" ? "^" : String.raw`(?:^|\s)`;

        parts.push(String.raw`${prefix}(${escaped})(?:\s|[?!.,;:]|$)`);
    }

    if (nonSpacedWords.length > 0) {
        // For non-space-delimited scripts, match the word anywhere in the string
        const escaped = nonSpacedWords.map((item) => escapeRegex(item)).join("|");

        parts.push(`(${escaped})`);
    }

    return new RegExp(parts.join("|"), flags);
};

// Build a single greeting regex from all words (anchored at start of string)
const GREETING_PATTERN = buildWordBoundaryPattern(GREETING_WORDS, "iu", "start");

// "good morning/afternoon/evening" pattern kept separate for English
const GOOD_TIME_PATTERN = /^good\s+(morning|afternoon|evening)\b/i;

// Time-sensitive markers across languages
const TIME_SENSITIVE_WORDS = [
    // English
    "latest",
    "newest",
    "recent",
    "current",
    "today",
    "yesterday",
    "right now",
    "breaking",
    "this week",
    "this month",
    "this year",
    "just released",
    "just announced",
    "just happened",
    // German
    "aktuell",
    "neueste",
    "neuesten",
    "heute",
    "gestern",
    "diese woche",
    "diesen monat",
    "dieses jahr",
    "gerade",
    // Spanish
    "último",
    "últimas",
    "reciente",
    "actual",
    "hoy",
    "ayer",
    "esta semana",
    "este mes",
    "este año",
    "ultimo",
    "ultimas",
    // French
    "dernier",
    "dernière",
    "récent",
    "actuel",
    "aujourd'hui",
    "hier",
    "cette semaine",
    "ce mois",
    "derniere",
    "recent",
    // Portuguese
    "último",
    "mais recente",
    "atual",
    "hoje",
    "ontem",
    "esta semana",
    "este mês",
    "este ano",
    "ultimo",
    "este mes",
    // Italian
    "ultimo",
    "più recente",
    "attuale",
    "oggi",
    "ieri",
    "questa settimana",
    "questo mese",
    "quest'anno",
    "piu recente",
    // Russian
    "последний",
    "последние",
    "новейший",
    "актуальный",
    "сегодня",
    "вчера",
    "на этой неделе",
    // Chinese
    "最新",
    "最近",
    "今天",
    "昨天",
    "本周",
    "本月",
    "今年",
    // Japanese
    "最新",
    "最近",
    "今日",
    "昨日",
    "今週",
    "今月",
    "今年",
    // Korean
    "최신",
    "최근",
    "오늘",
    "어제",
    "이번 주",
    "이번 달",
    "올해",
    // Arabic
    "أحدث",
    "أخير",
    "اليوم",
    "أمس",
    "هذا الأسبوع",
    // Hindi
    "नवीनतम",
    "हाल का",
    "आज",
    "कल",
    // Turkish
    "en son",
    "son",
    "güncel",
    "bugün",
    "dün",
    "bu hafta",
    "bu ay",
    // Polish
    "najnowszy",
    "najnowsze",
    "aktualny",
    "dzisiaj",
    "wczoraj",
    "w tym tygodniu",
    // Dutch
    "nieuwste",
    "laatste",
    "actueel",
    "vandaag",
    "gisteren",
    "deze week",
    // Swedish
    "senaste",
    "nyaste",
    "aktuell",
    "idag",
    "igår",
    "denna vecka",
    "igar",
    // Czech
    "nejnovější",
    "aktuální",
    "dnes",
    "včera",
    "tento týden",
    "nejnovejsi",
    "aktualni",
    "vcera",
    // Ukrainian
    "останній",
    "найновіший",
    "сьогодні",
    "вчора",
    // Vietnamese
    "mới nhất",
    "gần đây",
    "hôm nay",
    "hôm qua",
    // Thai
    "ล่าสุด",
    "วันนี้",
    "เมื่อวาน",
    // Indonesian
    "terbaru",
    "terkini",
    "hari ini",
    "kemarin",
    "minggu ini",
];

const TIME_SENSITIVE_PATTERN = buildWordBoundaryPattern(TIME_SENSITIVE_WORDS, "iu");

// Weather words across languages
const WEATHER_WORDS = [
    // English
    "weather",
    "temperature",
    "forecast",
    "rain",
    "snow",
    "humid",
    // German
    "wetter",
    "temperatur",
    "vorhersage",
    "regen",
    "schnee",
    // Spanish
    "clima",
    "tiempo",
    "temperatura",
    "pronóstico",
    "lluvia",
    "nieve",
    "pronostico",
    // French
    "météo",
    "température",
    "prévisions",
    "pluie",
    "neige",
    "meteo",
    "previsions",
    // Portuguese
    "clima",
    "temperatura",
    "previsão",
    "chuva",
    "neve",
    "previsao",
    // Italian
    "meteo",
    "temperatura",
    "previsioni",
    "pioggia",
    "neve",
    // Russian
    "погода",
    "температура",
    "прогноз",
    "дождь",
    "снег",
    // Chinese
    "天气",
    "温度",
    "预报",
    "下雨",
    "下雪",
    // Japanese
    "天気",
    "気温",
    "予報",
    "雨",
    "雪",
    // Korean
    "날씨",
    "기온",
    "예보",
    "비",
    "눈",
    // Arabic
    "طقس",
    "درجة الحرارة",
    "توقعات",
    "مطر",
    "ثلج",
    // Hindi
    "मौसम",
    "तापमान",
    "बारिश",
    "बर्फ",
    // Turkish
    "hava durumu",
    "sıcaklık",
    "tahmin",
    "yağmur",
    "kar",
    "sicaklik",
    // Polish
    "pogoda",
    "temperatura",
    "prognoza",
    "deszcz",
    "śnieg",
    "snieg",
    // Dutch
    "weer",
    "temperatuur",
    "verwachting",
    "regen",
    "sneeuw",
    // Swedish
    "väder",
    "temperatur",
    "prognos",
    "regn",
    "snö",
    "vader",
    "sno",
    // Czech
    "počasí",
    "teplota",
    "předpověď",
    "déšť",
    "sníh",
    "pocasi",
    "predpoved",
    // Thai
    "อากาศ",
    "อุณหภูมิ",
    "ฝน",
    "หิมะ",
    // Vietnamese
    "thời tiết",
    "nhiệt độ",
    "mưa",
    "tuyết",
    // Indonesian
    "cuaca",
    "suhu",
    "hujan",
    "salju",
];

const WEATHER_PATTERN = buildWordBoundaryPattern(WEATHER_WORDS, "iu");

// News/event words across languages
const NEWS_WORDS = [
    // English
    "news",
    "headlines",
    // German
    "nachrichten",
    "schlagzeilen",
    // Spanish
    "noticias",
    "titulares",
    // French
    "actualités",
    "nouvelles",
    "actualites",
    // Portuguese
    "notícias",
    "manchetes",
    "noticias",
    // Italian
    "notizie",
    "cronaca",
    // Russian
    "новости",
    "заголовки",
    // Chinese
    "新闻",
    "头条",
    // Japanese
    "ニュース",
    "見出し",
    // Korean
    "뉴스",
    "헤드라인",
    // Arabic
    "أخبار",
    "عناوين",
    // Hindi
    "समाचार",
    "खबर",
    // Turkish
    "haberler",
    "haber",
    // Polish
    "wiadomości",
    "wiadomosci",
    // Dutch
    "nieuws",
    // Thai
    "ข่าว",
    // Vietnamese
    "tin tức",
    // Indonesian
    "berita",
];

const NEWS_PATTERN = buildWordBoundaryPattern(NEWS_WORDS, "iu");

// Search/find verbs across languages (for short message heuristic)
// Uses (?:^|\s|$) boundaries instead of \b to support Cyrillic/CJK
const SEARCH_VERB_WORDS = [
    // English
    "search",
    "find",
    "look",
    "get",
    // German
    "suche",
    "finde",
    "suchen",
    "finden",
    // Spanish
    "busca",
    "buscar",
    "encuentra",
    "encontrar",
    // French
    "cherche",
    "chercher",
    "trouve",
    "trouver",
    // Portuguese
    "procura",
    "procurar",
    // Russian
    "найди",
    "найти",
    "ищи",
    "искать",
    // Chinese
    "搜索",
    "查找",
    // Japanese
    "検索",
    "探す",
    "調べる",
    "探して",
    // Korean
    "검색",
    "찾아",
    "찾기",
];
const SEARCH_VERBS_PATTERN = buildWordBoundaryPattern(SEARCH_VERB_WORDS, "iu");

// Factual question words across languages (who/where/when)
// Uses (?:^|\s|$) boundaries for non-Latin scripts
const FACTUAL_WORDS = [
    // English
    "who",
    "where",
    "when",
    // German
    "wer",
    "wo",
    "wann",
    // Spanish
    "quién",
    "quien",
    "dónde",
    "donde",
    "cuándo",
    "cuando",
    // French
    "qui",
    "où",
    "ou",
    "quand",
    // Portuguese
    "quem",
    "onde",
    "quando",
    // Italian
    "chi",
    "dove",
    // Russian
    "кто",
    "где",
    "когда",
    // Chinese
    "谁",
    "哪里",
    "什么时候",
    // Japanese
    "誰",
    "どこ",
    "いつ",
    // Korean
    "누구",
    "어디",
    "언제",
    // Turkish
    "kim",
    "nerede",
    "ne zaman",
    // Polish
    "kto",
    "gdzie",
    "kiedy",
];
const FACTUAL_WORDS_PATTERN = buildWordBoundaryPattern(FACTUAL_WORDS, "iu");

// ---------------------------------------------------------------------------
// Pattern lists
// ---------------------------------------------------------------------------

/** Patterns that strongly indicate no web search is needed */
const DIRECT_ANSWER_PATTERNS: { pattern: RegExp; reason: string }[] = [
    // Multilingual greetings & small talk
    { pattern: GREETING_PATTERN, reason: "greeting" },
    { pattern: GOOD_TIME_PATTERN, reason: "greeting" },
    // Math / arithmetic expressions (universal — digits are the same everywhere)
    { pattern: /^\d+\s*[+\-*/^%]\s*\d+/, reason: "math_expression" },
    { pattern: /^(what('?s| is)|calculate|compute|solve)\s+\d+/i, reason: "math_query" },
    { pattern: /^(what('?s| is)|how much is)\s+\d+\s*(plus|minus|times|divided|multiplied|mod)/i, reason: "math_query" },
    // German math patterns
    { pattern: /^(was ist|berechne|löse|loese)\s+\d+/i, reason: "math_query" },
    // Spanish math patterns
    { pattern: /^(qué es|que es|calcula|resuelve)\s+\d+/i, reason: "math_query" },
    // French math patterns
    { pattern: /^(combien fait|calcule|quel est)\s+\d+/i, reason: "math_query" },
    // Code / programming explanations (no time-sensitive data needed)
    {
        pattern:
            /^(explain|define|what('?s| is| are| does)|describe)\s+(a |an |the )?(concept|difference|meaning|purpose|function|method|class|algorithm|pattern|principle)/i,
        reason: "concept_explanation",
    },
    {
        pattern:
            /^(explain|what('?s| is| are| does))\s+(recursion|polymorphism|inheritance|encapsulation|abstraction|closure|hoisting|memoization|currying|mutex|semaphore)/i,
        reason: "cs_concept",
    },
    // German concept explanation
    {
        pattern:
            /^(erkläre|erklare|definiere|was ist|was sind|beschreibe)\s+(ein |eine |der |die |das |den |dem )?(konzept|unterschied|bedeutung|funktion|methode|klasse|algorithmus)/i,
        reason: "concept_explanation",
    },
    // Spanish concept explanation
    {
        pattern:
            /^(explica|define|qué es|que es|describe)\s+(un |una |el |la )?(concepto|diferencia|significado|función|funcion|método|metodo|clase|algoritmo)/i,
        reason: "concept_explanation",
    },
    // French concept explanation
    {
        pattern:
            /^(explique|définir|definir|qu'est-ce que|décris|decris)\s+(un |une |le |la )?(concept|différence|difference|signification|fonction|méthode|methode|classe|algorithme)/i,
        reason: "concept_explanation",
    },
    // Code generation (multilingual)
    {
        pattern: /^(write|create|make|generate|implement|code)\s+(?:(?:a|an|the)\s+)?(?:\w+\s*)?(function|method|class|script|program|component|hook|util)/i,
        reason: "code_generation",
    },
    {
        pattern: /^(schreibe|erstelle|erzeuge|implementiere)\s+(eine? |den |die |das )?(funktion|methode|klasse|skript|programm|komponente)/i,
        reason: "code_generation",
    },
    {
        pattern: /^(escribe|crea|genera|implementa)\s+(una? |el |la )?(función|funcion|método|metodo|clase|script|programa|componente)/i,
        reason: "code_generation",
    },
    {
        pattern: /^(écris|ecris|crée|cree|génère|genere|implémente|implemente)\s+(une? |le |la )?(fonction|méthode|methode|classe|script|programme|composant)/i,
        reason: "code_generation",
    },
    // Code howto
    {
        pattern: /^(how (do|does|to|can)|what('?s| is) the (syntax|way))\s+(you |i |we )?(write|create|implement|use|call|declare|define)/i,
        reason: "code_howto",
    },
    { pattern: /^(wie (kann|kann man|schreibt man|erstellt man|implementiert man))\s/i, reason: "code_howto" },
    { pattern: /^(cómo|como)\s+(puedo|se puede|escribir|crear|implementar|usar)/i, reason: "code_howto" },
    { pattern: /^(comment)\s+(écrire|ecrire|créer|creer|implémenter|implementer|utiliser)/i, reason: "code_howto" },
    // Translation requests (checked before conversion since translate/traduce/traduis overlap)
    //
    // The separators here are a single `\s`, NOT `\s+`: the bounded wildcard that
    // follows also matches whitespace, so an unbounded run in front of it makes the
    // two backtrack against each other. `classifyQuery` runs on the raw user prompt
    // (`chat/execute.ts`) with no length cap, and `"translate" + 20k spaces` took
    // 19.8s against `\s+.{1,100}\s+`. The wildcard absorbs extra spaces by itself,
    // so a single `\s` matches the same queries.
    {
        pattern:
            /^(translate|say)\s[\s\S]{1,100}\s(in|to|into)\s+(french|german|spanish|japanese|chinese|korean|italian|portuguese|russian|arabic|hindi|turkish|polish|dutch|swedish|czech|thai|vietnamese|indonesian|bengali|urdu|persian|hebrew|greek|hungarian|romanian|ukrainian|bulgarian|croatian|serbian|finnish|norwegian|danish|catalan|afrikaans|malay|swahili)/i,
        reason: "translation",
    },
    {
        pattern:
            /^(übersetze|ubersetze)\s[\s\S]{1,100}\s(auf|ins|nach)\s+(französisch|franzosisch|spanisch|englisch|japanisch|chinesisch|koreanisch|italienisch|portugiesisch|russisch|arabisch|türkisch|turkisch)/i,
        reason: "translation",
    },
    {
        pattern:
            /^(traduce)\s[\s\S]{1,100}\s(al?|en)\s+(francés|frances|alemán|aleman|inglés|ingles|japonés|japones|chino|coreano|italiano|portugués|portugues|ruso|árabe|arabe|turco)/i,
        reason: "translation",
    },
    {
        pattern: /^(traduis)\s[\s\S]{1,100}\s(en)\s+(allemand|anglais|espagnol|japonais|chinois|coréen|coreen|italien|portugais|russe|arabe|turc)/i,
        reason: "translation",
    },
    // Conversion requests (after translation — same verbs but without target language)
    { pattern: /^(convert|translate|transform)\s[\s\S]{1,50}\s(to|into|from)\s/i, reason: "conversion_request" },
    { pattern: /^(konvertiere|übersetze|ubersetze|wandle)\s[\s\S]{1,50}\s(in|nach|zu|von)\s/i, reason: "conversion_request" },
    { pattern: /^(convierte|traduce|transforma)\s[\s\S]{1,50}\s(a|en|de|al)\s/i, reason: "conversion_request" },
    { pattern: /^(convertis|traduis|transforme)\s[\s\S]{1,50}\s(en|à|a|de)\s/i, reason: "conversion_request" },
    // Pure opinion / creative requests (multilingual)
    { pattern: /^(tell me a|write a|compose a|make up a)\s+(joke|story|poem|haiku|limerick|song|rap)/i, reason: "creative_request" },
    { pattern: /^(erzähl|erzaehl|schreib)\s+(mir )?(einen? )?(witz|geschichte|gedicht|lied)/i, reason: "creative_request" },
    { pattern: /^(cuéntame|cuentame|escribe|cuenta)\s+(un |una )?(chiste|historia|poema|canción|cancion)/i, reason: "creative_request" },
    { pattern: /^(raconte|écris|ecris)[\s-]+(?:moi\s+)?(une? )?(blague|histoire|poème|poeme|chanson)/i, reason: "creative_request" },
    // Summarize / rephrase (multilingual)
    { pattern: /^(summarize|rephrase|rewrite|paraphrase|simplify|elaborate on)\s/i, reason: "text_transform" },
    { pattern: /^(zusammenfassen|umformulieren|umschreiben|vereinfachen|erläutern|erlautern)\s/i, reason: "text_transform" },
    { pattern: /^(resumir|reformular|reescribir|parafrasear|simplificar)\s/i, reason: "text_transform" },
    { pattern: /^(résumer|resumer|reformuler|réécrire|reecrire|paraphraser|simplifier)\s/i, reason: "text_transform" },
    { pattern: /^(resumir|reformular|reescrever|parafrasear|simplificar)\s/i, reason: "text_transform" },
    { pattern: /^(riassumere|riformulare|riscrivere|semplificare)\s/i, reason: "text_transform" },
];

/** Patterns that strongly indicate web search IS needed */
const SEARCH_REQUIRED_PATTERNS: { pattern: RegExp; reason: string }[] = [
    // Multilingual time-sensitive markers
    { pattern: TIME_SENSITIVE_PATTERN, reason: "time_sensitive" },
    // Year references (likely seeking current info) — universal
    { pattern: /\b20(2[4-9]|[3-9]\d)\b/, reason: "recent_year_reference" },
    // Prices, stocks, market data (multilingual)
    { pattern: /\b(price|cost|stock|share|market cap|valuation|worth)\s+(of|for)\b/i, reason: "market_data" },
    { pattern: /\b(preis|kosten|aktie|aktienkurs|bewertung)\s+(von|für|fur)\b/i, reason: "market_data" },
    { pattern: /\b(precio|costo|acción|accion|valor|cotización|cotizacion)\s+(de|del)\b/i, reason: "market_data" },
    { pattern: /\b(prix|coût|cout|action|valorisation)\s+(de|du|des)\b/i, reason: "market_data" },
    { pattern: /\b(how much (does|is|are|do))\b.*\b(cost|worth|price)/i, reason: "pricing_query" },
    { pattern: /\b(wie viel kostet|was kostet)\b/i, reason: "pricing_query" },
    { pattern: /\b(cuánto|cuanto)\s+(cuesta|vale)\b/i, reason: "pricing_query" },
    { pattern: /\b(combien (coûte|coute|vaut))\b/i, reason: "pricing_query" },
    // News / events (multilingual)
    { pattern: NEWS_PATTERN, reason: "news_query" },
    // Specific entities with lookup intent (multilingual)
    { pattern: /\b(who (is|was|are)|where (is|are|can I)|when (is|was|does|did))\b/i, reason: "entity_lookup" },
    { pattern: /\b(wer (ist|war)|wo (ist|sind|kann)|wann (ist|war|wird))\b/i, reason: "entity_lookup" },
    { pattern: /\b(quién|quien) (es|fue|era)\b/i, reason: "entity_lookup" },
    { pattern: /\b(qui (est|était|etait))\b/i, reason: "entity_lookup" },
    // URLs and websites — universal
    { pattern: /https?:\/\/|www\.|\.com|\.org|\.io|\.dev/i, reason: "url_reference" },
    // Comparison of specific products/services (multilingual)
    { pattern: /\b(compare|vs\.?|versus|better|best|top \d+|ranking|review|rating)\b.*\b(for|of|between)\b/i, reason: "comparison_query" },
    { pattern: /\b(vergleiche|vergleich|besser|beste|rangliste|bewertung)\b.*\b(für|fur|von|zwischen)\b/i, reason: "comparison_query" },
    { pattern: /\b(compara|comparar|mejor|mejores|ranking|reseña|resena)\b.*\b(para|de|entre)\b/i, reason: "comparison_query" },
    { pattern: /\b(comparer|meilleur|meilleurs|classement|avis)\b.*\b(pour|de|entre)\b/i, reason: "comparison_query" },
    // Weather (multilingual)
    { pattern: WEATHER_PATTERN, reason: "weather_query" },
    // Status / availability queries
    { pattern: /\b(is .{1,30} (down|up|available|working|open|closed|live))\b/i, reason: "status_query" },
];

/** Search modes where classification should NOT skip tools */
const ALWAYS_SEARCH_MODES = new Set<SearchMode>(["crypto", "spotify", "stocks", "wolfram", "youtube"]);

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a query to determine whether web search tools should be used.
 *
 * Supports multilingual queries matching all 123 languages available
 * in the composer language picker.
 * @param query The user's message text
 * @param searchMode The currently selected search mode
 * @returns Classification result with confidence and reason
 */
const classifyQuery = (query: string, searchMode: SearchMode): ClassificationResult => {
    // Normalize
    const trimmed = query.trim();

    // Empty or whitespace-only → ambiguous (nothing to classify)
    if (trimmed.length === 0) {
        return { classification: "ambiguous", confidence: 0.5, reason: "empty_query" };
    }

    // Modes like stocks/crypto/spotify/youtube always need their specialized tools
    if (ALWAYS_SEARCH_MODES.has(searchMode)) {
        return { classification: "search_required", confidence: 1, reason: "specialized_mode" };
    }

    // Chat / writing mode → no search tools, always direct
    if (searchMode === "chat" || searchMode === "writing") {
        return { classification: "direct_answer", confidence: 1, reason: "chat_mode" };
    }

    const lowerQuery = trimmed.toLowerCase();
    const wordCount = trimmed.split(WHITESPACE_RE).length;

    // Check for search-required patterns first (higher priority)
    for (const { pattern, reason } of SEARCH_REQUIRED_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { classification: "search_required", confidence: 0.9, reason };
        }
    }

    // Check for direct-answer patterns
    for (const { pattern, reason } of DIRECT_ANSWER_PATTERNS) {
        if (pattern.test(trimmed)) {
            // Short, clear direct-answer patterns get high confidence
            const confidence = wordCount <= 10 ? 0.95 : 0.85;

            return { classification: "direct_answer", confidence, reason };
        }
    }

    // Heuristic: very short questions without time context are often answerable directly
    // But only if they don't look like factual lookups (multilingual)
    if (wordCount <= 4 && lowerQuery.includes("?") && !FACTUAL_WORDS_PATTERN.test(lowerQuery)) {
        return { classification: "direct_answer", confidence: 0.8, reason: "short_question" };
    }

    // Heuristic: very short greetings/simple messages
    if (wordCount <= 2 && !SEARCH_VERBS_PATTERN.test(lowerQuery) && !FACTUAL_WORDS_PATTERN.test(lowerQuery)) {
        return { classification: "direct_answer", confidence: 0.85, reason: "short_message" };
    }

    // Default: ambiguous — let the search tools be available
    return { classification: "ambiguous", confidence: 0.5, reason: "no_clear_signal" };
};

export default classifyQuery;
