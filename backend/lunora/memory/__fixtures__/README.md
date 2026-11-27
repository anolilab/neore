# Retrieval eval fixture

Data for `../retrieval-eval.test.ts`: does long-term memory retrieval inject the right memories? Everything here is
synthetic; there are no real people and nothing comes from a public benchmark.

## Files

- `retrieval-eval-phrases.json` — the hand-written phrase bank: 16 hobby topics, each with six facts (one per aspect),
  six questions that paraphrase them, an event phrase and five per-persona details; plus questions about topics nobody has.
- `build-retrieval-eval.mjs` — combines the bank with a seeded random generator into personas, memories and queries.
  The script is deterministic: `node backend/lunora/memory/__fixtures__/build-retrieval-eval.mjs`, then
  `npx oxfmt backend/lunora/memory/__fixtures__`, rewrites `retrieval-eval.json` identically. The phrases and the
  labelling rules are written by hand; the 1,146 memory rows and their ages, confidences and tags are generated. The
  ages and the confidence and importance ranges are assumed (older rows are more common; identity rows score higher
  than activity rows), not read from what extraction emits.
- `retrieval-eval.json` — the fixture the test reads.

## What is in it

- 5 personas with 190 to 272 memories each (145 to 199 own active rows). Each has more than the 100 rows of the
  candidate window, so which rows reach scoring matters.
- Types: identity, preference, context, activity, experience. Dated rows (`eventStart`, `validUntil` in the past, today and
  ahead), older versions of a fact (replaced, expired, or still active but confirmed longer ago), pinned rows, rows of two bots (`bot-a` joins some chats, `bot-b` never does), expired rows,
  low-signal filler, and a few rows with no vector (`noVector`).
- 150 queries (30 per persona), each labelled with the memory ids a good retrieval returns:

| Category   | Queries | Label                                              |
| ---------- | ------- | -------------------------------------------------- |
| `single`   | 50      | one fact                                           |
| `multi`    | 30      | two facts of one topic, learned at different times |
| `temporal` | 30      | the event that happened in a named month           |
| `update`   | 20      | the newest statement; an older version also exists |
| `abstain`  | 20      | none: the topic was never mentioned                |

## Vectors without a model

No embedding model is called. Each memory and each query carries `tags`: sparse weights over 64 dimensions that the test
expands and normalises, so cosine similarity is meaningful and stable.

- dims 0-15: topic. 16-21: topics nobody has (for `abstain`). 22-27: aspect (who, likes, setup, recent, history, plan).
- dim 28: a shared background weight, so unrelated texts are not at cosine 0, as with a real model.
- dims 29-40: month (events and `temporal` queries). 41-63: two noise dims per row.

The test simulates the vector step as production runs it: the top 30 of all of the user's vectors (other bots', expired
and superseded rows included), the superseded ones then dropped; every other candidate falls back to the keyword score.
`now` and `today` come from `meta`, never the clock.

## Metrics

Per query, `injected` is what `rankMemories` returns (at most 8) for the window `selectCandidateWindow` builds. Vitest
hides console output of a passing run; print the table with
`cd backend && npx vitest run lunora/memory/retrieval-eval.test.ts --silent=false`.

- **Recall@8**: expected ids injected / expected ids. **NDCG@8**: binary gains over the injected order. Both over the
  130 queries that have a label.
- **Expected in window**: expected ids that are candidates at all / expected ids. It separates a row the window loses
  from a row the ranking loses.
- **Off-topic rate**: injected rows not in the label / injected rows, over all 150 queries (so an `abstain` query that
  injects anything counts fully).
- **Abstain precision**: `abstain` queries that inject nothing / `abstain` queries.

## Baseline

Measured on this fixture before any retrieval change; the test fails when a metric is 0.02 worse than this (the
off-topic rate: 0.02 higher).

| Slice    | Recall@8 | NDCG@8 | Expected in window | Off-topic rate | Abstain precision |
| -------- | -------- | ------ | ------------------ | -------------- | ----------------- |
| overall  | 0.608    | 0.427  | 0.619              | 0.914          | 0.000             |
| single   | 0.720    | 0.475  | 0.740              | 0.910          |                   |
| multi    | 0.800    | 0.657  | 0.817              | 0.800          |                   |
| temporal | 0.000    | 0.000  | 0.000              | 1.000          |                   |
| update   | 0.950    | 0.601  | 0.950              | 0.881          |                   |
| abstain  |          |        |                    | 1.000          | 0.000             |

Every query injects 8 rows: any memory confirmed in the last weeks, or pinned, clears the 0.4 threshold without a
semantic match. So the abstain floor is 0 and can only show an improvement. `temporal` is 0 because an `activity` row
sorts last in the window's type-descending order, past the 100-row cut: none of its labelled rows is a candidate. A
retrieval change that improves a metric should raise the number in `BASELINE` in the same pull request.
