"""Read-only migration inventory and verification. Never repairs or deletes data."""
import argparse
import fnmatch
import hashlib
import json
import os
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(block)
    return sha.hexdigest()


def target_path(value):
    path = PurePosixPath(value)
    if not path.is_absolute() or '..' in path.parts or len(path.parts) < 2:
        raise ValueError('Unsafe manifest target')
    return path


def scan(policy_file, output):
    policy = json.loads(Path(policy_file).read_text(encoding='utf-8'))
    if policy.get('version') != 1 or not policy.get('roots'):
        raise ValueError('Invalid inventory policy')
    files, destinations = [], set()
    for entry in policy['roots']:
        root = Path(entry['source']).resolve(strict=True)
        if not root.is_dir() or root == Path(root.anchor):
            raise ValueError('Inventory requires a specific existing directory')
        target = target_path(entry['target'])
        excluded = entry.get('exclude', [])
        for directory, dirs, names in os.walk(root, followlinks=False):
            base = Path(directory)
            for name in sorted(dirs + names):
                path = base / name
                relative = path.relative_to(root).as_posix()
                if any(fnmatch.fnmatchcase(relative, item) for item in excluded):
                    if name in dirs:
                        dirs.remove(name)
                    continue
                classified_dangling = path.is_symlink() and entry.get('preserveBrokenLinks', False)
                resolved = path.resolve(strict=not classified_dangling)
                if not resolved.is_relative_to(root):
                    raise ValueError('Symlink escapes declared inventory root')
                metadata = path.lstat()
                if path.is_symlink():
                    # Preserve relative in-root links as links, never their contents.
                    link = os.readlink(path)
                    if Path(link).is_absolute():
                        if not entry.get('normalizeAbsoluteLinks', False):
                            raise ValueError('Absolute symlink requires administrative classification')
                        link = os.path.relpath(resolved, path.parent)
                    item = {'type': 'symlink', 'link': link, 'sourceLink': os.readlink(path), 'dangling': not path.exists()}
                    if name in dirs:
                        dirs.remove(name)
                elif stat.S_ISDIR(metadata.st_mode):
                    continue
                elif stat.S_ISREG(metadata.st_mode):
                    before = (metadata.st_size, metadata.st_mtime_ns)
                    sha = digest(path)
                    after = path.stat()
                    if before != (after.st_size, after.st_mtime_ns):
                        raise ValueError('File changed while inventory was being created')
                    item = {'type': 'file', 'bytes': metadata.st_size, 'sha256': sha}
                else:
                    raise ValueError('Unsupported special file in migration inventory')
                destination = str(target / relative)
                if destination in destinations:
                    raise ValueError('Duplicate migration target')
                destinations.add(destination)
                files.append({**item, 'source': str(path), 'target': destination, 'category': entry['category'], 'action': entry['action'], 'mode': stat.S_IMODE(metadata.st_mode), 'uid': getattr(metadata, 'st_uid', None), 'gid': getattr(metadata, 'st_gid', None)})
    result = {'version': 1, 'created': datetime.now(timezone.utc).isoformat(), 'files': sorted(files, key=lambda item: item['target'])}
    out = Path(output)
    if out.exists():
        raise ValueError('Refusing to overwrite an existing inventory')
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'files': len(files), 'bytes': sum(item.get('bytes', 0) for item in files)}))


def verify(manifest_file, restore_root):
    manifest = json.loads(Path(manifest_file).read_text(encoding='utf-8'))
    if manifest.get('version') != 1 or not isinstance(manifest.get('files'), list):
        raise ValueError('Invalid manifest')
    root = Path(restore_root).resolve(strict=True)
    failures = []
    seen = set()
    for item in manifest['files']:
        target = target_path(item['target'])
        if str(target) in seen:
            raise ValueError('Duplicate migration target')
        seen.add(str(target))
        path = root.joinpath(*target.parts[1:])
        try:
            if not path.resolve(strict=not (item['type'] == 'symlink' and item.get('dangling', False))).is_relative_to(root):
                raise ValueError('Restoration escapes declared root')
            if item['type'] == 'symlink':
                valid = path.is_symlink() and os.readlink(path) == item['link']
            else:
                valid = not path.is_symlink() and path.is_file() and path.stat().st_size == item['bytes'] and digest(path) == item['sha256']
            if not valid:
                failures.append(item['target'])
        except (OSError, ValueError):
            failures.append(item['target'])
    print(json.dumps({'files': len(manifest['files']), 'mismatches': len(failures), 'paths': failures}, ensure_ascii=False))
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    capture = commands.add_parser('scan')
    capture.add_argument('--policy', required=True)
    capture.add_argument('--output', required=True)
    check = commands.add_parser('verify')
    check.add_argument('--manifest', required=True)
    check.add_argument('--root', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'scan':
            scan(args.policy, args.output)
            return 0
        return verify(args.manifest, args.root)
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
