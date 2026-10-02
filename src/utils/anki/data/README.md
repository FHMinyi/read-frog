# Pinned Anki vocabulary data

These files are derived from [ECDICT](https://github.com/skywind3000/ECDICT), by Linwei (skywind3000), at commit [`bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`](https://github.com/skywind3000/ECDICT/tree/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b). The upstream project distributes this snapshot under the [MIT License](https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/LICENSE).

The complete upstream copyright and permission notice is retained in [`public/licenses/anki-ecdict.txt`](../../../../public/licenses/anki-ecdict.txt). Keeping the notice in `public/` also includes it in built extension packages. `manifest.json` pins the source revision, source and license SHA-256 checksums, generated-file checksums, byte sizes and entry counts.

## What is included

- `cet4.txt`: headwords whose upstream whitespace-separated `tag` field contains exactly `cet4`
- `cet6.txt`: headwords whose upstream `tag` field contains exactly `cet6`
- `inflections.tsv`: ASCII single-word inflection-to-lemma relationships, one sorted row per form, with comma-separated sorted candidate lemmas

Only headwords, explicit exam-membership tags and inflection relationships are extracted. Definitions, translations, examples, audio, phonetics, source frequency rankings and other dictionary content are not copied.

ECDICT is a community-maintained compilation. Its README documents contributions and several earlier dictionary sources; this extraction relies on the upstream MIT grant and records that provenance, without claiming to have independently verified the rights history of every source entry. Exam tags are community reference memberships, not an official current CET syllabus, a complete coverage guarantee, an assessment of word difficulty, or a CEFR conversion. An unmatched word is unclassified. In particular, CET6 is not inferred from CET4: labels are independent and can overlap.

## Exact matching

Headwords are trimmed, lowercased, deduplicated and sorted by Unicode code point. Runtime lookup applies the same trim and lowercase operation. It does not remove punctuation, change spelling, stem words, or infer membership from related words. Upstream tagged abbreviations such as `i.e.` are preserved. The caller must determine a lemma separately before requesting membership.

Inflection extraction uses only the documented `p`, `d`, `i`, `3`, `r`, `t` and `s` codes (past, past participle, present participle, third-person singular, comparative, superlative and plural). Reverse `0` relationships are included only when the row also has nonempty `1` metadata made entirely of those codes and the referenced lemma exists in the same ASCII headword snapshot. This preserves reverse-only facts such as `were` → `be`. Case-equivalent rows are combined, not overwritten. Forms and lemmas must match `[a-z]+(?:[-'][a-z]+)*`; punctuation, spaces and malformed exchange strings are excluded rather than repaired or guessed.

Self-relations are omitted from disk. On every matched lookup, the runtime returns the unchanged input alongside all stored candidates, sorted deterministically. For example, `saw` returns `saw` and `see`; `axes` returns `ax`, `axe` and `axes`. This preserves ambiguity rather than merging senses without context. A missing relationship returns an empty array; callers retain their original input. There is no transitive stemming, morphological suffix heuristic or automatic selection of the first candidate.

This snapshot's `pos` column is entirely empty, so no part-of-speech data is fabricated or extracted. Exchange coverage is incomplete and can contain upstream errors. A candidate relationship is evidence for a contextual decision, not a claim that every usage of the surface word has that lemma.

## Reproduce or verify

Download the two pinned source files, then use the standard-library-only Python script from the repository root:

```sh
curl -fL https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv -o /tmp/ecdict.csv
curl -fL https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/LICENSE -o /tmp/ecdict-LICENSE
python3 scripts/generate-anki-vocabulary.py --csv /tmp/ecdict.csv --license /tmp/ecdict-LICENSE
python3 scripts/generate-anki-vocabulary.py --csv /tmp/ecdict.csv --license /tmp/ecdict-LICENSE --check
```

The script refuses inputs whose SHA-256 differs from the pinned source and license checksums. It makes no network requests. Generated files are UTF-8 with LF line endings. Updating the source requires an intentional revision/checksum change, a license/provenance review and regenerated test expectations. There are no runtime network dependencies.
