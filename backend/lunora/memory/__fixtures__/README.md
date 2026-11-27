# Retrieval eval fixture

Data for `../retrieval-eval.test.ts`: does long-term memory retrieval inject the right memories? Everything here is
synthetic; there are no real people and nothing comes from a public benchmark.

## Files

- `retrieval-eval-phrases.json` — the hand-written phrase bank: 16 hobby topics, each with six facts (one per aspect),
  six questions that paraphrase them, an event phrase and five per-persona details; plus questions about topics nobody has.
- `build-retrieval-eval.mjs` — combines the bank with a seeded random generator into personas, memories and queries.
  The script is deterministic: `node backend/lunora/memory/__fixtures__/build-retrieval-eval.mjs`, then
  `npx oxfmt backend/lunora/memory/__fixtures__`, rewrites `retrieval-eval.json` identically. The phrases and the
  labelling rules are written by hand; the 1,143 memory rows and their ages, confidences and tags are generated. The
  ages and the confidence and importance ranges are assumed (older rows are more common; identity rows score higher
  than activity rows), not read from what extraction emits. Every row is created before it is last confirmed, and
  neither is after `today` (the script refuses to write one that is not, and the test checks it).
- `retrieval-eval.json` — the fixture the test reads.

## What is in it

- 5 personas with 191 to 272 memories each (146 to 199 own active rows). Each has more than the 100 rows of the
  candidate window, so which rows reach scoring matters.
- Types: identity, preference, context, activity, experience. Dated rows (`eventStart` in the past and ahead, `validUntil` in the past, today and
  ahead), older versions of a fact (replaced, expired, or still active but confirmed longer ago), pinned rows, rows of two bots (`bot-a` joins some chats, `bot-b` never does), expired rows,
  low-signal filler, and a few rows with no vector (`noVector`).
- 150 queries (30 per persona), each labelled with the memory ids a good retrieval returns:

| Category   | Queries | Label                                                           |
| ---------- | ------- | --------------------------------------------------------------- |
| `single`   | 50      | one fact                                                        |
| `multi`    | 30      | two facts of one topic, learned at different times              |
| `temporal` | 30      | the event that happened in a named month (on or before `today`) |
| `update`   | 20      | the newest statement; an older version also exists              |
| `abstain`  | 20      | none: the topic was never mentioned                             |

## Vectors without a model

No embedding model is called. Each memory and each query carries `tags`: sparse weights over 64 dimensions that the test
expands and normalises, so cosine similarity is meaningful and stable.

- dims 0-15: topic. 16-21: topics nobody has (for `abstain`). 22-27: aspect (who, likes, setup, recent, history, plan).
- dim 28: a shared background weight, so unrelated texts are not at cosine 0, as with a real model.
- dims 29-40: month (events and `temporal` queries). 41-63: two noise dims per row.

The test simulates the vector step as production runs it: the top `VECTOR_FETCH_K` (90) of all of the user's vectors (other bots', expired
and superseded rows included), then the superseded and expired ones dropped and the best `VECTOR_TOP_K` (30) of the chat's own scopes kept
(`topScopedHits`). The candidates are the window plus those hits that fall outside it (`withVectorHits`: in scope, in effect). A candidate
without a vector hit falls back to the keyword score, except an embedded row older than `VECTOR_SYNC_WINDOW_MS` when the 30 in-scope hits
filled the cut (`vectorCutIsFull`): it was not among the nearest, so it has no relevance. The fixture ages are in days, so every row is older
than the sync window. `now` and `today` come from `meta`, never the clock.

## Metrics

Per query, `injected` is what `rankMemories` returns (at most 8) for the candidates `selectCandidateWindow` (the newest `CANDIDATE_WINDOW_SIZE` (100) rows of each scope) and `withVectorHits` build. The test imports both limits from
`../retrieve-ranking.ts`, the constants `retrieve.ts` uses, so changing one in production changes what the eval measures. Vitest
hides console output of a passing run; print the table with
`cd backend && npx vitest run lunora/memory/retrieval-eval.test.ts --silent=false`.

- **Recall@8**: expected ids injected / expected ids. **NDCG@8**: binary gains over the injected order. Both over the
  130 queries that have a label.
