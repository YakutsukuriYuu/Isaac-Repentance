"""Exercise private input boundaries without reading a player's game or saves."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock
import urllib.request

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/runtime_inputs.py'
SPEC = importlib.util.spec_from_file_location('runtime_inputs', SCRIPT)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class RuntimeInputsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='isaac-input-tests-')
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / 'source/project'
        self.project.mkdir(parents=True)
        self.archive = self.root / 'private-runtime.tar.gz'
        self.lock = self.root / 'runtime.lock.json'
        self.original = {
            'core/j835_game.mjs': b'export default function fixture() {}',
            'core/j835_game.wasm': b'\x00asm\x01\x00\x00\x00',
            'assets/isaac-ng.exe.unpacked.exe': b'MZ fixture only',
            'assets/resources/packed/repentance.a': b'fixture resources\x00\xff',
            'THIRD_PARTY_NOTICES.md': b'Fixture notices\n',
            'licenses/fixture/LICENSE': b'Fixture license\n',
        }
        for name, data in self.original.items():
            destination = self.project / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        core = [self.record(name, data) for name, data in self.original.items() if name.startswith('core/')]
        files = [{**self.record(name.removeprefix('assets/'), data), 'url': '/' + name}
                 for name, data in self.original.items() if name.startswith('assets/')]
        runtime.write_json(self.project / 'project.json', {
            'format': 'isaac-j835-development-v2', 'appId': 'isaac-j835-portable',
            'target': runtime.TARGET, 'core': core, 'preinstalledMods': 0,
        })
        runtime.write_json(self.project / 'asset-manifest.json', {'target': runtime.TARGET, 'files': files, 'mods': []})
        # Neither unexpected project files nor adjacent player data may enter.
        (self.project / 'private.txt').write_text('private project note')
        (self.project / 'userdata').mkdir()
        (self.project / 'userdata/player.dat').write_bytes(b'private player save')
        (self.project.parent / 'userdata').mkdir()
        (self.project.parent / 'userdata/player.dat').write_bytes(b'adjacent private save')
        web = self.root / 'repository/Isaac-Repentance/project/web'
        web.mkdir(parents=True)
        for name in runtime.WEB_FILES:
            (web / name).write_text('production fixture: ' + name)
        (web / 'test_private.mjs').write_text('test must not be packaged')
        self.repository = web.parents[2]
        self.output = io.StringIO()
        self.quiet = contextlib.redirect_stdout(self.output)
        self.quiet.__enter__()

    def tearDown(self):
        self.quiet.__exit__(None, None, None)
        self.temp.cleanup()

    @staticmethod
    def record(path, data):
        return {'path': path, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def pack(self):
        runtime.pack(self.project, self.archive, self.lock)

    def rewrite_archive(self, transform):
        entries = []
        with tarfile.open(self.archive, 'r:gz') as source:
            for member in source:
                entries.append((member, source.extractfile(member).read()))
        entries = transform(entries)
        with tarfile.open(self.archive, 'w:gz') as destination:
            for member, data in entries:
                if member.isfile():
                    member.size = len(data)
                    destination.addfile(member, io.BytesIO(data))
                else:
                    destination.addfile(member)
        lock = runtime.read_json(self.lock)
        lock.update(bytes=self.archive.stat().st_size, sha256=runtime.digest(self.archive))
        runtime.write_json(self.lock, lock)

    def assert_rejected_archive(self):
        destination = self.root / 'extracted'
        with self.assertRaises((ValueError, OSError, tarfile.TarError)):
            runtime.unpack(self.archive, destination, self.lock)
        self.assertFalse(destination.exists(), 'failed extraction must not become a usable runtime')
        self.assertFalse(list(self.root.glob('.runtime-input-*')), 'partial extraction was not cleaned')

    def test_round_trip_deterministic_archive_excludes_player_data_and_frontend(self):
        self.pack()
        other = self.root / 'second-runtime.tar.gz'
        runtime.pack(self.project, other, self.root / 'second.lock.json')
        self.assertEqual(self.archive.read_bytes(), other.read_bytes())
        with tarfile.open(self.archive, 'r:gz') as archive:
            names = archive.getnames()
        self.assertEqual(set(names), {'runtime-input.json', *('project/' + name for name in runtime.project_files(self.project))})
        self.assertFalse(any('userdata' in name or '/web/' in name or 'private.txt' in name for name in names))
        destination = self.root / 'verified'
        runtime.unpack(self.archive, destination, self.lock)
        for name, data in self.original.items():
            self.assertEqual((destination / 'project' / name).read_bytes(), data)
        with self.assertRaisesRegex(ValueError, 'already exist'):
            runtime.unpack(self.archive, destination, self.lock)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            runtime.pack(self.project, self.archive, self.lock)

    def test_archive_hash_and_file_hash_are_both_verified(self):
        self.pack()
        original = self.archive.read_bytes()
        self.archive.write_bytes(original + b'tampered')
        self.assert_rejected_archive()
        self.archive.write_bytes(original)
        self.rewrite_archive(lambda entries: [
            (member, b'wrong bytes' if member.name.endswith('repentance.a') else data)
            for member, data in entries
        ])
        self.assert_rejected_archive()

    def test_archive_rejects_traversal_absolute_paths_links_and_player_data(self):
        self.pack()
        archive_bytes, lock_bytes = self.archive.read_bytes(), self.lock.read_bytes()
        for name, kind in [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('project/assets/../escape', tarfile.REGTYPE),
                           ('project/assets/symlink', tarfile.SYMTYPE),
                           ('project/assets/hardlink', tarfile.LNKTYPE),
                           ('project/assets/directory', tarfile.DIRTYPE),
                           ('project/userdata/player.dat', tarfile.REGTYPE),
                           ('project/web/app.mjs', tarfile.REGTYPE)]:
            with self.subTest(name=name):
                self.archive.write_bytes(archive_bytes)
                self.lock.write_bytes(lock_bytes)
                member = tarfile.TarInfo(name)
                member.type, member.linkname = kind, '../../outside'
                self.rewrite_archive(lambda entries: entries + [(member, b'bad')])
                self.assert_rejected_archive()
        self.assertFalse((self.root / 'escape').exists())

    def test_archive_rejects_duplicate_case_collision_and_missing_resource(self):
        self.pack()
        original, lock = self.archive.read_bytes(), self.lock.read_bytes()
        for transform in [
            lambda entries: entries + [(tarfile.TarInfo('project/CORE/j835_game.wasm'), b'duplicate')],
            lambda entries: [(member, data) for member, data in entries if not member.name.endswith('repentance.a')],
            lambda entries: entries + [(tarfile.TarInfo('project/assets/undeclared.a'), b'undeclared')],
        ]:
            self.archive.write_bytes(original)
            self.lock.write_bytes(lock)
            self.rewrite_archive(transform)
            self.assert_rejected_archive()

    def test_project_missing_and_corrupt_resources_fail_before_archiving(self):
        asset = self.project / 'assets/resources/packed/repentance.a'
        asset.unlink()
        with self.assertRaisesRegex(ValueError, 'Missing runtime file'):
            self.pack()
        asset.write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.pack()
        self.assertFalse(self.archive.exists())

    def test_required_executable_name_is_case_sensitive(self):
        manifest = runtime.read_json(self.project / 'asset-manifest.json')
        record = manifest['files'][0]
        source = self.project / 'assets' / record['path']
        record['path'] = 'ISAAC-NG.EXE.UNPACKED.EXE'
        record['url'] = '/assets/' + record['path']
        source.rename(self.project / 'assets' / record['path'])
        runtime.write_json(self.project / 'asset-manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'game executable is missing'):
            self.pack()

    def test_symlink_assets_notices_and_license_directory_are_rejected(self):
        for name in ['assets/resources/packed/repentance.a', 'THIRD_PARTY_NOTICES.md', 'licenses']:
            with self.subTest(name=name):
                source = self.project / name
                moved = self.root / ('external-' + source.name)
                source.rename(moved)
                source.symlink_to(moved, target_is_directory=moved.is_dir())
                with self.assertRaisesRegex(ValueError, 'Symlinks'):
                    self.pack()
                source.unlink()
                moved.rename(source)

    def test_stage_contains_full_runtime_and_only_production_web_files(self):
        with mock.patch.object(runtime, 'ROOT', self.repository):
            for target in ['mobile', 'desktop']:
                with self.subTest(target=target):
                    output = self.root / target
                    runtime.stage(self.project, output, target)
                    web = output if target == 'mobile' else output / 'web'
                    for name in runtime.WEB_FILES:
                        self.assertEqual((web / name).read_text(), 'production fixture: ' + name)
                    self.assertFalse((web / 'test_private.mjs').exists())
                    self.assertFalse((output / 'userdata').exists())
                    core = output if target == 'mobile' else output / 'core'
                    self.assertEqual((core / 'j835_game.wasm').read_bytes(), self.original['core/j835_game.wasm'])
                    self.assertEqual((output / 'assets/resources/packed/repentance.a').read_bytes(), self.original['assets/resources/packed/repentance.a'])
                    self.assertEqual((output / 'project.json').exists(), target == 'desktop')
                    with self.assertRaisesRegex(ValueError, 'Refusing to overwrite'):
                        runtime.stage(self.project, output, target)
                    runtime.stage(self.project, output, target, replace=True)

    def test_stage_rejects_unmarked_or_symlink_destination(self):
        with mock.patch.object(runtime, 'ROOT', self.repository):
            output = self.root / 'unmarked'
            output.mkdir()
            (output / 'keep.txt').write_text('preserve')
            with self.assertRaisesRegex(ValueError, 'unmarked directory'):
                runtime.stage(self.project, output, 'desktop', replace=True)
            self.assertEqual((output / 'keep.txt').read_text(), 'preserve')
            linked = self.root / 'linked'
            linked.symlink_to(output, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                runtime.stage(self.project, linked, 'desktop', replace=True)

    def test_stage_publication_failure_restores_previous_build(self):
        output = self.root / 'desktop'
        with mock.patch.object(runtime, 'ROOT', self.repository):
            runtime.stage(self.project, output, 'desktop')
            (output / 'previous-marker').write_text('preserve previous build')
            original_rename = Path.rename

            def fail_new_stage(source, destination):
                if source.name == 'stage':
                    raise OSError('injected publication failure')
                return original_rename(source, destination)

            with mock.patch.object(Path, 'rename', fail_new_stage):
                with self.assertRaisesRegex(OSError, 'injected publication failure'):
                    runtime.stage(self.project, output, 'desktop', replace=True)
            self.assertEqual((output / 'previous-marker').read_text(), 'preserve previous build')
            self.assertFalse(list(self.root.glob('.isaac-previous-*')))

    def test_private_download_redirect_never_forwards_token_to_another_host(self):
        request = urllib.request.Request('https://api.github.com/repos/example/game/releases/assets/1',
                                         headers={'Authorization': 'Bearer secret-token'})
        handler = runtime.PrivateRedirect()
        same_host = handler.redirect_request(request, None, 302, 'Found', {}, 'https://api.github.com/other')
        self.assertEqual(same_host.get_header('Authorization'), 'Bearer secret-token')
        outside = handler.redirect_request(request, None, 302, 'Found', {}, 'https://release-assets.githubusercontent.com/blob')
        self.assertIsNone(outside.get_header('Authorization'))
        for bad in ['http://api.github.com/asset', 'https://name:password@example.com/asset']:
            with self.assertRaises(ValueError):
                handler.redirect_request(request, None, 302, 'Found', {}, bad)


if __name__ == '__main__':
    unittest.main()
