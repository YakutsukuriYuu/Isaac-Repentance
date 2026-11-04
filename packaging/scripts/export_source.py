#!/usr/bin/env python3
"""Export the exact, reviewable source tree intended for GitHub.

Use an explicit allowlist rather than copying the development workspace. No game
resources, compiled Wasm, saves, imported Mods, credentials or toolchains enter it.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_inputs import WEB_FILES

BLOCKED_DIRS = {'node_modules', 'www', 'android', 'ios', 'runtime', 'dist',
                '__pycache__', '.git', '.release-inputs', '.release-build',
                'output', '.build', '.test-results', 'assets', 'userdata',
                'private', 'secrets', 'credentials', 'keys'}
PACKAGING_FILES = (
    'SOURCE_README.md', 'GITHUB_SETUP.md', 'VALIDATION.md', 'RELEASE_NOTES.md', 'runtime.lock.json',
    'mobile/package.json', 'mobile/package-lock.json', 'mobile/capacitor.config.json',
    'mobile/PrivacyInfo.xcprivacy', 'mobile/README.md',
    'desktop/package.json', 'desktop/package-lock.json', 'desktop/main.mjs',
    'desktop/runtime-server.mjs', 'desktop/build.mjs', 'desktop/README.md',
    'desktop/entitlements.mac.plist', 'desktop/entitlements.adhoc.plist',
)
SOURCE_SUBTREES = {
    'packaging/scripts': {'.py'},
    'packaging/tests': {'.py'},
    'packaging/mobile/src': {'.mjs', '.js', '.ts'},
    'packaging/mobile/scripts': {'.mjs', '.js'},
    'packaging/mobile/tests': {'.mjs', '.js'},
    'packaging/desktop/test': {'.mjs', '.js'},
    '.github/workflows': {'.yml', '.yaml'},
}


def excluded(path):
    return any(part.lower() in BLOCKED_DIRS or part.lower().startswith('.env') for part in path.parts)


def source_files(root=ROOT):
    names = {'.gitignore', *('packaging/' + name for name in PACKAGING_FILES)}
    for subtree, suffixes in SOURCE_SUBTREES.items():
        directory = root / subtree
        if directory.exists():
            for path in directory.rglob('*'):
                rel = path.relative_to(root)
                if excluded(rel):
                    continue
                if path.is_file() and path.suffix in suffixes:
                    names.add(rel.as_posix())
    web = root / 'Isaac-Repentance/project/web'
    for name in (*WEB_FILES, 'test_save_helpers.mjs', 'test_mod_helpers.mjs',
                 'test_disk_storage.mjs', 'test_fps_metrics.mjs', 'test_session_controls.mjs'):
        names.add((web / name).relative_to(root).as_posix())
    for path in (root / 'portable/launcher').iterdir():
        if path.is_file() and (path.suffix == '.go' or path.name in {'go.mod', 'go.sum', 'README.md'}):
            names.add(path.relative_to(root).as_posix())
    for path in (root / 'Isaac-Repentance/project/licenses').rglob('*'):
        if path.is_file():
            names.add(path.relative_to(root).as_posix())
    for name in ('portable/THIRD_PARTY_NOTICES.md', 'Isaac-Repentance/project/THIRD_PARTY_NOTICES.md'):
        if (root / name).is_file():
            names.add(name)
    for name in sorted(names):
        path = root / name
        current = root
        linked = False
        for part in Path(name).parts:
            current = current / part
            linked = linked or current.is_symlink()
        if excluded(Path(name)) or not path.is_file() or linked:
            raise ValueError(f'Missing or linked source file: {name}')
        if path.stat().st_size > 5 * 1024**2:
            raise ValueError(f'Unexpected large source file: {name}')
        yield name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--list', action='store_true')
    args = parser.parse_args()
    names = list(source_files())
    if args.list:
        print('\n'.join(names))
        return
    if not args.output:
        parser.error('--output is required unless --list is used')
    output = args.output.absolute()
    if output.exists():
        raise ValueError('Export destination already exists; choose a new directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.github-source-', dir=output.parent) as temp:
        staged = Path(temp) / 'source'
        staged.mkdir()
        records = []
        for name in names:
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
            target.chmod(0o755 if target.suffix == '.sh' else 0o644)
            records.append({'path': name, 'bytes': target.stat().st_size,
                            'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        shutil.copyfile(ROOT / 'packaging/SOURCE_README.md', staged / 'README.md')
        (staged / 'source-export.json').write_text(json.dumps({'format': 'isaac-source-export-v1', 'files': records}, indent=2) + '\n')
        staged.rename(output)
    print(json.dumps({'sourceDirectory': str(output), 'files': len(records) + 2,
                      'gameResourcesIncluded': False, 'wasmIncluded': False, 'playerDataIncluded': False}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print(f'Source export failed: {error}', file=sys.stderr)
        sys.exit(1)
