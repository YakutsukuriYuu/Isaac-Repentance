"""Keep the public upload tree independent of build output and private inputs."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/export_source.py'
SPEC = importlib.util.spec_from_file_location('export_source', SCRIPT)
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class SourceExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='isaac-source-tests-')
        self.root = Path(self.temp.name).resolve()
        self.write('.gitignore', 'ignored outputs')
        for name in exporter.PACKAGING_FILES:
            self.write('packaging/' + name, 'fixture public config')
        for name in (*exporter.WEB_FILES, 'test_save_helpers.mjs', 'test_mod_helpers.mjs',
                     'test_disk_storage.mjs', 'test_fps_metrics.mjs', 'test_gamepad_input.mjs',
                     'test_session_controls.mjs'):
            self.write('Isaac-Repentance/project/web/' + name, 'fixture web source')
        self.write('portable/launcher/main.go', 'package main')
        self.write('portable/launcher/go.mod', 'module fixture')
        self.write('packaging/scripts/build.py', '# fixture source')
        self.write('packaging/mobile/src/bridge.mjs', 'export const fixture=true;')
        self.write('packaging/mobile/tests/bridge.test.mjs', '// fixture test')
        self.write('packaging/desktop/test/shell.test.mjs', '// fixture test')
        self.write('.github/workflows/build.yml', 'name: Fixture')
        self.write('Isaac-Repentance/project/licenses/fixture/LICENSE', 'fixture license')

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data)
        return path

    def test_export_contains_required_tooling_source_locks_and_notices(self):
        names = set(exporter.source_files(self.root))
        for name in ['packaging/mobile/package-lock.json', 'packaging/desktop/package-lock.json',
                     'packaging/runtime.lock.json', 'packaging/scripts/build.py',
                     'packaging/mobile/src/bridge.mjs', '.github/workflows/build.yml',
                     'portable/launcher/main.go', 'portable/launcher/go.mod',
                     'Isaac-Repentance/project/licenses/fixture/LICENSE']:
            self.assertIn(name, names)
        self.assertEqual(list(exporter.source_files(self.root)), sorted(names))

    def test_build_outputs_player_data_assets_and_private_directories_are_excluded(self):
        original = set(exporter.source_files(self.root))
        for directory in ['output', '.test-results', '.build', 'node_modules', 'www', 'android', 'ios',
                          'runtime', 'assets', 'userdata', 'private', 'secrets', 'credentials', 'keys',
                          'PRIVATE', 'UserData']:
            # Even an otherwise allowlisted source extension must not bypass a
            # forbidden directory nested under an allowed source subtree.
            self.write(f'packaging/mobile/src/{directory}/secret.mjs', 'private fixture')
            self.write(f'packaging/{directory}/secret.json', 'private fixture')
        for filename in ['Isaac-Repentance/project/assets/game.json',
                         'Isaac-Repentance/project/core/j835_game.wasm',
                         'Isaac-Repentance/userdata/settings/settings.json',
                         '.release-inputs/runtime.tar.gz', '.release-build/player.dat',
                         'packaging/unlisted.json', 'packaging/desktop/credentials.json']:
            self.write(filename, 'private fixture')
        self.assertEqual(set(exporter.source_files(self.root)), original)

    def test_key_files_and_environment_files_never_enter_allowed_source_subtrees(self):
        original = set(exporter.source_files(self.root))
        for filename in ['release.p12', 'android.jks', 'notary.p8', 'private.key', 'certificate.pem',
                         '.env', '.env.local', '.env.mjs', 'credentials.json', '.npmrc']:
            self.write('packaging/mobile/src/' + filename, 'private key fixture')
            self.write('packaging/scripts/' + filename, 'private key fixture')
        self.assertEqual(set(exporter.source_files(self.root)), original)

    def test_missing_required_configuration_fails_instead_of_silent_partial_export(self):
        (self.root / 'packaging/mobile/package-lock.json').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing or linked source file'):
            list(exporter.source_files(self.root))

    def test_file_and_parent_directory_symlinks_cannot_escape_the_source_tree(self):
        source = self.root / 'packaging/mobile/package.json'
        outside = self.root / 'outside.json'
        source.rename(outside)
        source.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'Missing or linked source file'):
            list(exporter.source_files(self.root))
        source.unlink()
        outside.rename(source)
        directory = self.root / 'packaging/mobile'
        moved = self.root / 'outside-mobile'
        directory.rename(moved)
        directory.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Missing or linked source file'):
            list(exporter.source_files(self.root))


if __name__ == '__main__':
    unittest.main()
