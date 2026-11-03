#!/usr/bin/env python3
"""Install optional CI signing inputs without writing secrets to the checkout."""
import base64
import json
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import subprocess
import sys


def run(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Commands include passwords: do not echo argv or tools' diagnostics.
        raise RuntimeError(f'{args[0]} signing operation failed; verify supplied credentials')
    return result.stdout


def directory():
    root = os.environ.get('RUNNER_TEMP')
    if not root or not Path(root).is_absolute():
        raise ValueError('Signing setup requires the GitHub runner temporary directory')
    return Path(root) / 'isaac-signing'


def decode(variable, filename, required=True):
    value = os.environ.get(variable, '')
    if not value:
        if required:
            raise ValueError(f'Missing signing secret: {variable}')
        return None
    root = directory()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = base64.b64decode(value, validate=True)
    path = root / filename
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
    return path


def export(name, value):
    if '\n' in str(value) or '\r' in str(value):
        raise ValueError('Invalid signing environment value')
    with open(os.environ['GITHUB_ENV'], 'a') as stream:
        stream.write(f'{name}={value}\n')


def configure(platform):
    if platform == 'android':
        key = decode('ANDROID_KEYSTORE_BASE64', 'android.jks', required=False)
        if key:
            export('ANDROID_KEYSTORE_PATH', key)
        else:
            print('No release keystore configured: APK will use a test signing identity.')
    elif platform == 'macos':
        certificate = decode('MAC_CERTIFICATE_BASE64', 'macos.p12')
        api_key = decode('APPLE_API_KEY_BASE64', 'notarization.p8')
        export('CSC_LINK', certificate)
        export('APPLE_API_KEY', api_key)
    elif platform == 'ios':
        if not os.environ.get('APPLE_CERTIFICATE_BASE64'):
            print('No iOS certificate configured: produce an unsigned IPA for later sideload signing.')
            return
        certificate = decode('APPLE_CERTIFICATE_BASE64', 'ios.p12')
        profile = decode('IOS_PROFILE_BASE64', 'profile.mobileprovision')
        options = decode('IOS_EXPORT_OPTIONS_BASE64', 'ExportOptions.plist')
        plistlib.loads(options.read_bytes())
        keychain = directory() / 'build.keychain-db'
        password = secrets.token_urlsafe(32)
        run('security', 'create-keychain', '-p', password, str(keychain))
        run('security', 'set-keychain-settings', '-lut', '21600', str(keychain))
        run('security', 'unlock-keychain', '-p', password, str(keychain))
        run('security', 'import', str(certificate), '-k', str(keychain), '-P', os.environ.get('APPLE_CERTIFICATE_PASSWORD', ''), '-T', '/usr/bin/codesign', '-T', '/usr/bin/security')
        run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-k', password, str(keychain))
        # This is a disposable GitHub-hosted runner, not the user's login keychain.
        run('security', 'list-keychains', '-d', 'user', '-s', str(keychain))
        decoded = plistlib.loads(run('security', 'cms', '-D', '-i', str(profile)))
        uuid = decoded.get('UUID', '')
        if not uuid or any(c not in '0123456789abcdefABCDEF-' for c in uuid):
            raise ValueError('Invalid provisioning profile UUID')
        profiles = Path.home() / 'Library/MobileDevice/Provisioning Profiles'
        profiles.mkdir(parents=True, exist_ok=True)
        destination = profiles / (uuid + '.mobileprovision')
        if destination.exists():
            raise ValueError('Provisioning profile already exists on this runner')
        shutil.copyfile(profile, destination)
        (directory() / 'cleanup.json').write_text(json.dumps({'profile': str(destination), 'keychain': str(keychain)}))
        export('IOS_EXPORT_OPTIONS_PLIST', options)
        export('IOS_PROVISIONING_PROFILE_SPECIFIER', uuid)
        teams = decoded.get('TeamIdentifier', [])
        if len(teams) != 1 or not isinstance(teams[0], str):
            raise ValueError('Provisioning profile must identify exactly one team')
        export('APPLE_TEAM_ID', teams[0])
    else:
        raise ValueError('Use android, ios, macos or cleanup')


def cleanup():
    root = directory()
    keychain = root / 'build.keychain-db'
    if keychain.exists():
        run('security', 'delete-keychain', str(keychain))
    receipt = root / 'cleanup.json'
    if receipt.exists():
        record = json.loads(receipt.read_text())
        profile = Path(record['profile'])
        expected = Path.home() / 'Library/MobileDevice/Provisioning Profiles'
        if profile.parent != expected or profile.suffix != '.mobileprovision':
            raise ValueError('Invalid signing cleanup receipt')
        profile.unlink(missing_ok=True)
    if root.exists():
        shutil.rmtree(root)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: signing.py android|ios|macos|cleanup')
        cleanup() if sys.argv[1] == 'cleanup' else configure(sys.argv[1])
    except Exception as error:
        print(f'Signing setup failed: {error}', file=sys.stderr)
        sys.exit(1)
