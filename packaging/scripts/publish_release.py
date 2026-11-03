#!/usr/bin/env python3
"""Publish the four verified installers together, after all builds succeed.

Only explicitly selected installer files and their checksums leave the runner.
Uploads remain a draft until GitHub confirms every asset's SHA-256 and size.
Re-running the same workflow resumes its draft or verifies its published release.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote


def context(env, tag=None, title=None):
    repository = env.get('GITHUB_REPOSITORY', '')
    sha = env.get('GITHUB_SHA', '')
    run_id = env.get('GITHUB_RUN_ID', '')
    run_number = env.get('GITHUB_RUN_NUMBER', '')
    ref = env.get('GITHUB_REF', '')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('GITHUB_REPOSITORY must identify the source repository')
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('GITHUB_SHA must be the full source commit')
    if not run_id.isdigit() or not run_number.isdigit():
        raise ValueError('GitHub workflow run identifiers are required')
    if ref != 'refs/heads/main' and not ref.startswith('refs/tags/v'):
        raise ValueError('Releases are allowed only from main or version tags')
    tag = tag or (ref.removeprefix('refs/tags/') if ref.startswith('refs/tags/') else f'build-{run_number}')
    if not re.fullmatch(r'(?:v|build-)[A-Za-z0-9][A-Za-z0-9._-]*', tag) or '..' in tag or tag.endswith('.'):
        raise ValueError('Release tag must be a safe version or build tag')
    return dict(repository=repository, sha=sha, run_id=run_id, tag=tag,
                title=title or f'Isaac Repentance — {tag}',
                apple_signed=env.get('ISAAC_APPLE_SIGNED') == '1')


def file_record(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(block)
    size = path.stat().st_size
    if not size:
        raise ValueError(f'Empty release asset: {path.name}')
    # GitHub Release assets must be smaller than 2 GiB.
    if size >= 2 * 1024 ** 3:
        raise ValueError(f'Release asset exceeds GitHub size limit: {path.name}')
    return dict(path=path, name=path.name, size=size, digest='sha256:' + checksum.hexdigest())


def inventory(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Installer artifact directory is missing or linked')
    selected = {}
    versions = set()
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('Linked release inputs are not permitted')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('Release inputs must be regular files')
        relative = path.relative_to(directory)
        if path.name == 'Isaac-Repentance-android-release.apk':
            kind = 'android'
        elif path.name == 'Isaac-Repentance-ios-unsigned.ipa':
            kind = 'ios'
        elif ('ios-signed' in relative.parts[:-1]
              and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.ipa', path.name)):
            kind = 'ios'
        else:
            match = re.fullmatch(r'Isaac-Repentance-([A-Za-z0-9][A-Za-z0-9._-]*)-(arm64|x64)\.dmg', path.name)
            if not match:
                raise ValueError(f'Unexpected release input: {relative}')
            versions.add(match.group(1))
            kind = 'macos-' + match.group(2)
        if kind in selected:
            raise ValueError(f'Duplicate {kind} installer')
        selected[kind] = file_record(path)
    expected = {'android', 'ios', 'macos-arm64', 'macos-x64'}
    if set(selected) != expected:
        raise ValueError('Release requires the release APK, device IPA and both Mac DMGs')
    if len(versions) != 1:
        raise ValueError('Mac installers have inconsistent versions')
    return selected


def prepare_metadata(selected, details, directory):
    if directory.is_symlink():
        raise ValueError('Release metadata directory cannot be linked')
    directory.mkdir(parents=True, exist_ok=True)
    checksum_path = directory / 'SHA256SUMS.txt'
    notes_path = directory / 'release-notes.md'
    if checksum_path.is_symlink() or notes_path.is_symlink():
        raise ValueError('Release metadata files cannot be linked')
    records = sorted(selected.values(), key=lambda record: record['name'])
    checksum_path.write_text(''.join(f'{r["digest"].removeprefix("sha256:")}  {r["name"]}\n' for r in records), encoding='utf-8')
    repository, sha = details['repository'], details['sha']
    signed = details['apple_signed']
    ios_signed = selected['ios']['name'] != 'Isaac-Repentance-ios-unsigned.ipa'
    ios = ('Signed device export; installation is limited by its provisioning profile.' if ios_signed else
           'Unsigned device IPA; re-sign it with your sideloading tool before installation.')
    mac = ('Developer ID signed and notarized.' if signed else
           'Ad hoc signed; not Apple notarized. macOS may require an explicit security override.')
    notes = f'''Complete offline installers for Repentance **1.7.9b.J835**.

| Download | Installation |
| --- | --- |
| `{selected['android']['name']}` | Android APK signed with the project's persistent release key. |
| `{selected['ios']['name']}` | iOS/iPadOS 27+. {ios} |
| `{selected['macos-arm64']['name']}` | macOS 13+ on Apple silicon. {mac} |
| `{selected['macos-x64']['name']}` | macOS 13+ on Intel. {mac} |

Game resources are included. No Steam installation or first-run resource download is needed.
Player saves and preinstalled Mods are not included. Launcher interface: Simplified Chinese.
Android WebView and iOS WKWebView must support JSPI and WebGL 2. Physical mobile gameplay,
memory use and Mod compatibility still require device testing.

Use `SHA256SUMS.txt` to verify the downloads. GitHub's automatically generated
**Source code** archives contain the source project, not a playable game package.

Source: [{sha[:12]}](https://github.com/{repository}/commit/{sha})
Build: [GitHub Actions run {details['run_id']}](https://github.com/{repository}/actions/runs/{details['run_id']})

<!-- isaac-release-source: {sha}; run: {details['run_id']} -->
'''
    notes_path.write_text(notes, encoding='utf-8')
    return records + [file_record(checksum_path)], notes_path


class GitHub:
    """Keep command arguments structured and credentials in gh's environment."""
    def api(self, endpoint, method='GET', data=None, allow_missing=False):
        args = ['gh', 'api', '--method', method, '--include', endpoint]
        if data is not None:
            args += ['--input', '-']
        result = subprocess.run(args, input=json.dumps(data) if data is not None else None,
                                text=True, capture_output=True, check=False)
        response = result.stdout.replace('\r\n', '\n')
        headers, separator, body = response.partition('\n\n')
        status = re.match(r'HTTP/\S+\s+(\d+)', headers)
        code = int(status.group(1)) if status else None
        if code == 404 and allow_missing:
            return None
        if result.returncode or not separator or not code or not 200 <= code < 300:
            # Deliberately do not echo command stderr, headers or API response bodies.
            raise ValueError(f'GitHub API {method} failed (HTTP {code or "unavailable"})')
        return json.loads(body) if body.strip() else None

    def upload(self, repository, tag, path):
        result = subprocess.run(['gh', 'release', 'upload', tag, str(path), '--repo', repository],
                                text=True, capture_output=True, check=False)
        if result.returncode:
            raise ValueError(f'Upload failed for {path.name}; release remains a draft and can be retried')


