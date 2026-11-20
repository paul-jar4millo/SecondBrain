"""PTY transport for unmodified interactive CLIs. Input is NDJSON, never shell code."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
def shutdown(signum, frame):
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
signal.signal(signal.SIGTERM, shutdown)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
pending = b''
initial = os.environ.get('SB_INITIAL_PROMPT')
wait_remote = os.environ.get('SB_WAIT_REMOTE') == '1'
screen = b''
started = last_output = time.monotonic()
ANSI = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
PROMPT = b'? for shortcuts'
REMOTE = b'antigravity.google.com/r/'
# The hint can change between CLI versions: a quiet program gets its first
# message anyway instead of waiting forever.
PROMPT_DEADLINE = 20
QUIET = 2
def prompt_ready():
    plain = ANSI.sub(b'', screen)
    if wait_remote:
        return plain.rfind(PROMPT) > plain.rfind(REMOTE) >= 0
    if PROMPT in plain:
        return True
    now = time.monotonic()
    return now - started > PROMPT_DEADLINE and now - last_output > QUIET
def send_text(text):
    text = ''.join(c for c in text if ord(c) >= 32 or c in '\n\t')
    os.write(master, b'\x1b[200~' + text.encode() + b'\x1b[201~\r')
def apply_input(value):
    if 'raw' in value:
        os.write(master, value['raw'].encode())
    elif 'cols' in value:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', value['rows'], value['cols'], 0, 0))
        os.killpg(pid, signal.SIGWINCH)
    else:
        send_text(value['texto'])
inputs = [master, 0]
try:
    while True:
        readable, _, _ = select.select(inputs, [], [], 1 if initial else None)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            os.write(1, data)
            last_output = time.monotonic()
            if initial:
                screen = (screen + data)[-32000:]
        if initial and prompt_ready():
            send_text(initial)
            initial = None
        if 0 in readable:
            data = os.read(0, 65536)
            if not data:
                inputs.remove(0)
                continue
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                # A program that just exited or a bad line never kills the session.
                try:
                    apply_input(json.loads(line))
                except (ValueError, KeyError, TypeError, ProcessLookupError, OSError):
                    pass
finally:
    os.close(master)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
