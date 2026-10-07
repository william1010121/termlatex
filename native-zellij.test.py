"""Browser-free formula transport through a real isolated Zellij PTY.

Run with python3 native-zellij.test.py. Its socket/config/data directories are
temporary; it never attaches to or modifies existing user sessions.
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
TRANSPARENT = (0, 0, 0, 0)


def png():
    width, height = 100, 300
    raw = b''.join(b'\0' + bytes(COLORS[y // 100]) * width for y in range(height))
    def chunk(name, data):
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def check():
    with tempfile.TemporaryDirectory(prefix='vlnz-', dir='/tmp') as directory:
        d = Path(directory)
        (d / 'image.png').write_bytes(png())
        (d / 'config.kdl').write_text('pane_frames false\nshow_release_notes false\nshow_startup_tips false\n')
        module = json.dumps(str(ROOT / 'packages/terminal-math/terminal.js'))
        image = json.dumps(str(d / 'image.png'))
        ready, stats = json.dumps(str(d / 'ready')), json.dumps(str(d / 'stats.json'))
        command_file = json.dumps(str(d / 'command.json'))
        (d / 'app.mjs').write_text(f'''
import fs from 'node:fs/promises';
import {{ createTerminalGraphics }} from {module};
process.stdin.setRawMode(true); process.stdin.resume();
const sender = createTerminalGraphics(process.stdout, {{ startId: 100 }});
const formula = {{ key: 'stripes', width: 100, height: 300, baseline: 100, png: await fs.readFile({image}) }};
// Zellij starts panes before asynchronously receiving host capabilities. Wait
// for a pane-local positive Kitty reply and actual pixel metrics, not a delay.
let replies = '';
const onReply = data => {{ replies = (replies + data.toString()).slice(-4096); }};
process.stdin.on('data', onReply);
let capable = false;
for (let attempt = 0; attempt < 200; attempt++) {{
  process.stdout.write('\\x1b_Ga=q,t=d,f=24,s=1,v=1,i=99;AAAA\\x1b\\\\\\x1b[16t');
  await new Promise(resolve => setTimeout(resolve, 25));
  if (replies.includes('i=99;OK\\x1b\\\\') && replies.includes('\\x1b[6;20;10t')) {{ capable = true; break; }}
}}
process.stdin.off('data', onReply);
if (!capable) throw new Error('Zellij did not finish graphics/pixel capability negotiation: ' + JSON.stringify(replies));
let work = Promise.resolve(), lastCommand = 0;
async function dispatch(key) {{
    if (key === 'q') {{ await sender.dispose(); process.exit(); }}
    if (!'abcd'.includes(key)) return;
    const xPx = key === 'd' ? -7 : 3;
    const yPx = key === 'd' ? -95 : -'abc'.indexOf(key) * 100;
    await sender.present([{{ formula, xPx, yPx }}], {{
      before: '\\x1b[H', cellWidth: 10, cellHeight: 20, viewportCols: 20, viewportRows: 5, refreshCrops: true,
    }});
    const temporary = {stats} + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(sender.stats()));
    await fs.rename(temporary, {stats});
}}
// This is a graphics integration test, not an input-routing test. Zellij may
// briefly consume startup keyboard input before the client becomes attached.
// A private atomic command file removes that race without bypassing rendering.
setInterval(() => {{
  work = work.then(async () => {{
    let command;
    try {{ command = JSON.parse(await fs.readFile({command_file}, 'utf8')); }}
    catch (error) {{ if (error.code === 'ENOENT') return; throw error; }}
    if (command.sequence <= lastCommand) return;
    lastCommand = command.sequence;
    await dispatch(command.key);
  }}).catch(error => {{ console.error(error); process.exit(1); }});
}}, 10);
await fs.writeFile({ready}, 'ready');
''')
        (d / 'layout.kdl').write_text(f'layout {{\n pane command="node" {{\n args "{d / "app.mjs"}"\n }}\n}}\n')
        env = {key: value for key, value in os.environ.items() if not key.startswith('ZELLIJ')}
        env.update(TERM='xterm-256color', ZELLIJ_SOCKET_DIR=str(d / 's'))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 800, 480))
        process = subprocess.Popen(
            ['zellij', '-s', 'native-probe', '-c', str(d / 'config.kdl'), '--data-dir', str(d / 'data'), '-n', str(d / 'layout.kdl')],
            stdin=slave, stdout=slave, stderr=slave, env=env,
            preexec_fn=lambda: (os.setsid(), fcntl.ioctl(0, termios.TIOCSCTTY, 0)),
        )
        os.close(slave)
        buffer, diagnostics, images, placements, pending = b'', bytearray(), {}, [], None
        queries = []
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
                (b'\x1b[?2026$p', b'\x1b[?2026;1$y'),
            ]:
                if query in data:
                    queries.append(query)
                    os.write(master, answer)
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
                if action == b'q':
                    queries.append(b'kitty-query')
                    os.write(master, b'\x1b_Gi=' + c.get(b'i', b'31') + b';OK\x1b\\')
                elif action == b't': pending = [c, bytearray(base64.b64decode(payload))]
                elif action is None and pending: pending[1].extend(base64.b64decode(payload))
                if pending and c.get(b'm', b'0') == b'0':
                    header, pixels = pending
                    assert header[b'f'] == b'32', 'expected Zellij RGBA output'
                    if header.get(b'o') == b'z': pixels = zlib.decompress(pixels)
                    width, height = int(header[b's']), int(header[b'v'])
                    assert len(pixels) == width * height * 4
                    images[int(header[b'i'])] = (width, height, bytes(pixels)); pending = None
                if action == b'p':
                    width, height, pixels = images[int(c[b'i'])]
                    x, y = int(c.get(b'x', b'0')), int(c.get(b'y', b'0'))
                    placements.append((width, height, pixels, x, y))
            # Primary DA ends Zellij's startup capability detection. Kitty's
            # query precedes DA on the wire, so its OK must also precede DA.
            # Reversing replies races graphics discovery and disables images.
            if b'\x1b[c' in data:
                queries.append(b'\x1b[c')
                os.write(master, b'\x1b[?1;2c')
        def until(predicate, seconds=5):
            deadline = time.monotonic() + seconds
            while not predicate() and time.monotonic() < deadline: poll()
            state = (d / 'stats.json').read_text() if (d / 'stats.json').exists() else 'no application frame'
            assert predicate(), f'Zellij did not refresh: placements={len(placements)}, stats={state}, queries={queries}, tail={bytes(diagnostics[-500:])!r}'
        sequence = 0
        def send(key):
            nonlocal sequence
            sequence += 1
            temporary = d / 'command.tmp'
            temporary.write_text(json.dumps({'sequence': sequence, 'key': key}))
            temporary.replace(d / 'command.json')
        def pixel(frame, x, y):
            width, height, pixels, src_x, src_y = frame
            offset = ((src_y + y) * width + src_x + x) * 4
            return tuple(pixels[offset:offset + 4])
        try:
            until(lambda: (d / 'ready').exists(), 10)
            for key, color in zip(b'abca', [*COLORS, COLORS[0]]):
                before = len(placements)
                send(chr(key))
                until(lambda: len(placements) > before and pixel(placements[-1], 3, 0) == color)
                frame = placements[-1]
                assert frame[:2] == (110, 100), f'Unexpected scaling: {frame[:2]}'
                assert pixel(frame, 2, 0) == TRANSPARENT, 'left inline padding is not transparent'
                assert pixel(frame, 3, 99) == color, 'crop is scaled or stale near bottom'
                assert pixel(frame, 102, 99) == color
                assert pixel(frame, 103, 99) == TRANSPARENT, 'right inline padding is not transparent'
            until(lambda: (d / 'stats.json').exists() and json.loads((d / 'stats.json').read_text())['frames'] == 4)
            counters = json.loads((d / 'stats.json').read_text())
            assert counters['uploads'] == 3, f'Warm reverse crop uploaded again: {counters}'
            print('PASS: real Zellij browser-free native formula crops red → green → blue → red, warm reverse reuses texture', flush=True)
            before = len(placements)
            send('d')
            until(lambda: len(placements) > before and pixel(placements[-1], 0, 0) == COLORS[0] and pixel(placements[-1], 0, 5) == COLORS[1])
            frame = placements[-1]
            assert frame[:2] == (100, 100)
            assert pixel(frame, 92, 4) == COLORS[0]
            assert pixel(frame, 92, 5) == COLORS[1]
            assert pixel(frame, 92, 99) == COLORS[1]
            assert pixel(frame, 93, 0) == TRANSPARENT
            assert pixel(frame, 93, 99) == TRANSPARENT
            print('PASS: real Zellij simultaneous left/top clipping preserves 1:1 pixels and transparent neighboring cells', flush=True)
        finally:
            send('q')
            deadline = time.monotonic() + .3
            while time.monotonic() < deadline: poll()
            os.close(master)
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=3)
            subprocess.run(['zellij', 'kill-session', 'native-probe'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)


if __name__ == '__main__':
    if not shutil.which('zellij'): raise SystemExit('Install Zellij 0.45.1+ to run this integration test.')
    check()