def check_tag(api, base, tag, sha, required=False):
    result = api.api(base + '/git/ref/tags/' + quote(tag, safe=''), allow_missing=True)
    if result is None:
        if required:
            raise ValueError('Published release tag is missing')
        return
    obj = result['object']
    for _ in range(8):
        if obj.get('type') == 'commit':
            if obj.get('sha') != sha:
                raise ValueError('Release tag points to a different source commit')
            return
        if obj.get('type') != 'tag' or not re.fullmatch(r'[a-f0-9]{40}', obj.get('sha', '')):
            break
        obj = api.api(base + '/git/tags/' + obj['sha'])['object']
    raise ValueError('Cannot resolve the release tag to a commit')


def check_assets(release, records, complete=False):
    expected = {record['name']: record for record in records}
    actual = {}
    for asset in release.get('assets', []):
        name = asset.get('name')
        if name not in expected or name in actual:
            raise ValueError('Release contains an unexpected or duplicate asset')
        actual[name] = asset
        if asset.get('state') == 'starter' and release.get('draft'):
            continue  # GitHub can leave an empty starter after an interrupted upload.
        wanted = expected[name]
        if (asset.get('state') != 'uploaded' or asset.get('size') != wanted['size']
                or asset.get('digest') != wanted['digest']):
            raise ValueError(f'Remote release asset does not match this build: {name}')
    if complete and (set(actual) != set(expected) or any(a.get('state') != 'uploaded' for a in actual.values())):
        raise ValueError('Release is incomplete; it will remain a draft')
    return actual


def find_release(api, base, tag):
    release = api.api(base + '/releases/tags/' + quote(tag, safe=''), allow_missing=True)
    if release is not None:
        return release
    # The tag endpoint may expose only published releases. Authenticated release
    # listing also includes drafts, which is essential for retrying failed uploads.
    matches = []
    page = 1
    while True:
        releases = api.api(base + f'/releases?per_page=100&page={page}')
        matches += [item for item in releases if item.get('tag_name') == tag]
        if len(releases) < 100:
            break
        page += 1
    if len(matches) > 1:
        raise ValueError('Multiple releases use the requested tag')
    return matches[0] if matches else None


def publish(api, records, notes_path, details):
    base = 'repos/' + details['repository']
    tag, sha = details['tag'], details['sha']
    check_tag(api, base, tag, sha)
    release = find_release(api, base, tag)
    notes = notes_path.read_text(encoding='utf-8')
    marker = f'<!-- isaac-release-source: {sha}; run: {details["run_id"]} -->'
    if release is None:
        release = api.api(base + '/releases', method='POST', data={
            'tag_name': tag, 'target_commitish': sha, 'name': details['title'],
            'body': notes, 'draft': True, 'prerelease': False,
        })
    elif marker not in release.get('body', '') or release.get('target_commitish') != sha:
        raise ValueError('Existing release belongs to a different source commit or workflow run')
    actual = check_assets(release, records, complete=not release.get('draft'))
    if not release.get('draft'):
        check_tag(api, base, tag, sha, required=True)
        return release['html_url']
    for record in records:
        previous = actual.get(record['name'])
        if previous and previous.get('state') == 'uploaded':
            continue
        if previous:
            # Only our draft's failed-upload stub may be removed; published bytes
            # and completed assets are never replaced or clobbered.
            api.api(base + '/releases/assets/' + str(previous['id']), method='DELETE')
        api.upload(details['repository'], tag, record['path'])
    release = api.api(base + '/releases/' + str(release['id']))
    check_assets(release, records, complete=True)
    check_tag(api, base, tag, sha)
    release = api.api(base + '/releases/' + str(release['id']), method='PATCH', data={
        'draft': False, 'prerelease': False, 'make_latest': 'true',
        'body': notes, 'name': details['title'],
    })
    check_assets(release, records, complete=True)
    check_tag(api, base, tag, sha, required=True)
    return release['html_url']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', required=True, type=Path)
    parser.add_argument('--tag')
    parser.add_argument('--title')
    args = parser.parse_args()
    details = context(os.environ, args.tag, args.title)
    selected = inventory(args.artifacts)
    records, notes = prepare_metadata(selected, details, args.artifacts.parent / 'release-metadata')
    url = publish(GitHub(), records, notes, details)
    print(f'Release published and verified: {url}')
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as stream:
            stream.write(f'Public installers: [{details["tag"]}]({url})\n')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print(f'Release publication failed: {error}', file=sys.stderr)
        sys.exit(1)
