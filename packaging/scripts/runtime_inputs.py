#!/usr/bin/env python3
"""Separate private runtime inputs from uploadable application source.

Only the authenticated J835 core, game resources and license notices enter the
private archive. User data and the editable web frontend are never archived.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
TARGET = 'Repentance 1.7.9b.J835'
FORMAT = 'isaac-private-runtime-v1'
MAX_BYTES = 2 * 1024**3
WEB_FILES = ('index.html', 'styles.css', 'app.mjs', 'save_helpers.mjs',
             'mod_helpers.mjs', 'disk_storage.mjs', 'touch_controls.mjs',
             'touch_layout.mjs', 'fps_metrics.mjs', 'gamepad_input.mjs',
             'remote_assets.mjs')


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            result.update(block)
    return result.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def safe_path(name):
    if (not isinstance(name, str) or not name or str(PurePosixPath(name)) != name
            or name.startswith('/') or any(p in ('.', '..') for p in name.split('/'))
            or any(c in name for c in '\\:\x00') or any(ord(c) < 32 for c in name)):
        raise ValueError('Invalid runtime path')
    return name


def regular(root, name):
    safe_path(name)
    target = root / name
    current = root
    for part in PurePosixPath(name).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f'Symlinks are not permitted in runtime inputs: {name}')
    if not target.is_file() or not target.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Missing runtime file: {name}')
    return target


def verify_record(root, record):
    path = regular(root, record['path'])
    if (not isinstance(record.get('size'), int) or record['size'] < 0
            or not re.fullmatch('[0-9a-f]{64}', record.get('sha256', ''))
            or path.stat().st_size != record['size'] or digest(path) != record['sha256']):
        raise ValueError(f'Runtime checksum mismatch: {record["path"]}')
    return path


def project_files(project):
    project = Path(project).absolute()
    config = read_json(regular(project, 'project.json'))
    manifest = read_json(regular(project, 'asset-manifest.json'))
    if (config.get('format') != 'isaac-j835-development-v2'
            or config.get('appId') != 'isaac-j835-portable'
            or config.get('target') != TARGET or config.get('preinstalledMods') != 0
            or manifest.get('target') != TARGET or manifest.get('mods')):
        raise ValueError('Expected the J835 project without preinstalled Mods')
    if {r['path'] for r in config['core']} != {'core/j835_game.mjs', 'core/j835_game.wasm'} or len(config['core']) != 2:
        raise ValueError('Both verified Wasm core files are required')
    files = {'project.json', 'asset-manifest.json'}
    for record in config['core']:
        verify_record(project, record)
        files.add(record['path'])
    seen, exact_names = set(), set()
    if not manifest.get('files'):
        raise ValueError('Game resources are missing')
    for record in manifest['files']:
        name = safe_path(record['path'])
        if name.lower() in seen or urllib.parse.unquote(record['url']) != '/assets/' + name:
            raise ValueError('Duplicate resource or non-local asset URL')
        seen.add(name.lower())
        exact_names.add(name)
        verify_record(project, {**record, 'path': 'assets/' + name})
        files.add('assets/' + name)
    if 'isaac-ng.exe.unpacked.exe' not in exact_names:
        raise ValueError('Authenticated game executable is missing')
    if (project / 'THIRD_PARTY_NOTICES.md').exists():
        regular(project, 'THIRD_PARTY_NOTICES.md')
        files.add('THIRD_PARTY_NOTICES.md')
    if (project / 'licenses').exists():
        if (project / 'licenses').is_symlink():
            raise ValueError('Symlinks are not permitted in runtime licenses')
        for path in (project / 'licenses').rglob('*'):
            if path.is_file() or path.is_symlink():
                name = path.relative_to(project).as_posix()
                regular(project, name)
                files.add(name)
    return sorted(files)


def pack(project, output, lock_path):
    project, output = Path(project).absolute(), Path(output).absolute()
    names = project_files(project)
    if len(names) > 999:
        raise ValueError('Runtime inventory exceeds the 999-file limit')
    records = [{'path': 'project/' + name, 'size': (project / name).stat().st_size,
                'sha256': digest(project / name)} for name in names]
    if sum(r['size'] for r in records) > MAX_BYTES:
        raise ValueError('Runtime inputs exceed the 2 GiB unpacked limit')
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError('Archive already exists; choose a new output name')
    receipt = {'format': FORMAT, 'target': TARGET, 'files': records}
    temporary = output.with_suffix(output.suffix + '.partial')
    import io
    try:
        with temporary.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0, compresslevel=1) as zipped:
            with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                data = (json.dumps(receipt, sort_keys=True, indent=2) + '\n').encode()
                info = tarfile.TarInfo('runtime-input.json')
                info.size, info.mode = len(data), 0o644
                archive.addfile(info, io.BytesIO(data))
                for record in records:
                    info = tarfile.TarInfo(record['path'])
                    info.size, info.mode = record['size'], 0o644
                    with (project / record['path'].removeprefix('project/')).open('rb') as stream:
                        archive.addfile(info, stream)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    lock = {'format': FORMAT, 'target': TARGET, 'archive': output.name,
            'sha256': digest(output), 'bytes': output.stat().st_size,
            'unpackedBytes': sum(r['size'] for r in records), 'fileCount': len(records),
            'core': read_json(project / 'project.json')['core'],
            'assetManifest': {'path': 'asset-manifest.json',
                              'size': (project / 'asset-manifest.json').stat().st_size,
                              'sha256': digest(project / 'asset-manifest.json')}}
    write_json(lock_path, lock)
    print(json.dumps({'archive': str(output), 'lock': str(lock_path), **lock}, indent=2))


def allowed_archive_path(name):
    safe_path(name)
    return (name in {'runtime-input.json', 'project/project.json', 'project/asset-manifest.json',
                     'project/THIRD_PARTY_NOTICES.md', 'project/core/j835_game.mjs', 'project/core/j835_game.wasm'}
            or name.startswith('project/assets/') or name.startswith('project/licenses/'))


def unpack(archive_path, destination, lock_path):
    archive_path, destination = Path(archive_path), Path(destination).absolute()
    lock = read_json(lock_path)
    if lock.get('format') != FORMAT or lock.get('target') != TARGET or archive_path.stat().st_size != lock['bytes'] or digest(archive_path) != lock['sha256']:
        raise ValueError('Private runtime archive does not match the pinned lock')
    if destination.exists():
        raise ValueError('Extraction destination must not already exist')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.runtime-input-', dir=destination.parent) as temp:
        extracted = Path(temp) / 'input'
        extracted.mkdir()
        seen, total = set(), 0
        with tarfile.open(archive_path, 'r:gz') as archive:
            for entry in archive:
                if (not entry.isfile() or not allowed_archive_path(entry.name)
                        or entry.name.lower() in seen or len(seen) >= 1000
                        or entry.size < 0 or (total + entry.size) > MAX_BYTES):
                    raise ValueError('Unexpected or unsafe private archive member')
                seen.add(entry.name.lower())
                total += entry.size
                output = extracted / entry.name
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as source, output.open('xb') as target:
                    shutil.copyfileobj(source, target, 1024**2)
                output.chmod(0o644)
        receipt = read_json(extracted / 'runtime-input.json')
        if receipt.get('format') != FORMAT or receipt.get('target') != TARGET:
            raise ValueError('Private archive receipt is incompatible')
        records = receipt['files']
        if (len(records) != lock['fileCount'] or sum(r['size'] for r in records) != lock['unpackedBytes']
                or {r['path'].lower() for r in records} != seen - {'runtime-input.json'}
                or len({r['path'].lower() for r in records}) != len(records)):
            raise ValueError('Private archive inventory mismatch')
        for record in records:
            verify_record(extracted, record)
        names = project_files(extracted / 'project')
        if {'project/' + name for name in names} != {r['path'] for r in records}:
            raise ValueError('Archive contains files outside the declared project')
        if read_json(extracted / 'project/project.json')['core'] != lock['core']:
            raise ValueError('Core version differs from the pinned lock')
        if lock.get('assetManifest', {}).get('path') != 'asset-manifest.json':
            raise ValueError('Pinned lock must include the game asset manifest')
        verify_record(extracted / 'project', lock['assetManifest'])
        extracted.rename(destination)
    print(f'Verified private runtime: {len(records)} files')


class PrivateRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != 'https' or parsed.username or parsed.password:
            raise ValueError('Private runtime redirects must use HTTPS')
        result = super().redirect_request(req, fp, code, msg, headers, newurl)
        if parsed.netloc != urllib.parse.urlparse(req.full_url).netloc:
            result.remove_header('Authorization')
        return result


def fetch(destination, lock_path):
    url, token = os.environ.get('ISAAC_RUNTIME_URL', ''), os.environ.get('ISAAC_RUNTIME_TOKEN', '')
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Set ISAAC_RUNTIME_URL to the private HTTPS download or GitHub release-asset API URL')
    headers = {'User-Agent': 'Isaac-Repentance-build', 'Accept': 'application/octet-stream'}
    if token:
        if parsed.hostname != 'api.github.com':
            raise ValueError('ISAAC_RUNTIME_TOKEN is only sent to api.github.com; use a signed HTTPS URL for other hosts')
        headers['Authorization'] = 'Bearer ' + token
        headers['X-GitHub-Api-Version'] = '2022-11-28'
    lock = read_json(lock_path)
    if not isinstance(lock.get('bytes'), int) or not 0 < lock['bytes'] <= MAX_BYTES:
        raise ValueError('Invalid pinned archive size')
    with tempfile.TemporaryDirectory(prefix='isaac-download-') as temp:
        archive = Path(temp) / 'runtime.tar.gz'
        opener = urllib.request.build_opener(PrivateRedirect())
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=60) as response, archive.open('xb') as target:
                count = 0
                while chunk := response.read(1024**2):
                    count += len(chunk)
                    if count > lock['bytes']:
                        raise ValueError('Private runtime download exceeds the pinned size')
                    target.write(chunk)
        except urllib.error.HTTPError as error:
            raise ValueError(f'Private runtime download returned HTTP {error.code}; check resource access') from None
        except urllib.error.URLError:
            raise ValueError('Private runtime download failed; check resource access and network') from None
        unpack(archive, destination, lock_path)


def stage(project, output, target, replace=False):
    project, output = Path(project).absolute(), Path(output).absolute()
    if target not in ('mobile', 'desktop'):
        raise ValueError('Unsupported application target')
    if output.is_symlink():
        raise ValueError('Stage output cannot be a symlink')
    names = project_files(project)
    if output.exists() and (not replace or not (output / '.isaac-stage.json').is_file()):
        raise ValueError('Refusing to overwrite an unmarked directory; pass --replace for a previous stage')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.isaac-stage-', dir=output.parent) as temp:
        staged = Path(temp) / 'stage'
        staged.mkdir()
        for name in names:
            if target == 'mobile':
                if name == 'project.json':
                    continue
                destination = staged / name.removeprefix('core/')
            else:
                destination = staged / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(project / name, destination)
        web = ROOT / 'Isaac-Repentance/project/web'
        for name in WEB_FILES:
            destination = (staged if target == 'mobile' else staged / 'web') / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(regular(web, name), destination)
        write_json(staged / '.isaac-stage.json', {'format': FORMAT, 'target': target, 'game': TARGET, 'preinstalledMods': 0})
        old = None
        if output.exists():
            # Keep the backup outside the staging directory: a failed rollback
            # must not let TemporaryDirectory cleanup delete the previous build.
            old = Path(tempfile.mkdtemp(prefix='.isaac-previous-', dir=output.parent))
            old.rmdir()
            output.rename(old)
        try:
            staged.rename(output)
        except BaseException:
            if old is not None:
                old.rename(output)
            raise
        if old is not None:
            shutil.rmtree(old)
    print(f'Staged complete {target} runtime; no player data included')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, default=ROOT / 'packaging/runtime.lock.json')
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('pack')
    p.add_argument('--project', type=Path, default=ROOT / 'Isaac-Repentance/project')
    p.add_argument('--output', type=Path, required=True)
    p = commands.add_parser('unpack')
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p = commands.add_parser('fetch')
    p.add_argument('--output', type=Path, required=True)
    p = commands.add_parser('stage')
    p.add_argument('--project', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--target', choices=['desktop', 'mobile'], required=True)
    p.add_argument('--replace', action='store_true')
    args = parser.parse_args()
    if args.command == 'pack':
        pack(args.project, args.output, args.lock)
    elif args.command == 'unpack':
        unpack(args.archive, args.output, args.lock)
    elif args.command == 'fetch':
        fetch(args.output, args.lock)
    else:
        stage(args.project, args.output, args.target, args.replace)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        # Do not print request URLs or credentials in CI error output.
        print(f'Runtime preparation failed: {error}', file=sys.stderr)
        sys.exit(1)
