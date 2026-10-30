#!/usr/bin/env python3
"""Build a bounded Korean fastText dictionary without GPU or third-party Python packages.

The input is the official cc.ko.300.vec.gz text-vector archive (not a trained
binary fastText model). Only the first --limit unique Hangul words by frequency
plus explicit dance-expression forms are redistributed. No vectors are invented.
"""
import argparse
import array
import datetime
import gzip
import hashlib
import json
import math
import pathlib
import re
import shutil
import sys
import unicodedata
import urllib.request

SOURCE_URL = "https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.ko.300.vec.gz"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/3.0/"
HANGUL = re.compile(r"^[\u3130-\u318F\uac00-\ud7a3]+$")


def report(**values):
    print(json.dumps(values, ensure_ascii=False), flush=True)


def forms_from_sources(project):
    module = (project / "dist" / "semantic-similarity.js").read_text(encoding="utf-8")
    match = re.search(r"const MORPH_FORMS = Object\.freeze\((\{[\s\S]*?\})\);", module)
    if not match:
        raise RuntimeError("Cannot find the explicit morphological forms in semantic-similarity.js")
    forms = json.loads(match.group(1))
    vocabulary = (project / "api" / "dance-vocabulary.mjs").read_text(encoding="utf-8")
    labels = re.findall(r'"label"\s*:\s*"([^"]+)"', vocabulary)
    targets = set()
    for expression in labels + list(forms) + [value for values in forms.values() for value in values]:
        for word in unicodedata.normalize("NFC", expression).split():
            if HANGUL.fullmatch(word):
                targets.add(word)
    return labels, forms, targets


