#!/usr/bin/env python3
"""Diagnose private GitHub runtime access without exposing credentials or URLs.

Uses only ISAAC_RUNTIME_URL and ISAAC_RUNTIME_TOKEN supplied to this process.
The download probe reads two bytes; this does not replace full archive hashing.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_inputs import MAX_BYTES, PrivateRedirect

ROOT = Path(__file__).resolve().parents[2]
PATH = re.compile(r'^/repos/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]{1,100})/releases/assets/([1-9][0-9]*)$')


def required_permissions(headers):
    value = headers.get('X-Accepted-GitHub-Permissions', '')
    # Only the API's permission requirement is retained, never request IDs,
    # redirect targets, authentication headers, cookies or response bodies.
    if value and len(value) <= 256 and re.fullmatch(r'[a-z_]+=(?:read|write)(?:[,; ]+[a-z_]+=(?:read|write))*', value):
        return {'requiredPermissions': value}
    return {}


def response_probe(opener, url, token, *, download=False):
    headers = {'Authorization': 'Bearer ' + token, 'User-Agent': 'Isaac-Repentance-access-probe',
               'X-GitHub-Api-Version': '2022-11-28',
               'Accept': 'application/octet-stream' if download else 'application/vnd.github+json'}
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
            result = {'status': response.status, **required_permissions(response.headers)}
            if download:
                content_type = response.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
                result['contentType'] = content_type if re.fullmatch(r'[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+', content_type) else 'unavailable'
                length = response.headers.get('Content-Length', '')
                result['bytes'] = int(length) if re.fullmatch(r'[0-9]{1,20}', length) else None
                result['gzipMagicMatches'] = response.read(2) == b'\x1f\x8b'
                return result, None
            if response.status != 200:
                return result, None
            data = response.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                return {**result, 'error': 'metadata-too-large'}, None
            try:
                value = json.loads(data)
            except (UnicodeDecodeError, ValueError):
                return {**result, 'error': 'invalid-json'}, None
            if not isinstance(value, dict):
                return {**result, 'error': 'invalid-metadata'}, None
            return result, value
    except urllib.error.HTTPError as error:
        result = {'status': error.code, **required_permissions(error.headers)}
        error.close()
        return result, None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        # Exception text can contain a credential-bearing URL. Never include it.
        return {'status': None, 'error': 'network-or-redirect-error'}, None


def diagnosis(probes, expected_bytes):
    account, repository, metadata, download = (probes[name] for name in ('account', 'repository', 'assetMetadata', 'assetDownload'))
    if download.get('status') == 200 and download.get('gzipMagicMatches') and download.get('bytes') == expected_bytes:
        return 'download-ready', 'The supplied token can download the pinned-size gzip resource; full archive verification is still required.'
    if account.get('status') == 401:
        return 'token-rejected', 'GitHub rejected the supplied token; it may be invalid, expired or revoked.'
    if account.get('status') != 200:
        return 'account-probe-failed', 'Account authentication could not be established; inspect the account status.'
    if repository.get('status') == 404:
        return 'repository-not-visible', 'The token is valid but cannot see the configured repository, or that repository does not exist.'
    if repository.get('status') == 403:
        return 'repository-access-denied', 'GitHub denied access to the configured repository; check repository selection, organization approval and policy.'
    if repository.get('status') != 200:
        return 'repository-probe-failed', 'The repository probe failed; inspect its status.'
    if metadata.get('status') == 403:
        return 'asset-permission-denied', 'The repository is visible but release-asset access is denied; the token needs Contents: read and any required organization approval.'
    if metadata.get('status') == 404:
        return 'asset-missing-or-permission-hidden', 'The repository is visible, but the asset ID may be missing or Contents: read may be absent. GitHub masks both as 404, so this probe cannot distinguish them.'
    if metadata.get('status') != 200:
        return 'asset-metadata-probe-failed', 'Release-asset metadata could not be read; inspect its status.'
    if download.get('status') != 200:
        return 'asset-download-failed', 'The token can read this asset metadata, but the binary download failed; inspect its status and permission requirement.'
    if not download.get('gzipMagicMatches'):
        return 'download-is-not-gzip', 'The binary endpoint did not return gzip bytes; the response may be metadata rather than the archive.'
    return 'archive-size-mismatch', 'The download size is missing or differs from the pinned runtime archive size.'


def redact(value, token, url):
    if isinstance(value, str):
        for sensitive in (token, url):
            if sensitive:
                value = value.replace(sensitive, '[redacted]')
        return value
    if isinstance(value, list):
        return [redact(item, token, url) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, token, url) for key, item in value.items()}
    return value


def probe(url, token, expected_bytes, opener=None):
    report = {'format': 'isaac-runtime-access-probe-v1', 'tokenPresent': bool(token),
              'expectedArchiveBytes': expected_bytes, 'probes': {}, 'downloadReady': False}
    if not token:
        report['diagnosis'] = {'code': 'missing-token', 'message': 'ISAAC_RUNTIME_TOKEN is missing from this workflow step.'}
        return report
    try:
        parsed = urllib.parse.urlparse(url)
        match = PATH.fullmatch(parsed.path)
        if (parsed.scheme != 'https' or parsed.hostname != 'api.github.com' or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.query or parsed.fragment or not match
                or match[2] in ('.', '..') or '\r' in token or '\n' in token
                or type(expected_bytes) is not int or not 0 < expected_bytes <= MAX_BYTES):
            raise ValueError('Invalid configuration')
    except (ValueError, TypeError):
        report['diagnosis'] = {'code': 'invalid-configuration', 'message': 'Use a GitHub HTTPS release-asset API URL, a single-line token, and a valid pinned archive size.'}
        return redact(report, token, url)
    opener = opener or urllib.request.build_opener(PrivateRedirect())
    repository_url = f'https://api.github.com/repos/{match[1]}/{match[2]}'
    account, account_data = response_probe(opener, 'https://api.github.com/user', token)
    if account_data and isinstance(account_data.get('login'), str) and re.fullmatch(r'[A-Za-z0-9-]{1,39}', account_data['login']):
        account['login'] = account_data['login']
    report['probes']['account'] = account
    repository, repository_data = response_probe(opener, repository_url, token)
    if repository_data:
        if type(repository_data.get('private')) is bool:
            repository['private'] = repository_data['private']
        permissions = repository_data.get('permissions')
        if isinstance(permissions, dict):
            repository['repositoryRolePermissions'] = {name: permissions[name] for name in ('admin', 'maintain', 'push', 'triage', 'pull') if type(permissions.get(name)) is bool}
    report['probes']['repository'] = repository
    metadata, metadata_data = response_probe(opener, url, token)
    if metadata_data:
        name = metadata_data.get('name')
        if isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_. -]{1,200}', name):
            metadata['name'] = name
        if type(metadata_data.get('size')) is int and metadata_data['size'] >= 0:
            metadata['bytes'] = metadata_data['size']
    report['probes']['assetMetadata'] = metadata
    download, _ = response_probe(opener, url, token, download=True)
    report['probes']['assetDownload'] = download
    code, message = diagnosis(report['probes'], expected_bytes)
    report['diagnosis'] = {'code': code, 'message': message}
    report['downloadReady'] = code == 'download-ready'
    return redact(report, token, url)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, default=ROOT / 'packaging/runtime.lock.json')
    args = parser.parse_args()
    try:
        expected_bytes = json.loads(args.lock.read_text())['bytes']
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({'downloadReady': False, 'diagnosis': {'code': 'invalid-lock', 'message': 'The pinned runtime lock could not be read.'}}))
        return 1
    report = probe(os.environ.get('ISAAC_RUNTIME_URL', ''), os.environ.get('ISAAC_RUNTIME_TOKEN', ''), expected_bytes)
    print(json.dumps(report, indent=2))
    return 0 if report['downloadReady'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
