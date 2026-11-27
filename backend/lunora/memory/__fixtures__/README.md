# Retrieval eval fixture

Data for `../retrieval-eval.test.ts`: does long-term memory retrieval inject the right memories? Everything here is
synthetic; there are no real people and nothing comes from a public benchmark.

## Files

- `retrieval-eval-phrases.json` — the hand-written phrase bank: 16 hobby topics, each with six facts (one per aspect),
  six questions that paraphrase them, an event phrase and five per-persona details; plus questions about topics nobody has,
  and ten facts holding an exact token (a part number, a serial, a name, a rare word) with a question naming it and one
  naming a token nobody has.
- `build-retrieval-eval.mjs` — combines the bank with a seeded random generator into personas, memories and queries.
  The script is deterministic: `node backend/lunora/memory/__fixtures__/build-retrieval-eval.mjs`, then
  `npx oxfmt backend/lunora/memory/__fixtures__`, rewrites `retrieval-eval.json` identically. The phrases and the
  labelling rules are written by hand; the 1,183 memory rows and their ages, confidences and tags are generated. The
  ages and the confidence and importance ranges are assumed (older rows are more common; identity rows score higher
  than activity rows), not read from what extraction emits. Every row is created before it is last confirmed, and
  neither is after `today` (the script refuses to write one that is not, and the test checks it).
- `retrieval-eval.json` — the fixture the test reads.

## What is in it

- 5 personas with 199 to 280 memories each (151 to 204 own active rows), and a sixth (`p6`, 221) for the `dated`
  questions: a copy of the first with 22 rows added, so no row the first 180 questions read changes. Each has more than the 100 rows of the
  candidate window, so which rows reach scoring matters.
- Types: identity, preference, context, activity, experience. Dated rows (`eventStart` in the past and ahead, `validUntil` in the past, today and
  ahead), older versions of a fact (replaced, expired, or still active but confirmed longer ago), pinned rows, rows of two bots (`bot-a` joins some chats, `bot-b` never does), expired rows,
  low-signal filler, and a few rows with no vector (`noVector`).
- 180 queries (36 per persona) and 32 on `p6` (25 `dated`, 7 `abstain` that name a time), each labelled with the memory ids
  a good retrieval returns:

| Category          | Queries | Label                                                              |
| ----------------- | ------- | ------------------------------------------------------------------ |
| `single`          | 50      | one fact                                                           |
| `multi`           | 30      | two facts of one topic, learned at different times                 |
| `temporal`        | 30      | the event that happened in a named month (on or before `today`)    |
| `update`          | 20      | the newest statement; an older version also exists                 |
| `exact`           | 20      | the one fact holding the exact token the question names            |
| `abstain`         | 30      | none: the topic was never mentioned, or the token is nobody's      |
| `dated`           | 25      | every event in the asked time, or the one row of its theme         |
| `abstain` on `p6` | 7       | none: a time and a topic nobody mentioned ("the weather tomorrow") |

The `dated` questions (a third pass, seed `dated`) name a time in English or German: tomorrow, today, yesterday,
last / next week, next month, December, 3 December, in 3 days, 5 days ago, May 2023, 2023, an ISO day. Each carries the
`window` it asks about, written in the generator; the expected rows are computed from it, never from the parser, and
the eval checks the parser reads the same window. Their rows are events (ahead and past, of the asked time and of
others), periods (`Lived in Leipzig`, 2021 to 2024), and facts with an end date that holds through the window or ends
before it. A question about a time alone ("what is coming up tomorrow") embeds on an aspect only, as an embedding does
not know which day tomorrow is. Seven more name a time beside a topic nobody mentioned ("what is the weather like
tomorrow", "was koche ich heute"), labelled `abstain` and reported as `datedAbstain`, apart from the 30 above.

The `exact` rows are a second pass of the generator with its own seed, so the rows before them are as they were. Each is
older than the window, embedded, and copied onto a superseded, an expired or a `bot-b` row that must never be the answer.

## Vectors without a model

No embedding model is called. Each memory and each query carries `tags`: sparse weights over 64 dimensions that the test
expands and normalises, so cosine similarity is meaningful and stable.

- dims 0-15: topic. 16-21: topics nobody has (for `abstain`). 22-27: aspect (who, likes, setup, recent, history, plan).
- dim 28: a shared background weight, so unrelated texts are not at cosine 0, as with a real model.
- dims 29-40: month (events and `temporal` queries). 41-63: two noise dims per row. 64-73: one per `exact` fact. 74-79:
  the `dated` themes (home, appointments, travel, work, social, contracts).
- An `exact` question embeds on a topic nobody has (16-21), so the vector search misses its fact by construction: the
  category measures the keyword search, not how often a real embedding misses a token.

The test simulates the vector step as production runs it: the top `VECTOR_FETCH_K` (90) of all of the user's vectors (other bots', expired
and superseded rows included), then the superseded and expired ones dropped and the best `VECTOR_TOP_K` (30) of the chat's own scopes kept
(`topScopedHits`). The candidates are the window plus those hits that fall outside it (`withVectorHits`: in scope, in effect). A candidate
without a vector hit falls back to the keyword score, except an embedded row older than `VECTOR_SYNC_WINDOW_MS` when the 30 in-scope hits
filled the cut (`vectorCutIsFull`): it was not among the nearest, so it has no relevance. The fixture ages are in days, so every row is older
than the sync window. `now` and `today` come from `meta`, never the clock.

