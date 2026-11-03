"""Final DMG verification rejects incomplete data and always releases its mount."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/verify_dmg.py'
SPEC = importlib.util.spec_from_file_location('verify_dmg', SCRIPT)
dmg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dmg)


class DMGVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='isaac-dmg-tests-')
        self.root = Path(self.temp.name)
        self.app = self.root / 'Fixture.app'
        self.project = self.app / 'Contents/Resources/runtime/project'
        self.project.mkdir(parents=True)
        self.calls = []
        self.cpu = b'\xcf\xfa\xed\xfe\x0c\x00\x00\x01'
        self.put(self.app / 'Contents/MacOS/Fixture', self.cpu + b'app', executable=True)
        self.put(self.app / 'Contents/Info.plist', plistlib.dumps({'CFBundlePackageType': 'APPL', 'CFBundleExecutable': 'Fixture'}))
        self.put(self.project.parent / 'isaac-launcher', self.cpu + b'launcher', executable=True)
        assets = {'isaac-ng.exe.unpacked.exe': b'MZ fixture', 'resources/packed/repentance.a': b'game archive fixture'}
        core = {'core/j835_game.mjs': b'export default()=>{}', 'core/j835_game.wasm': b'\x00asm\x01\x00\x00\x00'}
        for name, data in core.items():
            self.put(self.project / name, data)
        for name, data in assets.items():
            self.put(self.project / 'assets' / name, data)
        manifest = {'target': dmg.TARGET, 'files': [{**self.record(name, data), 'url': '/assets/' + name} for name, data in assets.items()]}
        manifest_bytes = json.dumps(manifest).encode()
        self.put(self.project / 'asset-manifest.json', manifest_bytes)
        records = [self.record(name, data) for name, data in core.items()]
        config = {'format': 'isaac-j835-development-v2', 'appId': 'isaac-j835-portable',
                  'target': dmg.TARGET, 'preinstalledMods': 0, 'core': records}
        self.put(self.project / 'project.json', json.dumps(config).encode())
        for name in dmg.WEB_FILES:
            self.put(self.project / 'web' / name, b'frontend fixture')
        self.lock = {'format': dmg.FORMAT, 'target': dmg.TARGET, 'core': records, 'fileCount': 6,
                     'assetManifest': self.record('asset-manifest.json', manifest_bytes)}
        self.quiet = contextlib.redirect_stdout(io.StringIO())
        self.quiet.__enter__()

    def tearDown(self):
        self.quiet.__exit__(None, None, None)
        self.temp.cleanup()

    @staticmethod
    def record(name, data):
        return {'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    @staticmethod
    def put(filename, data, executable=False):
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_bytes(data)
        filename.chmod(0o755 if executable else 0o644)

    def runner(self, command, timeout=120):
        self.calls.append(command)
        if '--check' in command:
            return b'Verification passed: fixture\n'
        return b''

    def test_complete_runtime_checks_signature_and_bundled_launcher(self):
        result = dmg.verify_application(self.app, self.lock, 'arm64', self.runner)
        self.assertEqual(result['gameFiles'], 2)
        self.assertEqual(result['architecture'], 'arm64')
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][1:4], ['--verify', '--deep', '--strict'])
        self.assertEqual(self.calls[1][-1], '--check')
        self.assertFalse((self.project.parent / 'userdata').exists())

    def test_corrupted_asset_is_rejected_before_execution(self):
        asset = self.project / 'assets/resources/packed/repentance.a'
        asset.write_bytes(b'x' * asset.stat().st_size)
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            dmg.verify_application(self.app, self.lock, runner=self.runner)
        self.assertEqual(self.calls, [])

    def test_shortened_self_consistent_manifest_cannot_hide_missing_resources(self):
        path = self.project / 'asset-manifest.json'
        manifest = json.loads(path.read_text())
        manifest['files'].pop()
        path.write_text(json.dumps(manifest))
        (self.project / 'assets/resources/packed/repentance.a').unlink()
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            dmg.verify_application(self.app, self.lock, runner=self.runner)

    def test_userdata_empty_directories_and_unlisted_files_are_rejected(self):
        for name in ('userdata', 'project/assets/MODS', 'project/.storage'):
            with self.subTest(name=name):
                entry = self.project.parent / name
                entry.mkdir()
                with self.assertRaisesRegex(ValueError, 'player data|preinstalled Mods'):
                    dmg.verify_application(self.app, self.lock, runner=self.runner)
                entry.rmdir()
        extra = self.project / 'extra.dat'
        extra.write_bytes(b'personal')
        with self.assertRaisesRegex(ValueError, 'Unexpected runtime inventory'):
            dmg.verify_application(self.app, self.lock, runner=self.runner)

    def test_symlinks_and_missing_execute_bits_are_rejected(self):
        launcher = self.project.parent / 'isaac-launcher'
        original = launcher.read_bytes()
        launcher.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'not executable'):
            dmg.verify_application(self.app, self.lock, runner=self.runner)
        launcher.unlink()
        outside = self.root / 'outside-launcher'
        self.put(outside, original, executable=True)
        launcher.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            dmg.verify_application(self.app, self.lock, runner=self.runner)

    def test_architecture_and_core_pin_mismatch_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'expected x64'):
            dmg.verify_application(self.app, self.lock, 'x64', self.runner)
        changed = copy.deepcopy(self.lock)
        changed['core'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'core version'):
            dmg.verify_application(self.app, changed, runner=self.runner)

    def test_mount_is_readonly_and_detached_after_verification_failure(self):
        image = self.root / 'fixture.dmg'
        image.write_bytes(b'fixture DMG')
        commands = []
        def mounted_runner(command, timeout=120):
            commands.append(command)
            if command[1] == 'attach':
                mount = Path(command[command.index('-mountpoint') + 1])
                self.assertIn('-readonly', command)
                self.assertIn('-nobrowse', command)
                self.assertIn('-plist', command)
                shutil.copytree(self.app, mount / self.app.name)
                (mount / self.app.name / 'Contents/Resources/runtime/project/core/j835_game.wasm').unlink()
                return plistlib.dumps({'system-entities': [{'mount-point': str(mount)}]})
            return b''
        with patch.object(dmg.os.path, 'ismount', return_value=True):
            with self.assertRaisesRegex(ValueError, 'Missing runtime file'):
                dmg.verify(image, self.lock, runner=mounted_runner)
        self.assertEqual(commands[-1][1], 'detach')

    def test_invalid_attach_output_still_detaches(self):
        image = self.root / 'fixture.dmg'
        image.write_bytes(b'fixture DMG')
        commands = []
        def invalid_runner(command, timeout=120):
            commands.append(command)
            return b'not a plist' if command[1] == 'attach' else b''
        with self.assertRaises(plistlib.InvalidFileException):
            dmg.verify(image, self.lock, runner=invalid_runner)
        self.assertEqual(commands[-1][1], 'detach')


if __name__ == '__main__':
    unittest.main()