def download(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    report(phase="download", url=url, target=str(part))
    with urllib.request.urlopen(url, timeout=60) as response, part.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    part.replace(target)
    report(phase="downloaded", bytes=target.stat().st_size)


def quantize(values):
    maximum = max(abs(value) for value in values)
    if not maximum or not math.isfinite(maximum) or not all(math.isfinite(value) for value in values):
        return None
    # Per-row scaling need not be retained: cosine and normalized means are
    # invariant to a positive row scale. The browser renormalizes every row.
    return array.array("b", (max(-127, min(127, round(value / maximum * 127))) for value in values)).tobytes()


def build(source, output, project, limit):
    labels, forms, targets = forms_from_sources(project)
    selected = set()
    words = []
    encoded = bytearray()
    common = 0
    total_rows = 0
    malformed = 0
    required_found = set()
    with gzip.open(source, "rb") as rows:
        header = rows.readline().strip().split()
        if len(header) != 2:
            raise RuntimeError("Vector archive header is not a word-count/dimension pair")
        expected_count, dimension = map(int, header)
        if dimension != 300:
            raise RuntimeError("This builder expects the official 300-dimensional Korean vectors")
        report(phase="scan", declaredRows=expected_count, dimension=dimension, requestedCommonWords=limit, requiredForms=len(targets))
        for index, row in enumerate(rows, 1):
            total_rows = index
            token, separator, vector_bytes = row.rstrip().partition(b" ")
            if not separator:
                malformed += 1
                continue
            try:
                word = unicodedata.normalize("NFC", token.decode("utf-8"))
            except UnicodeDecodeError:
                malformed += 1
                continue
            if HANGUL.fullmatch(word) and word not in selected and (common < limit or word in targets):
                try:
                    values = [float(value) for value in vector_bytes.split()]
                except ValueError:
                    malformed += 1
                    continue
                if len(values) != dimension:
                    malformed += 1
                    continue
                vector = quantize(values)
                if vector is None:
                    malformed += 1
                    continue
                if common < limit:
                    common += 1
                selected.add(word)
                words.append(word)
                encoded.extend(vector)
                if word in targets:
                    required_found.add(word)
            if index % 100000 == 0:
                report(phase="scan", scanned=index, selected=len(words), requiredFound=len(required_found), requiredTotal=len(targets))
            # We deliberately scan the full archive to collect rare expression
            # forms and verify gzip integrity, rather than silently stop early.
    if total_rows != expected_count:
        raise RuntimeError(f"Archive row count is {total_rows}, expected {expected_count}; no deployment files were written")
    if common < limit:
        raise RuntimeError(f"Only {common} Korean words found; expected at least {limit}")
    output.mkdir(parents=True, exist_ok=True)
    binary_name = "ko-fasttext.int8.bin"
    manifest = {
        "format": "ghosting-fasttext-int8-v1",
        "model": "fastText cc.ko.300 / Common Crawl + Wikipedia (filtered, int8)",
        "dimension": dimension,
        "count": len(words),
        "vectorsFile": binary_name,
        "vectorsSha256": hashlib.sha256(encoded).hexdigest(),
        "quantization": "per-row max-absolute int8, browser L2 renormalization",
        "words": words,
        "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": {
            "url": SOURCE_URL,
            "documentation": "https://fasttext.cc/docs/en/crawl-vectors.html",
            "license": "CC-BY-SA-3.0",
            "licenseUrl": LICENSE_URL,
            "authors": "Edouard Grave, Piotr Bojanowski, Prakhar Gupta, Armand Joulin, Tomas Mikolov",
            "citation": "Learning Word Vectors for 157 Languages, LREC 2018",
            "modifications": f"First {limit} frequency-ranked unique Korean words plus explicit dance expressions; row-wise int8 quantization",
            "compressedArchiveBytes": source.stat().st_size,
            "declaredRows": expected_count,
        },
        "requiredFormsFound": sorted(required_found),
        "requiredFormsMissing": sorted(targets - required_found),
        "expressionCoverage": [
            {"label": label, "availableForms": [word for word in [label, *forms.get(label, []), *label.split()] if word in selected]}
            for label in labels
        ],
        "limitations": [
            "Word cosine similarity is not emotion probability or intent accuracy.",
            "Sentence averaging does not model word order, negation, or full context.",
            "The filtered text dictionary has no fastText subword inference: unregistered words remain unavailable.",
            "Morphological-form resolution is explicit and limited; polysemy and int8 quantization affect comparisons.",
        ],
    }
    bin_tmp = output / (binary_name + ".tmp")
    json_tmp = output / "ko-fasttext.json.tmp"
    bin_tmp.write_bytes(encoded)
    json_tmp.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    bin_tmp.replace(output / binary_name)
    json_tmp.replace(output / "ko-fasttext.json")
    (output / "LICENSE-CC-BY-SA-3.0.txt").write_text(
        "Filtered and quantized fastText Korean word vectors\n"
        "Original authors: Edouard Grave, Piotr Bojanowski, Prakhar Gupta, Armand Joulin, Tomas Mikolov.\n"
        "Original: https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.ko.300.vec.gz\n"
        "Reference: https://fasttext.cc/docs/en/crawl-vectors.html\n"
        "License: Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0)\n"
        "https://creativecommons.org/licenses/by-sa/3.0/\n"
        "Legal code: https://creativecommons.org/licenses/by-sa/3.0/legalcode\n"
        "Changes: frequency filtering and int8 row quantization, with source/provenance in ko-fasttext.json.\n"
        "This adapted vector dataset is distributed under the same CC BY-SA 3.0 license.\n",
        encoding="utf-8",
    )
    report(phase="complete", words=len(words), commonWords=common, binaryBytes=len(encoded), scanned=total_rows, malformedRows=malformed, requiredFound=len(required_found), requiredMissing=len(targets-required_found), unavailableExpressions=[entry["label"] for entry in manifest["expressionCoverage"] if not entry["availableForms"]], output=str(output))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, default=pathlib.Path(".models/cc.ko.300.vec.gz"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("dist/semantic"))
    parser.add_argument("--project", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument("--limit", type=int, default=50000)
    parser.add_argument("--download", action="store_true", help="Download the official archive if the source file does not exist")
    args = parser.parse_args()
    if not 1 <= args.limit <= 90000:
        parser.error("--limit must be between 1 and 90000")
    if not args.source.is_file():
        if not args.download:
            parser.error("Source is missing; download the official archive or pass --download")
        download(SOURCE_URL, args.source)
    build(args.source, args.output, args.project, args.limit)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({"phase": "error", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)