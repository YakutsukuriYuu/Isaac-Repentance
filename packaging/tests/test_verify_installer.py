"""Verify final installer completeness using tiny synthetic native applications."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
import warnings
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/verify_installer.py'
SPEC = importlib.util.spec_from_file_location('verify_installer', SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='isaac-installer-tests-')
        self.root = Path(self.temp.name)
        self.assets = {'isaac-ng.exe.unpacked.exe': b'MZ tiny fixture',
                       'resources/packed/repentance.a': b'fixture game archive'}
        self.core = {'j835_game.mjs': b'export default()=>{}',
                     'j835_game.wasm': b'\x00asm\x01\x00\x00\x00'}
        manifest = {'target': 'Repentance 1.7.9b.J835', 'mods': [],
                    'files': [{**self.record(name, data), 'url': '/assets/' + name}
                              for name, data in self.assets.items()]}
        self.manifest = json.dumps(manifest).encode()
        self.lock = {'format': 'isaac-private-runtime-v1', 'target': manifest['target'],
                     'core': [self.record('core/' + name, data) for name, data in self.core.items()],
                     'assetManifest': self.record('asset-manifest.json', self.manifest)}
        self.quiet = contextlib.redirect_stdout(io.StringIO())
        self.quiet.__enter__()

    def tearDown(self):
        self.quiet.__exit__(None, None, None)
        self.temp.cleanup()

    @staticmethod
    def record(path, data):
        return {'path': path, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def contents(self, kind):
        if kind == 'apk':
            prefix = 'assets/public/'
            contents = {'AndroidManifest.xml': b'fixture android manifest', 'classes.dex': b'dex\nfixture'}
        else:
            prefix = 'Payload/Fixture.app/public/'
            contents = {
                'Payload/Fixture.app/Info.plist': plistlib.dumps({'CFBundleExecutable': 'Fixture', 'CFBundleSupportedPlatforms': ['iPhoneOS']}),
                'Payload/Fixture.app/Fixture': b'\xcf\xfa\xed\xfe synthetic device executable',
            }
        contents.update({prefix + name: data for name, data in self.core.items()})
        contents.update({prefix + 'assets/' + name: data for name, data in self.assets.items()})
        contents.update({prefix + name: b'fixture frontend' for name in ('index.html', 'app.mjs', 'native-bootstrap.mjs')})
        contents[prefix + 'asset-manifest.json'] = self.manifest
        return prefix, contents

    def archive(self, kind, contents):
        filename = self.root / ('fixture.' + kind)
        with zipfile.ZipFile(filename, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in contents.items():
                archive.writestr(name, data)
        return filename

    def test_complete_apk_and_device_ipa_pass(self):
        for kind in ['apk', 'ipa']:
            with self.subTest(kind=kind):
                _, contents = self.contents(kind)
                installer.verify(self.archive(kind, contents), kind, self.lock)

    def test_missing_or_corrupt_runtime_file_fails(self):
        for kind in ['apk', 'ipa']:
            for item in ['j835_game.wasm', 'assets/resources/packed/repentance.a', 'native-bootstrap.mjs']:
                for change in ['missing', 'corrupt']:
                    if item == 'native-bootstrap.mjs' and change == 'corrupt':
                        continue  # App source varies by commit; only its presence is pinned here.
                    with self.subTest(kind=kind, item=item, change=change):
                        prefix, contents = self.contents(kind)
                        if change == 'missing':
                            contents.pop(prefix + item)
                        else:
                            contents[prefix + item] = b'x' * len(contents[prefix + item])
                        with self.assertRaisesRegex(ValueError, 'missing|mismatch'):
                            installer.verify(self.archive(kind, contents), kind, self.lock)

    def test_shortened_manifest_cannot_hide_a_missing_game_resource(self):
        for kind in ['apk', 'ipa']:
            with self.subTest(kind=kind):
                prefix, contents = self.contents(kind)
                manifest = json.loads(self.manifest)
                manifest['files'].pop()
                contents[prefix + 'asset-manifest.json'] = json.dumps(manifest).encode()
                contents.pop(prefix + 'assets/resources/packed/repentance.a')
                with self.assertRaisesRegex(ValueError, 'manifest.json'):
                    installer.verify(self.archive(kind, contents), kind, self.lock)

    def test_lock_without_external_manifest_pin_is_rejected(self):
        lock = copy.deepcopy(self.lock)
        lock.pop('assetManifest')
        _, contents = self.contents('apk')
        with self.assertRaisesRegex(ValueError, 'Pinned lock'):
            installer.verify(self.archive('apk', contents), 'apk', lock)

    def test_ipa_must_have_native_executable_and_target_physical_device(self):
        for change in ['missing-executable', 'empty-executable', 'invalid-executable-name', 'simulator']:
            with self.subTest(change=change):
                _, contents = self.contents('ipa')
                if change == 'missing-executable':
                    contents.pop('Payload/Fixture.app/Fixture')
                elif change == 'empty-executable':
                    contents['Payload/Fixture.app/Fixture'] = b''
                else:
                    metadata = plistlib.loads(contents['Payload/Fixture.app/Info.plist'])
                    if change == 'invalid-executable-name':
                        metadata['CFBundleExecutable'] = '../outside'
                    else:
                        metadata['CFBundleSupportedPlatforms'] = ['iPhoneSimulator']
                    contents['Payload/Fixture.app/Info.plist'] = plistlib.dumps(metadata)
                with self.assertRaisesRegex(ValueError, 'executable|physical iOS device'):
                    installer.verify(self.archive('ipa', contents), 'ipa', self.lock)

    def test_player_data_is_rejected_even_outside_the_web_directory(self):
        for kind in ['apk', 'ipa']:
            for location in ['userdata/saves/progress.dat', 'assets/public/userdata/saves/progress.dat',
                             'Payload/Fixture.app/userdata/saves/progress.dat', 'internal/.storage/commit.json']:
                with self.subTest(kind=kind, location=location):
                    _, contents = self.contents(kind)
                    contents[location] = b'private player data'
                    with self.assertRaisesRegex(ValueError, 'player data'):
                        installer.verify(self.archive(kind, contents), kind, self.lock)

    def test_duplicate_and_unsafe_zip_members_are_rejected(self):
        prefix, contents = self.contents('apk')
        filename = self.archive('apk', contents)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(filename, 'a') as archive:
                archive.writestr(prefix + 'app.mjs', b'duplicate')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            installer.verify(filename, 'apk', self.lock)
        for unsafe in ['../outside', '/absolute', 'assets\\escape']:
            with self.subTest(name=unsafe):
                _, contents = self.contents('apk')
                contents[unsafe] = b'unsafe'
                with self.assertRaisesRegex(ValueError, 'unsafe ZIP paths'):
                    installer.verify(self.archive('apk', contents), 'apk', self.lock)


if __name__ == '__main__':
    unittest.main()