The keyword search is simulated the same way: one lookup per salient term (`keywordLookupTerms`) over every row of the
user, a token starting with the term, most occurrences first, then newest, cut to `KEYWORD_LOOKUP_LIMIT` (50); then the
production filter (`keywordLookupOf`: whole tokens, usable, in scope, 20 kept) and the best `KEYWORD_TOP_K` (30) by BM25
(`topKeywordHits`), fused with the vector hits by rank (`fuseSearchHits`).

## Metrics

Per query, `injected` is what `rankMemories` returns (at most 8) for the candidates `selectCandidateWindow` (the newest `CANDIDATE_WINDOW_SIZE` (100) rows of each scope) and `withVectorHits` build. The test imports both limits from
`../retrieve-ranking.ts`, the constants `retrieve.ts` uses, so changing one in production changes what the eval measures. Vitest
hides console output of a passing run; print the table with
`cd backend && npx vitest run lunora/memory/retrieval-eval.test.ts --silent=false`.

- **Recall@8**: expected ids injected / expected ids. **NDCG@8**: binary gains over the injected order. Both over the
  150 queries that have a label. `overall` is the first 180 queries; `dated` is reported on its own.
- **Expected in window**: expected ids that are candidates at all (the window and the vector hits) / expected ids. It separates a row
  that never reaches scoring from a row the ranking loses.
- **Off-topic rate**: injected rows not in the label / injected rows, over all 150 queries (so an `abstain` query that
  injects anything counts fully). Over all 180.
- **Abstain rate**: share of never-mentioned (`abstain`) queries that inject nothing = `abstain` queries with no injected
  row / `abstain` queries.
- **Abstain precision**: of the queries that inject nothing, the share labelled `abstain`. Undefined while every query
  injects something.

## Results

`BASELINE` in the test holds the numbers of the current retrieval; the test fails when a metric is 0.02 worse than
its number (the off-topic rate, overall and per category: 0.02 higher; expected in window, overall and per category: 0.02
lower). Each cell is the retrieval before the keyword search (vector hits only, word overlap as the fallback) → the
current one, both over this fixture.

| Slice    | Recall@8      | NDCG@8        | Expected in window | Off-topic rate | Abstain rate  | Abstain precision |
| -------- | ------------- | ------------- | ------------------ | -------------- | ------------- | ----------------- |
| overall  | 0.823 → 0.957 | 0.668 → 0.796 | 0.947 → 1.000      | 0.853 → 0.836  | 0.867 → 0.933 | 0.605 → 1.000     |
| single   | 0.940 → 0.940 | 0.830 → 0.822 | 1.000 → 1.000      | 0.880 → 0.880  |               |                   |
| multi    | 0.883 → 0.883 | 0.726 → 0.725 | 1.000 → 1.000      | 0.771 → 0.771  |               |                   |
| temporal | 1.000 → 1.000 | 0.715 → 0.715 | 1.000 → 1.000      | 0.872 → 0.872  |               |                   |
| update   | 1.000 → 1.000 | 0.776 → 0.776 | 1.000 → 1.000      | 0.873 → 0.873  |               |                   |
| exact    | 0.000 → 1.000 | 0.000 → 0.982 | 0.600 → 1.000      | 1.000 → 0.048  |               |                   |
| abstain  |               |               |                    | 1.000 → 1.000  | 0.867 → 0.933 | 1.000 → 1.000     |

With no vector search the keyword-only run reads Recall@8 0.160 → 0.603 and abstain rate 0.433 → 0.667. A number alone
is no identifier, so "is parcel 52690 mine" is answered with the user's own parcel note (ends in 77314) rather than with
nothing; that one query is the abstain rate's 0.967 → 0.933 (and 0.800 → 0.767 without vectors), and both floors record it. Without vectors three more fall to 0.667: an
identifier the memory lacks now weighs in the share instead of zeroing it, so `QZ-5508`, `WTU-40126` and `HIST-318`
reach the sibling code's row through two or more shared words (part, dishwasher; serial, bike; evening, course, up).
With vectors all three still abstain. Single NDCG@8
falls by 0.008 (two queries reorder) because a word the memory never had no longer dilutes the one it does: a row with
no vector that shares one word of a question whose other words are in no memory scores in full. Its floor stays 0.830,
within the 0.02 tolerance. Exact NDCG@8 is 0.982 because each term's BM25 factor is capped at 1 in the keyword share,
so a short row no longer scores above its share: for "have I read Quillfeather" a recent row holding only `read` now
ranks above the shorter Quillfeather row (both injected). On the
150-query fixture before the `exact` rows, the earlier changes (newest-rows window, relevance gate, weights) took
overall Recall@8 0.600 → 0.950 and NDCG@8 0.431 → 0.771.

