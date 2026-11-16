"""Record administrative backup facts without credentials or log content."""
import argparse
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['success', 'failure', 'restored'])
parser.add_argument('snapshot', nargs='?', default='')
parser.add_argument('--directory', default='/var/lib/secondbrain-ops')
args = parser.parse_args()
if args.action != 'failure' and not re.fullmatch(r'[a-f0-9]{8,64}', args.snapshot):
    parser.error('Invalid snapshot identity')
directory = Path(args.directory).resolve(strict=True)
if not directory.is_dir() or directory == Path(directory.anchor):
    parser.error('Invalid state directory')
target = directory / 'backup-status.json'
try:
    state = json.loads(target.read_text(encoding='utf-8'))
except FileNotFoundError:
    state = {}
if not isinstance(state, dict):
    raise ValueError('Invalid previous backup status')
now = datetime.now(timezone.utc).isoformat()
if args.action == 'success':
    state.update(lastSuccess=now, lastSnapshot=args.snapshot)
    state.pop('lastErrorAt', None)
elif args.action == 'failure':
    state['lastErrorAt'] = now
else:
    state.update(lastRestore=now, restoredSnapshot=args.snapshot)
fd, temporary = tempfile.mkstemp(prefix='.backup-status-', dir=directory)
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(state, stream)
        stream.flush()
        os.fsync(stream.fileno())
    if os.name == 'posix':
        os.chmod(temporary, 0o640)
        os.chown(temporary, directory.stat().st_uid, directory.stat().st_gid)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(json.dumps({'recorded': args.action}))
