"""Real Linux PTY smoke: render, bracketed paste, submit, resize, palette, clean exit."""
import argparse, fcntl, os, pathlib, pty, select, signal, struct, subprocess, tempfile, termios, time
root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--consumer")
args = parser.parse_args()
run_directory = pathlib.Path(args.consumer) if args.consumer else root
entry = "tui-fixture.ts" if args.consumer else "scripts/tui-fixture.ts"
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
with tempfile.TemporaryDirectory(prefix='efferent-pty-') as workspace:
    process = subprocess.Popen(['bun', entry, workspace], cwd=run_directory, stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color'}, start_new_session=True)
    os.close(slave)
    chunks = []
    def read_until(needle, timeout=15):
        deadline = time.monotonic() + timeout
        data = b''
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try: chunk = os.read(master, 65536)
                except OSError: break
                data += chunk
                chunks.append(chunk)
                if needle in data: return
        raise AssertionError(f'Terminal did not emit {needle!r}: {data[-1500:]!r}')
    try:
        read_until(b'What are we working on?')
        os.write(master, b'\x1b[200~PTY multi\nline\x1b[201~')
        time.sleep(.2)
        os.write(master, b'\r')
        read_until(b'Received:')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        os.write(master, b'\x10')
        read_until(b'Commands')
        os.write(master, b'\x1b')
        time.sleep(.2)
        os.write(master, b'\x03')
        time.sleep(.2)
        os.write(master, b'\x03')
        process.wait(timeout=10)
        assert process.returncode == 0, process.returncode
        artifact = root / '.artifacts/tui-pty.ansi'
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_bytes(b''.join(chunks))
        print('Real PTY paste, submit, resize, palette, and shutdown passed')
    finally:
        if process.poll() is None: process.kill(); process.wait()
        os.close(master)
