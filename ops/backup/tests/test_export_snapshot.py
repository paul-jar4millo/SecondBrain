import io
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'export-snapshot.py'


class ExportTests(unittest.TestCase):
    def test_rebuilt_accounts_and_recovered_work_are_in_daily_data(self):
        entries = {
            'srv/sb-agente/recuperado/2026-11-15/workspaces/input.txt': b'work',
            'var/lib/sb-agente/claude/.credentials.json': b'private-fixture',
            'var/lib/sb-agente/codex/auth.json': b'private-fixture',
            'var/lib/sb-agente/agentes.env': b'private-fixture',
        }
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.fixture(entries))], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:') as archive:
            self.assertEqual(set(archive.getnames()), set(entries))

    @unittest.skipUnless(os.name == 'posix', 'GNU sparse archive requires Linux tar')
    def test_sparse_pax_input_becomes_valid_regular_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / 'srv/secondbrain/vault/sparse.pdf'
            data.parent.mkdir(parents=True)
            with data.open('wb') as output:
                output.write(b'%PDF-1.7')
                output.seek(2 * 1024 * 1024)
                output.write(b'END')
            source = root / 'sparse.tar'
            subprocess.run(['tar', '--format=pax', '--sparse', '-cf', str(source), '-C', str(root), 'srv'], check=True)
            result = subprocess.run([sys.executable, str(SCRIPT), str(source)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:') as archive:
                self.assertEqual(archive.extractfile('srv/secondbrain/vault/sparse.pdf').read(), data.read_bytes())

    def fixture(self, entries, links=()):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        archive = Path(temp.name) / 'fixture.tar'
        with tarfile.open(archive, 'w') as stream:
            for name, body in entries.items():
                info = tarfile.TarInfo(name)
                info.size = len(body)
                stream.addfile(info, io.BytesIO(body))
            for name, target, kind in links:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.linkname = target
                stream.addfile(info)
        return archive

    def test_keeps_knowledge_and_ignored_work_but_excludes_chats_and_tools(self):
        source = self.fixture({'./srv/secondbrain/vault/Home.md': b'knowledge', './srv/secondbrain/vault/node_modules/knowledge.md': b'authored knowledge', './var/lib/secondbrain/shared/index.json': b'{}', './srv/sb-agent/projects/example/ignored.bin': b'work', './var/lib/sb-agent/state/launcher/workspaces/one/entrega/final.zip': b'final', './var/lib/sb-agent/state/launcher/workspaces/one/.tools/bin/download': b'cache', './var/lib/sb-agent/state/launcher/sesiones.json': b'chat', './var/lib/sb-agente/codex/thread_history_1.sqlite': b'chat'})
        result = subprocess.run([sys.executable, str(SCRIPT), str(source)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:') as archive:
            self.assertEqual(set(archive.getnames()), {'srv/secondbrain/vault/Home.md', 'srv/secondbrain/vault/node_modules/knowledge.md', 'var/lib/secondbrain/shared/index.json', 'srv/sb-agente/proyectos/example/ignored.bin', 'var/lib/sb-agente/estado/lanzador/workspaces/one/entrega/final.zip'})
            self.assertEqual(archive.extractfile('srv/secondbrain/vault/Home.md').read(), b'knowledge')

    def test_preserves_english_host_paths_and_legacy_links(self):
        entries = {
            'srv/sb-agent/projects/example/source.txt': b'project',
            'srv/sb-agent/projects/example/node_modules/example.js': b'cache',
            'srv/sb-agent/deliverables/final.zip': b'deliverable',
            'var/lib/sb-agent/state/launcher/espacios.json': b'links',
            'var/lib/sb-agent/state/launcher/workspaces/example/file.txt': b'workspace',
            'var/lib/sb-agent/state/launcher/workspaces/example/.tools/bin/download': b'cache',
        }
        source = self.fixture(entries, [
            ('srv/sb-agente/proyectos', '../sb-agent/projects', tarfile.SYMTYPE),
            ('srv/sb-agente/entregables', '../sb-agent/deliverables', tarfile.SYMTYPE),
        ])
        result = subprocess.run([sys.executable, str(SCRIPT), str(source)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:') as archive:
            self.assertEqual(set(archive.getnames()), {
                'srv/sb-agent/projects/example/source.txt',
                'srv/sb-agent/deliverables/final.zip',
                'var/lib/sb-agent/state/launcher/espacios.json',
                'var/lib/sb-agent/state/launcher/workspaces/example/file.txt',
                'srv/sb-agente/proyectos',
                'srv/sb-agente/entregables',
            })

    def test_rejects_path_traversal_even_if_streaming_has_started(self):
        source = self.fixture({'./srv/secondbrain/vault/Home.md': b'knowledge', '../outside': b'bad'})
        result = subprocess.run([sys.executable, str(SCRIPT), str(source)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_preserves_unique_transfer_material_and_safe_links(self):
        source = self.fixture({'srv/secondbrain/vault/Home.md': b'knowledge', 'var/lib/sb-agente/estado/lanzador/workspaces/one/.transfer/unique.txt': b'unique work'}, [('srv/secondbrain/vault/hard.md', 'srv/secondbrain/vault/Home.md', tarfile.LNKTYPE), ('srv/secondbrain/vault/link.md', '/srv/secondbrain/vault/Home.md', tarfile.SYMTYPE)])
        result = subprocess.run([sys.executable, str(SCRIPT), str(source)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:') as archive:
            self.assertIn('srv/secondbrain/vault/hard.md', archive.getnames())
            self.assertEqual(archive.extractfile('srv/secondbrain/vault/hard.md').read(), b'knowledge')
            self.assertEqual(archive.getmember('srv/secondbrain/vault/link.md').linkname, 'Home.md')
            self.assertEqual(archive.extractfile('var/lib/sb-agente/estado/lanzador/workspaces/one/.transfer/unique.txt').read(), b'unique work')

    def test_unclassified_link_escape_fails_instead_of_dropping_it(self):
        source = self.fixture({'srv/secondbrain/vault/Home.md': b'knowledge'}, [('srv/secondbrain/vault/escape', '/etc/shadow', tarfile.SYMTYPE)])
        result = subprocess.run([sys.executable, str(SCRIPT), str(source)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
