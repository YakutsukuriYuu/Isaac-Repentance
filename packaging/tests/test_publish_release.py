"""Exercise publication failure recovery with tiny fixture installers and a fake API."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/publish_release.py'
SPEC = importlib.util.spec_from_file_location('publish_release', SCRIPT)
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class FakeGitHub:
    def __init__(self, details):
        self.details = details
        self.release = None
        self.tag_sha = None
        self.calls = []
        self.uploaded = []
        self.fail_upload = None
        self.corrupt_upload = None

    def api(self, endpoint, method='GET', data=None, allow_missing=False):
        self.calls.append((method, endpoint, copy.deepcopy(data)))
        if '/git/ref/tags/' in endpoint:
            return None if self.tag_sha is None else {'object': {'type': 'commit', 'sha': self.tag_sha}}
        if '/releases/tags/' in endpoint:
            # Match GitHub's published-only behavior on the tag lookup endpoint.
            return copy.deepcopy(self.release) if self.release and not self.release['draft'] else None
        if '/releases?per_page=' in endpoint:
            return [copy.deepcopy(self.release)] if self.release else []
        if method == 'POST' and endpoint.endswith('/releases'):
            self.release = {**data, 'id': 123, 'assets': [],
                            'html_url': 'https://github.com/example/project/releases/tag/' + data['tag_name']}
            return copy.deepcopy(self.release)
        if method == 'DELETE' and '/releases/assets/' in endpoint:
            asset_id = int(endpoint.rsplit('/', 1)[1])
            self.release['assets'] = [a for a in self.release['assets'] if a['id'] != asset_id]
            return None
        if method == 'PATCH':
            self.release.update(data)
            self.tag_sha = self.details['sha']
        return copy.deepcopy(self.release)

    def upload(self, repository, tag, path):
        self.uploaded.append(path.name)
        record = publisher.file_record(path)
        asset = {k: record[k] for k in ('name', 'size', 'digest')}
        asset.update(id=len(self.uploaded), state='uploaded')
        if path.name == self.fail_upload:
            asset.update(state='starter', size=0, digest=None)
            self.release['assets'].append(asset)
            raise ValueError('Simulated interrupted upload')
        if path.name == self.corrupt_upload:
            asset['digest'] = 'sha256:' + '0' * 64
        self.release['assets'].append(asset)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='isaac-release-tests-')
        self.root = Path(self.temp.name)
        self.artifacts = self.root / 'artifacts'
        paths = [
            'Isaac-Repentance-Android/Isaac-Repentance-0.1.0-android.apk',
            'Isaac-Repentance-iOS/Isaac-Repentance-0.1.0-ios-unsigned.ipa',
            'Isaac-Repentance-macOS-arm64/Isaac-Repentance-0.1.0-arm64.dmg',
            'Isaac-Repentance-macOS-x64/Isaac-Repentance-0.1.0-x64.dmg',
        ]
        for name in paths:
            path = self.artifacts / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('synthetic installer ' + name).encode())
        self.env = dict(GITHUB_REPOSITORY='example/project', GITHUB_SHA='a' * 40,
                        GITHUB_RUN_ID='1234', GITHUB_RUN_NUMBER='42', GITHUB_REF='refs/heads/main')
        self.details = publisher.context(self.env)
        self.selected = publisher.inventory(self.artifacts)
        self.records, self.notes = publisher.prepare_metadata(self.selected, self.details, self.root / 'metadata')
        self.api = FakeGitHub(self.details)

    def tearDown(self):
        self.temp.cleanup()

    def publish(self):
        return publisher.publish(self.api, self.records, self.notes, self.details)

    def test_tag_is_stable_on_rerun_and_preserves_version_refs(self):
        self.assertEqual(self.details['tag'], 'build-42')
        self.env['GITHUB_RUN_ATTEMPT'] = '2'
        self.assertEqual(publisher.context(self.env)['tag'], 'build-42')
        self.env['GITHUB_REF'] = 'refs/tags/v0.2.0'
        self.assertEqual(publisher.context(self.env)['tag'], 'v0.2.0')
        for ref in ['refs/heads/feature', 'refs/pull/5/merge']:
            self.env['GITHUB_REF'] = ref
            with self.assertRaisesRegex(ValueError, 'only from main'):
                publisher.context(self.env)

    def test_unsafe_context_cannot_reach_github(self):
        for field, value in [('GITHUB_REPOSITORY', 'example/project/other'),
                             ('GITHUB_SHA', 'main'), ('GITHUB_RUN_ID', 'x')]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    publisher.context({**self.env, field: value})
        for tag in ['--draft', 'v1/unsafe', 'v1..2', 'v1.']:
            with self.assertRaises(ValueError):
                publisher.context(self.env, tag=tag)

    def test_inventory_requires_one_of_each_platform_and_no_debug_or_unrelated_files(self):
        android = self.selected['android']['path']
        for extra in ['debug.apk', 'Isaac-Repentance-android-debug.apk', 'secret.txt', 'input.tar.gz']:
            path = self.artifacts / extra
            path.write_bytes(b'not a release input')
            with self.assertRaisesRegex(ValueError, 'Unexpected'):
                publisher.inventory(self.artifacts)
            path.unlink()
        duplicate = self.artifacts / android.name
        duplicate.write_bytes(b'duplicate')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            publisher.inventory(self.artifacts)
        duplicate.unlink()
        android.unlink()
        with self.assertRaisesRegex(ValueError, 'requires'):
            publisher.inventory(self.artifacts)

    def test_empty_linked_and_inconsistent_installers_are_rejected(self):
        path = self.selected['android']['path']
        original = path.read_bytes()
        path.write_bytes(b'')
        with self.assertRaisesRegex(ValueError, 'Empty'):
            publisher.inventory(self.artifacts)
        path.write_bytes(original)
        link = self.artifacts / 'linked'
        link.symlink_to(path)
        with self.assertRaisesRegex(ValueError, 'Linked'):
            publisher.inventory(self.artifacts)
        link.unlink()
        path = self.selected['macos-x64']['path']
        path.rename(path.with_name('Isaac-Repentance-0.2.0-x64.dmg'))
        with self.assertRaisesRegex(ValueError, 'inconsistent'):
            publisher.inventory(self.artifacts)

    def test_signed_ipa_notes_are_independent_of_mac_signing_flag(self):
        unsigned = self.selected['ios']['path']
        unsigned.unlink()
        signed = unsigned.parent / 'ios-signed/Isaac-Repentance-0.1.0-ios.ipa'
        signed.parent.mkdir()
        signed.write_bytes(b'synthetic signed export')
        selected = publisher.inventory(self.artifacts)
        self.assertTrue(selected['ios']['name'].endswith('-ios.ipa'))

    def test_checksums_and_notes_describe_only_the_four_installers(self):
        sums = self.records[-1]['path'].read_text().splitlines()
        self.assertEqual(len(sums), 4)
        for record in self.records[:-1]:
            self.assertIn(record['digest'].removeprefix('sha256:') + '  ' + record['name'], sums)
        text = self.notes.read_text()
        self.assertIn(f'isaac-release-source: {self.env["GITHUB_SHA"]}', text)
        self.assertNotIn('Unsigned', text)
        self.assertNotIn('Complete offline', text)

    def test_fresh_release_publishes_only_after_all_assets_are_verified(self):
        url = self.publish()
        self.assertTrue(url.endswith('/build-42'))
        self.assertFalse(self.api.release['draft'])
        self.assertEqual(len(self.api.uploaded), 5)
        creates = [data for method, _, data in self.api.calls if method == 'POST']
        self.assertEqual(len(creates), 1)
        self.assertTrue(creates[0]['draft'])
        edits = [data for method, _, data in self.api.calls if method == 'PATCH']
        self.assertEqual(edits[0]['make_latest'], 'true')

    def test_failed_upload_stays_draft_and_rerun_resumes_without_reuploading_completed_assets(self):
        self.api.fail_upload = self.records[2]['name']
        with self.assertRaisesRegex(ValueError, 'interrupted'):
            self.publish()
        self.assertTrue(self.api.release['draft'])
        self.assertFalse(any(method == 'PATCH' for method, _, _ in self.api.calls))
        completed = self.api.uploaded[:2]
        self.api.fail_upload = None
        self.publish()
        self.assertFalse(self.api.release['draft'])
        for name in completed:
            self.assertEqual(self.api.uploaded.count(name), 1)
        self.assertEqual(sum(method == 'DELETE' for method, _, _ in self.api.calls), 1)
        self.assertEqual(sum(method == 'POST' for method, _, _ in self.api.calls), 1)

    def test_corrupt_uploaded_asset_cannot_be_published_or_overwritten_on_retry(self):
        self.api.corrupt_upload = self.records[0]['name']
        with self.assertRaisesRegex(ValueError, 'does not match'):
            self.publish()
        self.assertTrue(self.api.release['draft'])
        self.assertFalse(any(method == 'PATCH' for method, _, _ in self.api.calls))
        uploaded = list(self.api.uploaded)
        with self.assertRaisesRegex(ValueError, 'does not match'):
            self.publish()
        self.assertEqual(self.api.uploaded, uploaded)
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.api.calls))

    def test_successful_rerun_is_read_only(self):
        self.publish()
        self.api.calls.clear()
        self.api.uploaded.clear()
        self.publish()
        self.assertTrue(all(method == 'GET' for method, _, _ in self.api.calls))
        self.assertFalse(self.api.uploaded)

    def test_conflicting_commit_run_or_published_assets_are_never_mutated(self):
        self.publish()
        good = copy.deepcopy(self.api.release)
        for change in ['tag', 'commit', 'run', 'extra', 'missing', 'digest']:
            self.api.release = copy.deepcopy(good)
            self.api.tag_sha = self.details['sha']
            if change == 'tag':
                self.api.tag_sha = 'b' * 40
            elif change == 'commit':
                self.api.release['target_commitish'] = 'b' * 40
            elif change == 'run':
                self.api.release['body'] = 'another run'
            elif change == 'extra':
                self.api.release['assets'].append(dict(name='secret.txt', size=10))
            elif change == 'missing':
                self.api.release['assets'].pop()
            else:
                self.api.release['assets'][0]['digest'] = None
            self.api.calls.clear()
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    self.publish()
                self.assertTrue(all(method == 'GET' for method, _, _ in self.api.calls))

    def test_annotated_version_tag_resolves_to_source_commit(self):
        api = FakeGitHub(self.details)
        original = api.api
        def request(endpoint, **kwargs):
            if '/git/ref/tags/' in endpoint:
                return {'object': {'type': 'tag', 'sha': 'b' * 40}}
            if '/git/tags/' in endpoint:
                return {'object': {'type': 'commit', 'sha': self.details['sha']}}
            return original(endpoint, **kwargs)
        api.api = request
        publisher.check_tag(api, 'repos/example/project', 'v1.0.0', self.details['sha'], required=True)


class ApiTests(unittest.TestCase):
    def test_api_parse_success_and_404_without_leaking_error_body(self):
        api = publisher.GitHub()
        success = subprocess.CompletedProcess([], 0, 'HTTP/2.0 200 OK\r\nHeader: value\r\n\r\n{"id":123}\n', '')
        missing = subprocess.CompletedProcess([], 1, 'HTTP/2.0 404 Not Found\nHeader: value\n\n{"message":"missing"}', 'raw sensitive failure')
        with patch.object(publisher.subprocess, 'run', return_value=success):
            self.assertEqual(api.api('repos/example/project/releases/123'), {'id': 123})
        with patch.object(publisher.subprocess, 'run', return_value=missing):
            self.assertIsNone(api.api('endpoint', allow_missing=True))
            with self.assertRaisesRegex(ValueError, r'HTTP 404') as error:
                api.api('endpoint')
            self.assertNotIn('sensitive', str(error.exception))

    def test_network_error_cannot_be_treated_as_a_missing_release(self):
        result = subprocess.CompletedProcess([], 1, '', 'private token or URL')
        with patch.object(publisher.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                publisher.GitHub().api('endpoint', allow_missing=True)

    def test_release_metadata_is_structured_json_not_shell_interpolated(self):
        data = {'body': 'Literal `text` and $(text)\nActual newline'}
        result = subprocess.CompletedProcess([], 0, 'HTTP/2.0 201 Created\n\n{}', '')
        with patch.object(publisher.subprocess, 'run', return_value=result) as run:
            publisher.GitHub().api('endpoint', method='POST', data=data)
        args, kwargs = run.call_args
        self.assertEqual(args[0][-2:], ['--input', '-'])
        self.assertEqual(json.loads(kwargs['input']), data)
        self.assertNotIn('shell', kwargs)


if __name__ == '__main__':
    unittest.main()
