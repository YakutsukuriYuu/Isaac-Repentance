#!/usr/bin/env python3
"""Verify that an APK or IPA actually contains the pinned complete runtime.

Checks game/core bytes in the final installer, not only in the staging folder.
This is packaging verification, not a substitute for real-device gameplay tests.
"""
import argparse
import glob
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def check_record(archive, prefix, record):
    try:
        info = archive.getinfo(prefix + record['path'])
    except KeyError:
        raise ValueError(f'Installer is missing {record["path"]}') from None
    if info.is_dir() or info.file_size != record['size']:
        raise ValueError(f'Installer file size mismatch: {record["path"]}')
    checksum = hashlib.sha256()
    with archive.open(info) as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            checksum.update(block)
    if checksum.hexdigest() != record['sha256']:
        raise ValueError(f'Installer file checksum mismatch: {record["path"]}')


def verify(filename, kind, lock):
    if kind not in ('apk', 'ipa'):
        raise ValueError('Unsupported installer kind')
    if lock.get('format') != 'isaac-private-runtime-v1' or lock.get('assetManifest', {}).get('path') != 'asset-manifest.json':
        raise ValueError('Pinned lock must include the game asset manifest')
    with zipfile.ZipFile(filename) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Installer contains duplicate ZIP entries')
        for name in names:
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name:
                raise ValueError('Installer contains unsafe ZIP paths')
        if kind == 'apk':
            prefix = 'assets/public/'
            if 'AndroidManifest.xml' not in names or 'classes.dex' not in names:
                raise ValueError('APK has no Android application')
        else:
            candidates = [n for n in names if n.startswith('Payload/') and n.count('/') == 3 and n.endswith('.app/public/asset-manifest.json')]
            if len(candidates) != 1:
                raise ValueError('IPA must contain exactly one app with embedded game resources')
            prefix = candidates[0].removesuffix('asset-manifest.json')
            app_root = prefix.removesuffix('public/')
            if app_root + 'Info.plist' not in names:
                raise ValueError('IPA has no device application metadata')
            metadata = plistlib.loads(archive.read(app_root + 'Info.plist'))
            executable = metadata.get('CFBundleExecutable')
            if (not isinstance(executable, str) or not executable or executable in ('.', '..')
                    or '/' in executable or '\\' in executable
                    or app_root + executable not in names
                    or archive.getinfo(app_root + executable).file_size == 0):
                raise ValueError('IPA has no native application executable')
            if 'iPhoneOS' not in metadata.get('CFBundleSupportedPlatforms', []):
                raise ValueError('IPA must target a physical iOS device')
        for name in ('index.html', 'app.mjs', 'native-bootstrap.mjs', 'j835_game.mjs', 'j835_game.wasm', 'asset-manifest.json'):
            if prefix + name not in names:
                raise ValueError(f'Installer is missing {name}')
        # The manifest itself must be pinned outside the installer. Otherwise a
        # shortened manifest could hide omitted game files while passing all
        # checks against its own truncated inventory.
        check_record(archive, prefix, lock['assetManifest'])
        manifest = json.loads(archive.read(prefix + 'asset-manifest.json'))
        if manifest.get('target') != lock['target'] or manifest.get('mods') or not manifest.get('files'):
            raise ValueError('Installer targets the wrong game or bundles preinstalled Mods')
        records = [{**r, 'path': r['path'].removeprefix('core/')} for r in lock['core']]
        records += [{**r, 'path': 'assets/' + r['path']} for r in manifest['files']]
        for record in records:
            check_record(archive, prefix, record)
        if any('userdata' in PurePosixPath(n).parts or '.storage' in PurePosixPath(n).parts
               or n.startswith(prefix + 'mods/') for n in names):
            raise ValueError('Installer includes player data or preinstalled Mods')
    print(f'Verified {Path(filename).name}: {len(records)} complete game/core files')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['apk', 'ipa'])
    parser.add_argument('files', nargs='+')
    parser.add_argument('--lock', type=Path, default=ROOT / 'packaging/runtime.lock.json')
    args = parser.parse_args()
    files = sorted({name for pattern in args.files for name in glob.glob(pattern)})
    if not files:
        raise ValueError('No installers were produced')
    lock = json.loads(args.lock.read_text())
    for name in files:
        verify(name, args.kind, lock)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f'Installer verification failed: {error}', file=sys.stderr)
        sys.exit(1)
