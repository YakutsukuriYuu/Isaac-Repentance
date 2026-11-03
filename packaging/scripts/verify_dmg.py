#!/usr/bin/env python3
"""Verify a complete macOS installer from a read-only mounted DMG.

The pinned external manifest prevents an incomplete installer from validating
itself against a shortened resource inventory. This checks packaging integrity;
it does not replace real-device gameplay or Developer ID notarization tests.
"""
import argparse
import glob
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile

# Works both as a CLI and when imported directly by the isolated unit tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_inputs import (FORMAT, ROOT, TARGET, WEB_FILES, digest, project_files,
                            read_json, regular, verify_record)

FORBIDDEN_DATA = {'userdata', 'mods', 'mod-data', 'saves', '.storage'}
CPUS = {0x01000007: 'x64', 0x0100000c: 'arm64'}


def run_command(command, timeout=120):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode:
        detail = result.stderr.decode('utf-8', 'replace').strip()
        raise ValueError(f'{Path(command[0]).name} failed ({result.returncode}): {detail}')
    return result.stdout


def native_executable(root, name):
    executable = regular(root, name)
    if not executable.stat().st_mode & 0o111 or not os.access(executable, os.X_OK):
        raise ValueError(f'Application binary is not executable: {name}')
    with executable.open('rb') as stream:
        header = stream.read(8)
    if len(header) != 8 or header[:4] != b'\xcf\xfa\xed\xfe':
        raise ValueError(f'Expected a 64-bit macOS executable: {name}')
    arch = CPUS.get(int.from_bytes(header[4:], 'little'))
    if not arch:
        raise ValueError(f'Unsupported macOS architecture: {name}')
    return executable, arch


def verify_application(app, lock, expected_arch=None, runner=run_command):
    app = Path(app)
    if app.is_symlink() or not app.is_dir() or app.suffix != '.app':
        raise ValueError('DMG must contain an ordinary application bundle')
    if (lock.get('format') != FORMAT or lock.get('target') != TARGET
            or lock.get('assetManifest', {}).get('path') != 'asset-manifest.json'):
        raise ValueError('Pinned lock must include the J835 game asset manifest')
    metadata = plistlib.loads(regular(app, 'Contents/Info.plist').read_bytes())
    executable_name = metadata.get('CFBundleExecutable')
    if (metadata.get('CFBundlePackageType') != 'APPL' or not isinstance(executable_name, str)
            or not executable_name or executable_name in ('.', '..')
            or '/' in executable_name or '\\' in executable_name):
        raise ValueError('Application metadata has no valid native executable')
    _, arch = native_executable(app, 'Contents/MacOS/' + executable_name)
    if expected_arch and arch != expected_arch:
        raise ValueError(f'Installer architecture is {arch}, expected {expected_arch}')
    runtime = app / 'Contents/Resources/runtime'
    project = runtime / 'project'
    regular(app, 'Contents/Resources/runtime/project/project.json')
    if runtime.is_symlink() or project.is_symlink() or not runtime.is_dir() or not project.is_dir():
        raise ValueError('Application has no embedded ordinary runtime directory')
    actual_files = set()
    for entry in runtime.rglob('*'):
        name = entry.relative_to(runtime)
        if any(part.lower() in FORBIDDEN_DATA for part in name.parts):
            raise ValueError(f'Installer includes player data or preinstalled Mods: {name}')
        if entry.is_symlink() or not (entry.is_file() or entry.is_dir()):
            raise ValueError(f'Runtime contains a symlink or special file: {name}')
        if entry.is_file():
            actual_files.add(name.as_posix())
    # Pin the inventory first, then verify every resource listed by that inventory.
    verify_record(project, lock['assetManifest'])
    config = read_json(regular(project, 'project.json'))
    if config.get('core') != lock.get('core'):
        raise ValueError('Installer core version differs from the pinned lock')
    private_files = set(project_files(project))
    if 'fileCount' in lock and len(private_files) != lock['fileCount']:
        raise ValueError('Private runtime inventory differs from the pinned file count')
    for name in WEB_FILES:
        regular(project, 'web/' + name)
    expected_files = {'isaac-launcher'} | {'project/' + name for name in private_files}
    expected_files |= {'project/web/' + name for name in WEB_FILES}
    stage_file = project / '.isaac-stage.json'
    if stage_file.exists():
        stage = read_json(regular(project, '.isaac-stage.json'))
        if stage != {'format': FORMAT, 'target': 'desktop', 'game': TARGET, 'preinstalledMods': 0}:
            raise ValueError('Embedded stage receipt is inconsistent')
        expected_files.add('project/.isaac-stage.json')
    if actual_files != expected_files:
        extra = sorted(actual_files - expected_files)
        missing = sorted(expected_files - actual_files)
        raise ValueError(f'Unexpected runtime inventory; extra={extra}, missing={missing}')
    launcher, launcher_arch = native_executable(runtime, 'isaac-launcher')
    if arch != launcher_arch:
        raise ValueError('Application and bundled launcher architectures differ')
    runner(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])
    # --check returns before the launcher opens or creates any user-data store.
    # The DMG is mounted read-only, making accidental package writes fail too.
    result = runner([str(launcher), '--root', str(project), '--check'])
    if b'Verification passed:' not in result:
        raise ValueError('Bundled launcher did not confirm the complete runtime')
    if any((runtime / name).exists() for name in FORBIDDEN_DATA):
        raise ValueError('Launcher verification unexpectedly created user data')
    return {'application': app.name, 'architecture': arch,
            'runtimeFiles': len(actual_files),
            'gameFiles': len(read_json(project / 'asset-manifest.json')['files']),
            'coreFiles': len(config['core']), 'codeSignatureVerified': True,
            'launcherCheckPassed': True}


