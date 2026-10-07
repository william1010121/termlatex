"""Real Zellij integration: changing a retained image crop must update host pixels.

Run with python3 zellij.test.py. Uses an isolated socket, config, data directory,
and PTY; does not attach to or modify any existing Zellij session.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
import zlib

ROOT = Path(__file__).resolve().parent
COLORS = [(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255)]


def png(scale):
    width, height = 100 * scale, 300 * scale
    raw = b''.join(b'\0' + bytes(COLORS[y // (100 * scale)]) * width for y in range(height))
    def chunk(name, data):
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def check(scale):
    with tempfile.TemporaryDirectory(prefix='vlz-', dir='/tmp') as directory:
        d = Path(directory)
        (d / 'image.png').write_bytes(png(scale))
        (d / 'config.kdl').write_text('pane_frames false\nshow_release_notes false\nshow_startup_tips false\n')
        module = json.dumps(str(ROOT / 'graphics.js'))
        image = json.dumps(str(d / 'image.png'))
        ready = json.dumps(str(d / 'ready'))
        (d / 'app.mjs').write_text(f'''
import fs from 'node:fs/promises';
import {{createGraphics}} from {module};
process.stdin.setRawMode(true); process.stdin.resume();
const sender = createGraphics(process.stdout, {{input: process.stdin, startId: 100, refreshCrops: true}});
await sender.probeFile();
const id = await sender.ensure({{start: 0, width: {100 * scale}, height: {300 * scale}, cacheLimit: 3, png: await fs.readFile({image})}});
process.stdin.on('data', async data => {{
  for (const key of data.toString()) {{
    if (key === 'q') {{ await sender.clear(); await sender.dispose(); process.exit(); }}
    if (!'abc'.includes(key)) continue;
    await sender.present(id, {{y: 'abc'.indexOf(key) * {100 * scale}, width: {100 * scale}, height: {100 * scale}, columns: 10, rows: 5}});
  }}
}});
await fs.writeFile({ready}, 'ready');
''')
        (d / 'layout.kdl').write_text(f'layout {{\n pane command="node" {{\n args "{d / "app.mjs"}"\n }}\n}}\n')
        env = {key: value for key, value in os.environ.items() if not key.startswith('ZELLIJ')}
        env.update(TERM='xterm-256color', ZELLIJ_SOCKET_DIR=str(d / 's'))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 800, 480))
        process = subprocess.Popen(
            ['zellij', '-s', 'probe', '-c', str(d / 'config.kdl'), '--data-dir', str(d / 'data'), '-n', str(d / 'layout.kdl')],
            stdin=slave, stdout=slave, stderr=slave, env=env,
            preexec_fn=lambda: (os.setsid(), fcntl.ioctl(0, termios.TIOCSCTTY, 0)),
        )
        os.close(slave)
        buffer, diagnostics, images, colors, pending = b'', bytearray(), {}, [], None
        def poll():
            nonlocal buffer, pending
            if not select.select([master], [], [], .02)[0]: return
            try: data = os.read(master, 262144)
            except OSError: return
            diagnostics.extend(data)
            buffer += data
            for query, answer in [
                (b'\x1b[14t', b'\x1b[4;480;800t'), (b'\x1b[16t', b'\x1b[6;20;10t'),
                (b'\x1b]11;?', b'\x1b]11;rgb:1111/1111/1111\x1b\\'),
                (b'\x1b]10;?', b'\x1b]10;rgb:eeee/eeee/eeee\x1b\\'),
                (b'\x1b[?2026$p', b'\x1b[?2026;1$y'), (b'\x1b[c', b'\x1b[?1;2c'),
            ]:
                if query in data: os.write(master, answer)
            while True:
                start = buffer.find(b'\x1b_G')
                if start < 0:
                    buffer = buffer[-2:]; break
                end = buffer.find(b'\x1b\\', start)
                if end < 0:
                    buffer = buffer[start:]; break
                control, _, payload = buffer[start + 3:end].partition(b';')
                buffer = buffer[end + 2:]
                c = dict(value.split(b'=', 1) for value in control.split(b',') if b'=' in value)
                action = c.get(b'a')
                if action == b'q': os.write(master, b'\x1b_Gi=' + c.get(b'i', b'31') + b';OK\x1b\\')
                elif action == b't': pending = [c, bytearray(base64.b64decode(payload))]
                elif action is None and pending: pending[1].extend(base64.b64decode(payload))
                if pending and c.get(b'm', b'0') == b'0':
                    header, pixels = pending
                    assert header[b'f'] == b'32', 'expected Zellij RGBA output'
                    if header.get(b'o') == b'z': pixels = zlib.decompress(pixels)
                    images[int(header[b'i'])] = (int(header[b's']), bytes(pixels)); pending = None
                if action == b'p':
                    width, pixels = images[int(c[b'i'])]
                    offset = (int(c.get(b'y', b'0')) * width + int(c.get(b'x', b'0'))) * 4
                    colors.append(tuple(pixels[offset:offset + 4]))
        def until(predicate, seconds=5):
            deadline = time.monotonic() + seconds
            while not predicate() and time.monotonic() < deadline: poll()
            assert predicate(), f'Zellij did not refresh at scale {scale}: colors={colors}, tail={bytes(diagnostics[-300:])!r}'
        try:
            until(lambda: (d / 'ready').exists(), 10)
            for key, color in zip(b'abca', [*COLORS, COLORS[0]]):
                before = len(colors)
                os.write(master, bytes([key]))
                until(lambda: len(colors) > before and colors[-1] == color)
            print(f'PASS: real Zellij {scale}x forward/reverse crops render red → green → blue → red', flush=True)
        finally:
            try: os.write(master, b'q')
            except OSError: pass
            deadline = time.monotonic() + .3
            while time.monotonic() < deadline: poll()
            # Close the PTY before waiting: macOS can block a terminating terminal
            # process while its master is still open with unread output.
            os.close(master)
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=3)
            subprocess.run(['zellij', 'kill-session', 'probe'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)


if __name__ == '__main__':
    if not shutil.which('zellij'): raise SystemExit('Install Zellij 0.45.1+ to run this integration test.')
    check(1)
    check(2)
