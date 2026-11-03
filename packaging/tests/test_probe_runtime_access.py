"""Access diagnostics must identify the failing layer without exposing secrets."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/probe_runtime_access.py'
SPEC = importlib.util.spec_from_file_location('probe_runtime_access', SCRIPT)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)

TOKEN = 'github_pat_secret-do-not-log-123456789'
URL = 'https://api.github.com/repos/fixture/private-runtime/releases/assets/123'
REPO = 'https://api.github.com/repos/fixture/private-runtime'
SIZE = 123456


class Response(io.BytesIO):
    def __init__(self, data, headers=None):
        super().__init__(data)
        self.status = 200
        self.headers = headers or {}
        self.reads = []

    def read(self, size=-1):
        self.reads.append(size)
        return super().read(size)


class FakeOpener:
    def __init__(self, replacements=None):
        self.download = Response(b'\x1f\x8b' + TOKEN.encode() + URL.encode(), {'Content-Type': 'application/octet-stream', 'Content-Length': str(SIZE)})
        self.responses = {
            ('https://api.github.com/user', False): Response(json.dumps({'login': 'fixture-user', 'email': TOKEN}).encode()),
            (REPO, False): Response(json.dumps({'private': True, 'permissions': {'admin': True, 'pull': True, 'secret': TOKEN}, 'clone_url': URL}).encode()),
            (URL, False): Response(json.dumps({'name': 'isaac-runtime.tar.gz', 'size': SIZE, 'browser_download_url': URL, 'secret': TOKEN}).encode()),
            (URL, True): self.download,
        }
        self.responses.update(replacements or {})
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        response = self.responses[(request.full_url, request.get_header('Accept') == 'application/octet-stream')]
        if isinstance(response, Exception):
            raise response
        return response


def http_error(status):
    return urllib.error.HTTPError(URL, status, TOKEN, {'X-Accepted-GitHub-Permissions': 'contents=read',
                                                     'Location': URL + '?token=' + TOKEN}, io.BytesIO((TOKEN + URL).encode()))


class RuntimeAccessProbeTests(unittest.TestCase):
    def assert_private(self, report):
        rendered = json.dumps(report)
        self.assertNotIn(TOKEN, rendered)
        self.assertNotIn(URL, rendered)
        self.assertNotIn('browser_download_url', rendered)
        self.assertNotIn('Location', rendered)
        self.assertNotIn('clone_url', rendered)

    def test_four_successful_probes_only_read_two_download_bytes(self):
        opener = FakeOpener()
        report = probe.probe(URL, TOKEN, SIZE, opener)
        self.assertTrue(report['downloadReady'])
        self.assertEqual(report['diagnosis']['code'], 'download-ready')
        self.assertEqual(report['probes']['account'], {'status': 200, 'login': 'fixture-user'})
        self.assertEqual(report['probes']['repository']['repositoryRolePermissions'], {'admin': True, 'pull': True})
        self.assertEqual(opener.download.reads, [2])
        self.assertEqual(len(opener.requests), 4)
        self.assertTrue(all(request.get_header('Authorization') == 'Bearer ' + TOKEN for request in opener.requests))
        self.assert_private(report)

    def test_missing_token_and_invalid_url_fail_without_network(self):
        opener = FakeOpener()
        report = probe.probe(URL, '', SIZE, opener)
        self.assertEqual(report['diagnosis']['code'], 'missing-token')
        self.assertEqual(opener.requests, [])
        for url in ['http://api.github.com/repos/a/b/releases/assets/1',
                    'https://example.com/repos/a/b/releases/assets/1',
                    'https://user:password@api.github.com/repos/a/b/releases/assets/1',
                    URL + '?token=' + TOKEN, URL + '#private', 'https://api.github.com/repos/a/../releases/assets/1']:
            with self.subTest(url='redacted-invalid-url'):
                report = probe.probe(url, TOKEN, SIZE, opener)
                self.assertEqual(report['diagnosis']['code'], 'invalid-configuration')
                self.assertFalse(report['downloadReady'])
                self.assert_private(report)
        self.assertEqual(opener.requests, [])

    def test_valid_token_cannot_see_repository_is_distinguished_from_asset_404(self):
        report = probe.probe(URL, TOKEN, SIZE, FakeOpener({(REPO, False): http_error(404),
                                                        (URL, False): http_error(404), (URL, True): http_error(404)}))
        self.assertEqual(report['diagnosis']['code'], 'repository-not-visible')
        self.assertEqual(report['probes']['account']['status'], 200)
        self.assertEqual(report['probes']['repository']['status'], 404)
        self.assert_private(report)
        report = probe.probe(URL, TOKEN, SIZE, FakeOpener({(URL, False): http_error(404), (URL, True): http_error(404)}))
        self.assertEqual(report['diagnosis']['code'], 'asset-missing-or-permission-hidden')
        self.assertIn('cannot distinguish', report['diagnosis']['message'])
        self.assertEqual(report['probes']['assetMetadata']['requiredPermissions'], 'contents=read')
        self.assert_private(report)

    def test_rejected_token_permission_denial_and_binary_failure_are_distinct(self):
        cases = [
            ({('https://api.github.com/user', False): http_error(401), (URL, True): http_error(401)}, 'token-rejected'),
            ({(URL, False): http_error(403), (URL, True): http_error(403)}, 'asset-permission-denied'),
            ({(URL, True): http_error(404)}, 'asset-download-failed'),
        ]
        for replacements, code in cases:
            with self.subTest(code=code):
                report = probe.probe(URL, TOKEN, SIZE, FakeOpener(replacements))
                self.assertFalse(report['downloadReady'])
                self.assertEqual(report['diagnosis']['code'], code)
                self.assert_private(report)

    def test_wrong_body_or_missing_or_wrong_size_cannot_report_ready(self):
        for body, length, code in [(b'{}', str(SIZE), 'download-is-not-gzip'),
                                   (b'\x1f\x8b', '', 'archive-size-mismatch'),
                                   (b'\x1f\x8b', '99', 'archive-size-mismatch')]:
            with self.subTest(code=code, length=length):
                response = Response(body, {'Content-Type': 'application/octet-stream', 'Content-Length': length})
                report = probe.probe(URL, TOKEN, SIZE, FakeOpener({(URL, True): response}))
                self.assertFalse(report['downloadReady'])
                self.assertEqual(report['diagnosis']['code'], code)

    def test_reflected_metadata_and_exception_details_never_expose_credentials(self):
        replacements = {
            (URL, False): Response(json.dumps({'name': TOKEN, 'size': SIZE}).encode()),
            (URL, True): urllib.error.URLError(URL + '?secret=' + TOKEN),
        }
        report = probe.probe(URL, TOKEN, SIZE, FakeOpener(replacements))
        self.assertEqual(report['probes']['assetMetadata']['name'], '[redacted]')
        self.assertEqual(report['probes']['assetDownload']['error'], 'network-or-redirect-error')
        self.assert_private(report)

    def test_command_prints_json_and_returns_nonzero_for_bad_download(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'runtime.lock.json'
            lock.write_text(json.dumps({'bytes': SIZE}))
            output = io.StringIO()
            opener = FakeOpener({(URL, True): http_error(404)})
            with mock.patch.object(probe.sys, 'argv', ['probe_runtime_access.py', '--lock', str(lock)]), \
                    mock.patch.dict(probe.os.environ, {'ISAAC_RUNTIME_URL': URL, 'ISAAC_RUNTIME_TOKEN': TOKEN}), \
                    mock.patch.object(probe.urllib.request, 'build_opener', return_value=opener), \
                    contextlib.redirect_stdout(output):
                self.assertEqual(probe.main(), 1)
            report = json.loads(output.getvalue())
            self.assertEqual(report['diagnosis']['code'], 'asset-download-failed')
            self.assert_private(report)


if __name__ == '__main__':
    unittest.main()
