"""Stream durable data from a consistent container (vzdump) archive; stdout must go to encryption."""
import subprocess
import sys
import tarfile
import posixpath
from pathlib import PurePosixPath

PROJECT_ROOTS = ('srv/sb-agente/proyectos', 'srv/sb-agent/projects')
WORKSPACE_ROOTS = (
    'var/lib/sb-agente/estado/lanzador/workspaces',
    'var/lib/sb-agent/state/launcher/workspaces',
)

ROOTS = (
    'srv/secondbrain/vault',
    'var/lib/secondbrain/shared',
    'var/lib/secondbrain/history',
    'var/lib/secondbrain/operations',
    'var/lib/secondbrain/vault-git',
    'var/lib/secondbrain/auth.json',
    *PROJECT_ROOTS,
    'srv/sb-agente/entregables',
    'srv/sb-agent/deliverables',
    'srv/sb-agente/recuperado',
    'var/lib/sb-agente/claude/.credentials.json',
    'var/lib/sb-agente/codex/auth.json',
    'var/lib/sb-agente/.gemini/antigravity-cli/antigravity-oauth-token',
    'var/lib/sb-agente/.config/gh/hosts.yml',
    'var/lib/sb-agente/agentes.env',
    'var/lib/sb-agente/estado/lanzador/espacios.json',
    'var/lib/sb-agent/state/launcher/espacios.json',
    *WORKSPACE_ROOTS,
    'etc/secondbrain',
    'etc/sb-agente',
    'home/claude/homelab',
)
CACHE_PARTS = {'node_modules', '__pycache__', '.cache', '.tools'}


def selected(raw):
    name = PurePosixPath(raw)
    if not any(raw == root or raw.startswith(root + '/') for root in ROOTS):
        return False
    for root in WORKSPACE_ROOTS:
        if raw.startswith(root + '/') and CACHE_PARTS.intersection(name.relative_to(root).parts):
            return False
    for root in PROJECT_ROOTS:
        if raw.startswith(root + '/') and {'node_modules', '__pycache__'}.intersection(name.relative_to(root).parts):
            return False
    return True


def export(source):
    process = None
    try:
        if source.endswith('.zst'):
            process = subprocess.Popen(['zstd', '-q', '-d', '-c', '--', source], stdout=subprocess.PIPE)
            stream = process.stdout
        else:
            stream = open(source, 'rb')
        with stream, tarfile.open(fileobj=stream, mode='r|') as incoming, tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as outgoing:
            for member in incoming:
                raw = member.name.removeprefix('./')
                name = PurePosixPath(raw)
                if name.is_absolute() or '..' in name.parts:
                    raise ValueError('Unsafe source archive path')
                if not selected(raw):
                    continue
                if member.issym() or member.islnk():
                    if member.issym():
                        link = posixpath.normpath(member.linkname if member.linkname.startswith('/') else posixpath.join(posixpath.dirname(raw), member.linkname)).lstrip('/')
                    else:
                        link = member.linkname.removeprefix('./')
                    if '..' in PurePosixPath(link).parts or not selected(link):
                        raise ValueError('Unclassified link outside preserved data: ' + raw)
                    member.linkname = posixpath.relpath(link, posixpath.dirname(raw)) if member.issym() else link
                elif not (member.isfile() or member.isdir()):
                    raise ValueError('Unclassified special file in preserved data: ' + raw)
                content = incoming.extractfile(member) if member.isfile() else None
                member.name = str(name)
                # extractfile expands sparse extents. Do not retain headers that
                # tell readers the expanded payload still contains a sparse map.
                member.pax_headers = {k: v for k, v in member.pax_headers.items() if k not in ('path', 'linkpath', 'size') and not k.startswith('GNU.sparse.')}
                if member.sparse is not None:
                    member.sparse = None
                    member.type = tarfile.REGTYPE
                outgoing.addfile(member, content)
        if process and process.wait() != 0:
            raise ValueError('Source decompression failed')
    finally:
        if process and process.poll() is None:
            process.kill()
            process.wait()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: export-snapshot.py <consistent-container.tar.zst>')
        export(sys.argv[1])
    except (OSError, ValueError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
