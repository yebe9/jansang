"""Fetch pinned official source and model assets, with byte count/SHA-256 checks.

Only one Flan-T5 weight format is downloaded. Checkpoints remain in .models/ and
must not be committed or redistributed as part of the MIT source distribution.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen

SERVICE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SERVICE_DIR.parent


def model_directory() -> Path:
    configured = os.environ.get('MOTIONGPT_MODEL_DIR')
    return Path(configured).expanduser().resolve() if configured else PROJECT_DIR / '.models' / 'motiongpt'


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def fetch_file(url: str, target: Path, expected_bytes: int, expected_sha: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size == expected_bytes and digest(target) == expected_sha:
        print(f'Verified {target.name}', flush=True)
        return
    partial = target.with_name(target.name + '.part')
    if partial.is_file() and partial.stat().st_size >= expected_bytes:
        if partial.stat().st_size == expected_bytes and digest(partial) == expected_sha:
            partial.replace(target)
            print(f'Verified {target.name}', flush=True)
            return
        # This is only our incomplete/corrupt staging file, never an existing model.
        partial.write_bytes(b'')
    last_report = time.monotonic()
    retries = 0
    while (partial.stat().st_size if partial.is_file() else 0) < expected_bytes:
        offset = partial.stat().st_size if partial.is_file() else 0
        end = min(offset + 16 * 1024 * 1024 - 1, expected_bytes - 1)
        try:
            request = Request(url + ('&' if '?' in url else '?') + 'ghosting_download=' + str(int(time.time())),
                              headers={'User-Agent':'Ghosting-MotionGPT-CPU/1.0', 'Range':f'bytes={offset}-{end}'})
            with urlopen(request, timeout=60) as response:
                append = response.status == 206
                if append:
                    content_range = response.headers.get('Content-Range','')
                    if not content_range.startswith(f'bytes {offset}-') or not content_range.endswith(f'/{expected_bytes}'):
                        raise RuntimeError('Download returned an unexpected byte range.')
                    limit = end - offset + 1
                elif response.status == 200 and offset == 0 and expected_bytes <= 16 * 1024 * 1024:
                    limit = expected_bytes
                else:
                    raise RuntimeError('The download server did not honour the bounded range.')
                received = 0
                with partial.open('ab' if offset else 'wb') as output:
                    while chunk := response.read(min(1024 * 1024, limit - received + 1)):
                        received += len(chunk)
                        if received > limit:
                            raise RuntimeError('Download exceeded the requested byte range.')
                        output.write(chunk)
                if received != limit:
                    raise RuntimeError('The byte-range download ended early.')
            retries = 0
            done = partial.stat().st_size
            if time.monotonic() - last_report >= 5:
                print(f'{target.name}: {done / 1024 / 1024:.1f} / {expected_bytes / 1024 / 1024:.1f} MiB', flush=True)
                last_report = time.monotonic()
        except Exception as error:
            retries += 1
            if retries >= 3:
                raise RuntimeError(f'Download failed for {target.name}: {type(error).__name__}. Partial bytes remain for retry.') from error
            time.sleep(retries)
    if partial.stat().st_size != expected_bytes or digest(partial) != expected_sha:
        raise RuntimeError(f'Pinned SHA-256 or byte count did not match for {target.name}. No model was installed.')
    partial.replace(target)
    print(f'Verified {target.name}', flush=True)


def install_sources() -> None:
    manifest = json.loads((SERVICE_DIR / 'upstream.json').read_text(encoding='utf-8'))
    for entry in manifest['files']:
        target = (SERVICE_DIR / entry['local']).resolve()
        if not target.is_relative_to(SERVICE_DIR / 'vendor'):
            raise RuntimeError('Unsafe vendor destination.')
        url = f"https://raw.githubusercontent.com/OpenMotionLab/MotionGPT/{manifest['revision']}/{entry['upstream']}"
        fetch_file(url, target, entry['bytes'], entry['sha256'])
        current = target.parent
        while current.is_relative_to(SERVICE_DIR / 'vendor'):
            init = current / '__init__.py'
            if not init.exists():
                init.write_text('', encoding='utf-8')
            current = current.parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources-only', action='store_true')
    args = parser.parse_args()
    install_sources()
    if args.sources_only:
        return
    manifest = json.loads((SERVICE_DIR / 'model-artifacts.json').read_text(encoding='utf-8'))
    root = model_directory()
    print(f"Model assets: {manifest['totalBytes'] / 1e9:.3f} GB; target {root}", flush=True)
    print(manifest['weightsLicense'], flush=True)
    for entry in manifest['files']:
        target = (root / entry['path']).resolve()
        if not target.is_relative_to(root):
            raise RuntimeError('Unsafe model destination.')
        fetch_file(entry['url'], target, entry['bytes'], entry['sha256'])
    (root / 'download-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('MotionGPT CPU assets are ready to load. No inference has been run yet.', flush=True)


if __name__ == '__main__':
    main()
