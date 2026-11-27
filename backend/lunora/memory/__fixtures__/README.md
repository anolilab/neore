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

The test simulates the vector step as production runs it: the top `VECTOR_TOP_K` (30) of all of the user's vectors (other bots', expired
and superseded rows included), the superseded ones then dropped; every other candidate falls back to the keyword score.
`now` and `today` come from `meta`, never the clock.

## Metrics

Per query, `injected` is what `rankMemories` returns (at most 8) for the window `selectCandidateWindow` builds at `CANDIDATE_WINDOW_SIZE` (100). The test imports both limits from
`../retrieve-ranking.ts`, the constants `retrieve.ts` uses, so changing one in production changes what the eval measures. Vitest
hides console output of a passing run; print the table with
`cd backend && npx vitest run lunora/memory/retrieval-eval.test.ts --silent=false`.

- **Recall@8**: expected ids injected / expected ids. **NDCG@8**: binary gains over the injected order. Both over the
  130 queries that have a label.
- **Expected in window**: expected ids that are candidates at all / expected ids. It separates a row the window loses
  from a row the ranking loses.
- **Off-topic rate**: injected rows not in the label / injected rows, over all 150 queries (so an `abstain` query that
  injects anything counts fully).
- **Abstain rate**: share of never-mentioned (`abstain`) queries that inject nothing = `abstain` queries with no injected
  row / `abstain` queries.
- **Abstain precision**: of the queries that inject nothing, the share labelled `abstain`. Undefined while every query
  injects something (today), so it is printed but not gated.

## Baseline

Measured on this fixture before any retrieval change; the test fails when a metric is 0.02 worse than this (the
off-topic rate, overall and per category: 0.02 higher; expected in window, overall and per category: 0.02 lower). The
numbers moved from the first version of this fixture because the fixture was corrected (created-before-confirmed
timestamps, and past-tense questions about events that had not happened yet), not because retrieval changed.

| Slice    | Recall@8 | NDCG@8 | Expected in window | Off-topic rate | Abstain rate | Abstain precision |
| -------- | -------- | ------ | ------------------ | -------------- | ------------ | ----------------- |
| overall  | 0.600    | 0.431  | 0.638              | 0.917          | 0.000        | undefined         |
| single   | 0.740    | 0.543  | 0.780              | 0.907          |              |                   |
| multi    | 0.733    | 0.559  | 0.833              | 0.817          |              |                   |
| temporal | 0.033    | 0.033  | 0.033              | 0.996          |              |                   |
| update   | 0.900    | 0.554  | 0.900              | 0.887          |              |                   |
| abstain  |          |        |                    | 1.000          | 0.000        | undefined         |

Every query injects 8 rows: any memory confirmed in the last weeks, or pinned, clears the 0.4 threshold without a
semantic match. So the abstain floor is 0 and can only show an improvement. `temporal` is near 0 because an `activity`
row sorts last in the window's type-descending order, past the 100-row cut: all but one of its labelled rows are not
candidates. A retrieval change that improves a metric should raise the number in `BASELINE` in the same pull request.