def verify(filename, lock, expected_arch=None, runner=run_command):
    filename = Path(filename).absolute()
    if filename.is_symlink() or not filename.is_file() or filename.suffix.lower() != '.dmg':
        raise ValueError('Expected a regular DMG installer file')
    runner(['/usr/bin/hdiutil', 'verify', str(filename)])
    with tempfile.TemporaryDirectory(prefix='isaac-dmg-verify-') as temporary:
        mount = Path(temporary) / 'mount'
        mount.mkdir(mode=0o700)
        mount = mount.resolve()
        attached = False
        try:
            result = runner(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse',
                             '-plist', '-mountpoint', str(mount), str(filename)])
            # Record attachment before parsing, so invalid output still detaches.
            attached = True
            info = plistlib.loads(result)
            mounts = [Path(entity['mount-point']).resolve()
                      for entity in info.get('system-entities', []) if 'mount-point' in entity]
            if mounts != [mount] or not os.path.ismount(mount):
                raise ValueError('DMG was not mounted at its private verification path')
            applications = [entry for entry in mount.iterdir() if entry.suffix == '.app']
            if len(applications) != 1:
                raise ValueError('DMG must contain exactly one application bundle')
            report = verify_application(applications[0], lock, expected_arch, runner)
            report.update({'installer': filename.name, 'bytes': filename.stat().st_size,
                           'sha256': digest(filename), 'diskImageVerified': True})
        finally:
            if attached or os.path.ismount(mount):
                try:
                    runner(['/usr/bin/hdiutil', 'detach', str(mount)], timeout=30)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    # This is our private read-only mount, never a user's volume.
                    runner(['/usr/bin/hdiutil', 'detach', '-force', str(mount)], timeout=30)
    print(json.dumps(report, sort_keys=True))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='+')
    parser.add_argument('--lock', type=Path, default=ROOT / 'packaging/runtime.lock.json')
    parser.add_argument('--arch', choices=['arm64', 'x64'])
    args = parser.parse_args()
    files = sorted({name for pattern in args.files for name in glob.glob(pattern)})
    if not files:
        raise ValueError('No DMG installers were produced')
    lock = read_json(args.lock)
    for name in files:
        verify(name, lock, args.arch)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, plistlib.InvalidFileException,
            subprocess.TimeoutExpired) as error:
        print(f'DMG verification failed: {error}', file=sys.stderr)
        sys.exit(1)
