#!/usr/bin/env python3
"""Reproduce Anki vocabulary data from the pinned, local ECDICT source files.

This script does not download data. See src/utils/anki/data/README.md.
"""

import argparse
import csv
import hashlib
import io
import json
import re
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "src/utils/anki/data"
REVISION = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
SOURCE_SHA256 = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
LICENSE_SHA256 = "f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f"
REPOSITORY = "https://github.com/skywind3000/ECDICT"
ASCII_WORD = re.compile(r"[a-z]+(?:[-'][a-z]+)*")
INFLECTION_CODES = frozenset("pdi3rts")


def digest(content):
    return hashlib.sha256(content).hexdigest()


def verified_read(path, expected):
    content = path.read_bytes()
    if digest(content) != expected:
        raise ValueError(f"Unexpected SHA-256 for {path}; refusing to change pinned data")
    return content


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, type=Path)
    parser.add_argument("--license", required=True, type=Path)
    parser.add_argument("--check", action="store_true", help="Verify instead of writing")
    args = parser.parse_args()
    source = verified_read(args.csv, SOURCE_SHA256)
    license_text = verified_read(args.license, LICENSE_SHA256)

    memberships = {"cet4": set(), "cet6": set()}
    exchanges = defaultdict(list)
    source_rows = 0
    for row in csv.DictReader(io.StringIO(source.decode("utf-8"), newline="")):
        source_rows += 1
        word = row["word"].strip().lower()
        for tag in row["tag"].split():
            if tag in memberships:
                memberships[tag].add(word)
        if ASCII_WORD.fullmatch(word):
            exchanges[word].append(dict(
                part.split(":", 1) for part in row["exchange"].split("/") if ":" in part
            ))

    candidates = defaultdict(set)
    for word, entries in exchanges.items():
        # Case-folding can unite several source rows; union their evidence
        # rather than silently replacing one relationship with another.
        for exchange in entries:
            for code, raw_form in exchange.items():
                form = raw_form.strip().lower()
                if code in INFLECTION_CODES and ASCII_WORD.fullmatch(form):
                    candidates[form].add(word)
            lemma = exchange.get("0", "").strip().lower()
            codes = exchange.get("1", "")
            # A reverse lemma alone could be a derivation. Require explicit
            # inflection metadata and a real headword in the same source snapshot.
            if lemma in exchanges and codes and set(codes) <= INFLECTION_CODES:
                candidates[word].add(lemma)

    # The runtime always preserves the input itself. Self-only relationships
    # need no storage and do not authorize a merge into a different headword.
    for form in list(candidates):
        candidates[form].discard(form)
        if not candidates[form]:
            del candidates[form]

    outputs = {}
    for level, words in memberships.items():
        outputs[DATA / f"{level}.txt"] = ("\n".join(sorted(words)) + "\n").encode("utf-8")
    outputs[DATA / "inflections.tsv"] = "".join(
        form + "\t" + ",".join(sorted(lemmas)) + "\n"
        for form, lemmas in sorted(candidates.items())
    ).encode("utf-8")
    # public/ is copied into extension packages, retaining the upstream notice
    # when the generated headwords and inflection facts are redistributed.
    notice = (
        "Read Frog Anki vocabulary data\n\n"
        "Headword memberships and inflection relationships derived from ECDICT.\n"
        f"Source: {REPOSITORY}\n"
        f"Pinned revision: {REVISION}\n"
        "Only headwords, CET4/CET6 tags and inflection relationships are included.\n"
        "Definitions, translations, pronunciations and examples are not included.\n"
        "CET tags are community-maintained reference memberships, not official\n"
        "exam coverage, a difficulty score, or a CEFR equivalence.\n\n"
    ).encode("utf-8") + license_text
    outputs[ROOT / "public/licenses/anki-ecdict.txt"] = notice

    manifest = {
        "source": {
            "name": "ECDICT",
            "author": "Linwei (skywind3000)",
            "repository": REPOSITORY,
            "revision": REVISION,
            "file": "ecdict.csv",
            "url": f"https://raw.githubusercontent.com/skywind3000/ECDICT/{REVISION}/ecdict.csv",
            "sha256": SOURCE_SHA256,
            "rows": source_rows,
            "license": "MIT",
            "licenseUrl": f"{REPOSITORY}/blob/{REVISION}/LICENSE",
            "licenseSha256": LICENSE_SHA256,
        },
        "generatedBy": "scripts/generate-anki-vocabulary.py",
        "files": {
            str(path.relative_to(ROOT)): {"sha256": digest(content), "bytes": len(content)}
            for path, content in outputs.items()
        },
        "counts": {
            "cet4": len(memberships["cet4"]),
            "cet6": len(memberships["cet6"]),
            "overlap": len(memberships["cet4"] & memberships["cet6"]),
            "inflectionForms": len(candidates),
            "inflectionFormsWithMultipleLemmas": sum(len(lemmas) > 1 for lemmas in candidates.values()),
        },
    }
    outputs[DATA / "manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")

    for path, content in outputs.items():
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                raise ValueError(f"Vendored data does not match pinned source: {path}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    print(json.dumps(manifest["counts"], sort_keys=True))
    print("Verified pinned vocabulary data" if args.check else "Generated pinned vocabulary data")


if __name__ == "__main__":
    main()