**The asked time** (`../time-window.ts`), measured with and without it on this fixture (the test prints both):

| Slice        | Recall@8      | NDCG@8        | Off-topic rate | Abstain rate  |
| ------------ | ------------- | ------------- | -------------- | ------------- |
| overall      | 0.957 → 0.957 | 0.796 → 0.853 | 0.836 → 0.836  | 0.933 → 0.933 |
| temporal     | 1.000 → 1.000 | 0.715 → 1.000 | 0.872 → 0.872  |               |
| dated        | 0.687 → 1.000 | 0.589 → 0.956 | 0.817 → 0.699  |               |
| datedAbstain |               |               | 1.000 → 1.000  | 0.857 → 0.857 |

Every other category ranks byte for byte as without it: of the 180, only the 30 `temporal` questions and the two that
say `today` name a time, and the two rank as before. A month's event now ranks first for "what did I do about coffee in
May". For a day or a week the events of it are found by their date alone (they share no topic with "what did I do last
week"), but only for a question about the time alone, made of question, agenda and time words (`onlyTime`): with
every event of the window relevant by its date, the `datedAbstain` rate read 0.000. For a year only the order moves, so "where was I living in 2023" puts the Leipzig period second, behind the
newer undated home row.

What moved them:

- **Keywords find what vectors miss.** Each of the first six salient query terms is one lookup of the
  `search_memory_text` FTS5 index (reading 50 rows, keeping 20 whole-token, usable, in-scope ones), so a row older than
  the window that holds the query's code or name becomes a candidate. Relevance is the IDF-weighted share of every salient term
  the memory holds at all, over whole tokens (`time` is not `timer`, which cost two abstain queries with prefix
  matching). An identifier the memory lacks (`QZ-5508` when the user has `KX-2291`) counts in the share's denominator at
  the highest IDF, and a row then needs two of the query's terms (or one of its identifiers) to count by keyword. A row holding the leading term and the rare term (that identifier, or the rarest looked-up word,
  held by at most 2 of the user's rows) counts by keyword even when a full vector cut lacks it. The keyword floor is
  0.15: at 0.2, multi Recall@8 reads 0.867. NDCG@8 of multi moves by 0.001.

- **The window is the newest rows.** It used to be the first 100 rows of the index (type descending, then newest), so an
  `activity` row sorted last and only one of the `temporal` rows reached scoring. Now it is the newest 100 of each scope
  whatever the type, and the vector hits outside it are added: every expected row is a candidate.
- **Relevance gates injection.** A row needs a cosine of 0.45 before its other signals count, so a row confirmed last week, or a
  pinned one, is no longer injected for a search it has nothing to do with: a never-mentioned topic injects nothing in 18 of 20
  queries (0 of 20 before). In this fixture the relevant rows start at cosine 0.86 and the unrelated ones end at 0.40 (the
  background weight of dim 28): the abstain rate is 0.35 with the floor at 0.40, and 0.90 or more from 0.41 to 0.86. A relevant fact
  at cosine 0.40 is therefore under the floor, whatever its age. The score threshold is 0.3, since relevance is the floor now.
- **Common words count only where there is no vector.** A memory that has a vector the search did not return is not relevant by
  its words (a question's common words overlap with any memory), unless it holds the query's rare term; one with no vector, or any
  memory when no vector search ran, is found by its keyword score. The last test of the eval runs that path (numbers above).
- **Relevance leads the weights.** Recall@8 / NDCG@8 by semantic weight (the rest shared by confidence, importance and recency):
  0.45 (the old 0.18 / 0.12 / 0.25) 0.919 / 0.600; 0.55 0.938 / 0.660; 0.65 (0.12 / 0.08 / 0.15) 0.950 / 0.771; 0.75 0.954 / 0.879;
  0.85 0.958 / 0.911. The fixture's confidence, importance and ages are assumed, not read from extraction, so 0.65 is the middle.
- **The off-topic rate barely moves, by construction.** A query has one or two labelled rows and injects up to 8; the rest are rows
  of the same topic (another aspect), which a label cannot tell from noise. It falls with the noise rows and `mean injected` (8.00 → 6.78).
- **`search_memory` is not in the table.** It asks for cosine 0.35 (keyword 0.1), has no score threshold and returns up to 10; it is
  covered by `retrieve.test.ts` and `retrieve-ranking.test.ts`.
