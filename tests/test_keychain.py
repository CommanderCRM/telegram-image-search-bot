import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import unittest
import uuid

PROJECT = Path(__file__).resolve().parents[1]


class LauncherKeychainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        shutil.copy(PROJECT/'start-local.command', self.root/'start-local.command')
        (self.root/'scripts').mkdir()
        (self.root/'scripts/settings.mjs').write_text("console.log('example_gallery_bot');\n")
        source = self.root/'scripts/keychain.swift'
        source.touch()
        os.utime(source, (1, 1))
        (self.root/'.local').mkdir()
        photo_source = self.root/'scripts/prepare-photo.swift'
        photo_source.touch()
        os.utime(photo_source, (1, 1))
        photo_helper = self.root/'.local/prepare-photo'
        photo_helper.write_text('#!/bin/sh\nexit 0\n')
        photo_helper.chmod(0o700)
        self.helper = self.root/'.local/keychain-helper'
        self.helper.write_text('''#!/usr/bin/env python3
import os,sys
from pathlib import Path
p=Path(__file__).parent/'fixture-value'
if os.environ.get('FAKE_KEYCHAIN_DENIED')=='1': sys.exit(45)
if sys.argv[1]=='get':
    if not p.exists(): sys.exit(44)
    sys.stdout.write(p.read_text())
elif sys.argv[1]=='put':
    p.write_text(sys.stdin.read())
else: sys.exit(64)
''')
        self.helper.chmod(0o700)
        (self.root/'bin').mkdir()
        stub=self.root/'bin/caffeinate'
        stub.write_text('''#!/usr/bin/env python3
import os,sys
if os.environ.get('TELEGRAM_BOT_TOKEN')!=os.environ['EXPECTED_FIXTURE']: sys.exit(1)
if '--replace-token' in sys.argv: sys.exit(2)
print('Launcher child received expected token via environment')
''')
        stub.chmod(0o700)

    def tearDown(self):
        self.temp.cleanup()

    def launch(self, input, expected, *args, denied=False):
        env = dict(os.environ)
        # No real credentials enter the fixture process.
        env.pop('TELEGRAM_BOT_TOKEN', None)
        env.pop('TELEGRAM_BOT_USERNAME', None)
        env['PATH'] = str(self.root/'bin') + ':' + env['PATH']
        env['EXPECTED_FIXTURE'] = expected
        if denied: env['FAKE_KEYCHAIN_DENIED']='1'
        result = subprocess.run(['zsh', str(self.root/'start-local.command'), *args], input=input,
                                env=env, text=True, capture_output=True, timeout=10)
        self.assertNotIn(expected, result.stdout + result.stderr)
        return result

    def test_first_save_then_restart_without_token_prompt(self):
        value = secrets.token_urlsafe(40)
        first = self.launch(value+'\n42\n', value)
        self.assertEqual(first.returncode, 0)
        self.assertIn('Токен сохранён', first.stdout)
        second = self.launch('42\n', value)
        self.assertEqual(second.returncode, 0)
        self.assertIn('Токен прочитан', second.stdout)

    def test_denied_access_does_not_overwrite_or_prompt_for_token(self):
        value = secrets.token_urlsafe(40)
        (self.root/'.local/fixture-value').write_text(value)
        result = self.launch('', value, denied=True)
        self.assertEqual(result.returncode, 45)
        self.assertTrue((self.root/'.local/fixture-value').read_text() == value)

    def test_explicit_replacement_saves_and_reads_new_value(self):
        old, new = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
        (self.root/'.local/fixture-value').write_text(old)
        result = self.launch(new+'\n42\n', new, '--replace-token')
        self.assertEqual(result.returncode, 0)
        self.assertTrue((self.root/'.local/fixture-value').read_text() == new)


@unittest.skipUnless(os.environ.get('KEYCHAIN_INTEGRATION_TEST') == '1', 'Explicit native Keychain test only')
class NativeKeychainTests(unittest.TestCase):
    def test_missing_save_read_update_delete(self):
        helper = PROJECT/'.local/keychain-helper'
        account = 'test_' + uuid.uuid4().hex
        first, second = secrets.token_urlsafe(40).encode(), secrets.token_urlsafe(40).encode()

        def run(action, data=None):
            return subprocess.run([str(helper), action, account], input=data, capture_output=True, timeout=30)

        try:
            self.assertEqual(run('get').returncode, 44)
            self.assertEqual(run('put', first).returncode, 0)
            self.assertTrue(run('get').stdout == first, 'First Keychain readback mismatch')
            self.assertEqual(run('put', second).returncode, 0)
            self.assertTrue(run('get').stdout == second, 'Updated Keychain readback mismatch')
            self.assertEqual(run('delete').returncode, 0)
            self.assertEqual(run('get').returncode, 44)
        finally:
            run('delete')


if __name__ == '__main__':
    unittest.main()