- **Expected in window**: expected ids that are candidates at all (the window and the vector hits) / expected ids. It separates a row
  that never reaches scoring from a row the ranking loses.
- **Off-topic rate**: injected rows not in the label / injected rows, over all 150 queries (so an `abstain` query that
  injects anything counts fully).
- **Abstain rate**: share of never-mentioned (`abstain`) queries that inject nothing = `abstain` queries with no injected
  row / `abstain` queries.
- **Abstain precision**: of the queries that inject nothing, the share labelled `abstain`. Undefined while every query
  injects something.

## Results

`BASELINE` in the test holds the numbers of the current retrieval; the test fails when a metric is 0.02 worse than
its number (the off-topic rate, overall and per category: 0.02 higher; expected in window, overall and per category: 0.02
lower). Each cell is the retrieval before the candidate, relevance and weight changes → the current one.

| Slice    | Recall@8      | NDCG@8        | Expected in window | Off-topic rate | Abstain rate  | Abstain precision |
| -------- | ------------- | ------------- | ------------------ | -------------- | ------------- | ----------------- |
| overall  | 0.600 → 0.950 | 0.431 → 0.771 | 0.638 → 1.000      | 0.917 → 0.853  | 0.000 → 0.900 | undefined → 1.000 |
| single   | 0.740 → 0.940 | 0.543 → 0.830 | 0.780 → 1.000      | 0.907 → 0.880  |               |                   |
| multi    | 0.733 → 0.883 | 0.559 → 0.726 | 0.833 → 1.000      | 0.817 → 0.771  |               |                   |
| temporal | 0.033 → 1.000 | 0.033 → 0.715 | 0.033 → 1.000      | 0.996 → 0.872  |               |                   |
| update   | 0.900 → 1.000 | 0.554 → 0.776 | 0.900 → 1.000      | 0.887 → 0.873  |               |                   |
| abstain  |               |               |                    | 1.000 → 1.000  | 0.000 → 0.900 | undefined → 1.000 |

What moved them:

- **The window is the newest rows.** It used to be the first 100 rows of the index (type descending, then newest), so an
  `activity` row sorted last and only one of the `temporal` rows reached scoring. Now it is the newest 100 of each scope
  whatever the type, and the vector hits outside it are added: every expected row is a candidate.
- **Relevance gates injection.** A row needs a cosine of 0.45 before its other signals count, so a row confirmed last week, or a
  pinned one, is no longer injected for a search it has nothing to do with: a never-mentioned topic injects nothing in 18 of 20
  queries (0 of 20 before). In this fixture the relevant rows start at cosine 0.86 and the unrelated ones end at 0.40 (the
  background weight of dim 28): the abstain rate is 0.35 with the floor at 0.40, and 0.90 or more from 0.41 to 0.86. A relevant fact
  at cosine 0.40 is therefore under the floor, whatever its age. The score threshold is 0.3, since relevance is the floor now.
- **Keywords count only where there is no vector.** A memory that has a vector the search did not return is not relevant by its
  words (a question's common words overlap with any memory); one with no vector, or any memory when no vector search ran, is found
  by keyword overlap from 0.2 of the search's words. The last test of the eval runs that path: Recall@8 0.185 (0.165 before),
  abstain rate 0.55 (0 before); 0.35 would fall to 0.015 Recall@8, 0.1 would rise to 0.212 with an abstain rate of 0.40.
- **Relevance leads the weights.** Recall@8 / NDCG@8 by semantic weight (the rest shared by confidence, importance and recency):
  0.45 (the old 0.18 / 0.12 / 0.25) 0.919 / 0.600; 0.55 0.938 / 0.660; 0.65 (0.12 / 0.08 / 0.15) 0.950 / 0.771; 0.75 0.954 / 0.879;
  0.85 0.958 / 0.911. The fixture's confidence, importance and ages are assumed, not read from extraction, so 0.65 is the middle.
- **The off-topic rate barely moves, by construction.** A query has one or two labelled rows and injects up to 8; the rest are rows
  of the same topic (another aspect), which a label cannot tell from noise. It falls with the noise rows and `mean injected` (8.00 → 6.78).
- **`search_memory` is not in the table.** It asks for cosine 0.35 (keyword 0.15), has no score threshold and returns up to 10; it is
  covered by `retrieve.test.ts` and `retrieve-ranking.test.ts`.
