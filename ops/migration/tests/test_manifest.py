import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'manifest.py'


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'editable-ñ.md').write_text('conocimiento sintético', encoding='utf-8')
        (self.source / 'ignored.bin').write_bytes(b'\x00\x01\x02')
        self.policy = self.root / 'policy.json'
        self.policy.write_text(json.dumps({'version': 1, 'roots': [{'source': str(self.source), 'target': '/srv/recovered', 'category': 'knowledge', 'action': 'preserve', 'exclude': []}]}), encoding='utf-8')
        self.manifest = self.root / 'manifest.json'

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)

    def scan(self):
        result = self.run_cli('scan', '--policy', str(self.policy), '--output', str(self.manifest))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(self.manifest.read_text(encoding='utf-8'))

    def test_preserves_unicode_and_files_ignored_by_git(self):
        data = self.scan()
        self.assertEqual({f['target'] for f in data['files']}, {'/srv/recovered/editable-ñ.md', '/srv/recovered/ignored.bin'})
        item = next(f for f in data['files'] if f['target'].endswith('ignored.bin'))
        self.assertEqual(item['bytes'], 3)
        self.assertEqual(item['sha256'], 'ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc')

    def test_detects_missing_or_changed_files_without_repairing_them(self):
        self.scan()
        target = self.root / 'restore' / 'srv' / 'recovered'
        target.mkdir(parents=True)
        (target / 'editable-ñ.md').write_text('conocimiento sintético', encoding='utf-8')
        (target / 'ignored.bin').write_bytes(b'\x00\x01\x02')
        self.assertEqual(self.run_cli('verify', '--manifest', str(self.manifest), '--root', str(self.root / 'restore')).returncode, 0)
        (target / 'ignored.bin').write_bytes(b'wrong')
        self.assertNotEqual(self.run_cli('verify', '--manifest', str(self.manifest), '--root', str(self.root / 'restore')).returncode, 0)
        self.assertEqual((target / 'ignored.bin').read_bytes(), b'wrong')

    @unittest.skipIf(sys.platform == 'win32', 'requires POSIX symlink permissions')
    def test_rejects_symlink_escape_from_declared_root(self):
        outside = self.root / 'outside'
        outside.write_text('not authorized')
        (self.source / 'escape').symlink_to(outside)
        result = self.run_cli('scan', '--policy', str(self.policy), '--output', str(self.manifest))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.manifest.exists())

    @unittest.skipIf(sys.platform == 'win32', 'requires POSIX symlink permissions')
    def test_explicit_policy_normalizes_in_root_absolute_link_for_relocation(self):
        (self.source / 'link').symlink_to(self.source / 'ignored.bin')
        policy = json.loads(self.policy.read_text(encoding='utf-8'))
        policy['roots'][0]['normalizeAbsoluteLinks'] = True
        self.policy.write_text(json.dumps(policy), encoding='utf-8')
        data = self.scan()
        link = next(item for item in data['files'] if item['target'].endswith('/link'))
        self.assertEqual(link['link'], 'ignored.bin')

    def test_rejects_manifest_target_traversal(self):
        data = self.scan()
        data['files'][0]['target'] = '/../outside'
        self.manifest.write_text(json.dumps(data), encoding='utf-8')
        self.assertNotEqual(self.run_cli('verify', '--manifest', str(self.manifest), '--root', str(self.root)).returncode, 0)

    @unittest.skipIf(sys.platform == 'win32', 'requires POSIX symlink permissions')
    def test_classified_dangling_internal_link_survives_relocation(self):
        (self.source / 'link').symlink_to(self.source / 'missing')
        policy = json.loads(self.policy.read_text())
        policy['roots'][0].update(normalizeAbsoluteLinks=True, preserveBrokenLinks=True)
        self.policy.write_text(json.dumps(policy))
        data = self.scan()
        link = next(f for f in data['files'] if f['type']=='symlink')
        self.assertTrue(link['dangling'])
        target = self.root / 'restore' / 'srv/recovered'
        target.mkdir(parents=True)
        for name in ['editable-ñ.md', 'ignored.bin']:
            (target / name).write_bytes((self.source / name).read_bytes())
        (target / 'link').symlink_to('missing')
        self.assertEqual(self.run_cli('verify','--manifest',str(self.manifest),'--root',str(self.root/'restore')).returncode,0)
        (target/'link').unlink()
        (target/'link').symlink_to('/etc/missing')
        self.assertNotEqual(self.run_cli('verify','--manifest',str(self.manifest),'--root',str(self.root/'restore')).returncode,0)


if __name__ == '__main__':
    unittest.main()
