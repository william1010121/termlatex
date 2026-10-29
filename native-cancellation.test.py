"""Real CLI/PTY cancellation with a deterministic slow, signal-ignorant renderer.

Only the workspace component is wrapped; terminal setup, input, layout, output,
and cleanup run in the actual CLI. Fixtures live in a temporary directory.
"""
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = pathlib.Path(__file__).resolve().parent


def run(mode):
    with tempfile.TemporaryDirectory(prefix='native-cancellation-') as temporary:
        directory = pathlib.Path(temporary)
        log = directory / 'events.jsonl'
        document = directory / 'document.md'
        document.write_text('\n\n'.join(f'paragraph $x_{i}$' for i in range(40)))
        wrapper = directory / 'wrapper.mjs'
        wrapper.write_text('''
import fs from 'node:fs';
import { createFormulaRenderer as realRenderer } from %s;
import { layoutMarkdown as realLayout } from %s;
import { createTerminalGraphics as realGraphics } from %s;
const record = event => fs.appendFileSync(process.env.CANCEL_LOG, JSON.stringify(event)+'\\n');
export function createFormulaRenderer() {
  const real = realRenderer();
  return { close: () => real.close(), async render(tex, options) {
    record({ kind: 'render', tex, fontSize: options.fontSize });
    await new Promise(resolve => setTimeout(resolve, 15));
    // Deliberately ignore abort, including on the wrapped real renderer.
    return real.render('x', { ...options, signal: undefined });
  } };
}
export async function layoutMarkdown(source, options) {
  record({ kind: 'layout', columns: options.columns, fontSize: options.fontSize });
  const result = await realLayout(source, process.env.IGNORE_ABORT ? { ...options, signal: undefined } : options);
  record({ kind: 'complete', columns: options.columns, fontSize: options.fontSize });
  return result;
}
export function createTerminalGraphics(output) {
  const real = realGraphics(output);
  return { ...real, present(placements, options) {
    record({ kind: 'present', footer: options.after });
    return real.present(placements, options);
  } };
}
''' % tuple(json.dumps((ROOT / 'packages/terminal-math' / filename).as_uri()) for filename in ('formula.js', 'layout.js', 'terminal.js')))
        loader = directory / 'loader.mjs'
        loader.write_text('export async function resolve(specifier, context, next) {\n'
                          'if (specifier === "view-latex-md-math") return { url: %s, shortCircuit: true };\n'
                          'return next(specifier, context);\n}\n' % json.dumps(wrapper.as_uri()))
        environment = {key: value for key, value in os.environ.items() if not key.startswith('ZELLIJ')}
        environment['CANCEL_LOG'] = str(log)
        if mode == 'late':
            environment['IGNORE_ABORT'] = '1'
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 90, 900, 400))
        process = subprocess.Popen([shutil.which('node'), '--experimental-loader', str(loader), str(ROOT / 'cli.js'), str(document)],
                                   stdin=slave, stdout=slave, stderr=slave, env=environment, start_new_session=True)
        output = bytearray()
        answered = 0

        def events():
            if not log.exists():
                return []
            return [json.loads(line) for line in log.read_text().splitlines() if line]

        def pump_until(predicate, timeout=10):
            nonlocal answered
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if select.select([master], [], [], .01)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        pass
                    probes = output.count(b'i=31;AAAA')
                    while answered < probes and not mode.endswith('_probe'):
                        os.write(master, b'\x1b[6;20;10t\x1b[4;400;900t\x1b]10;rgb:dddd/eeee/ffff\x1b\\\x1b_Gi=31;OK\x1b\\')
                        answered += 1
                if predicate():
                    return
            raise AssertionError(f'{mode}: timed out; events={events()[-5:]}; output={bytes(output[-300:])!r}')

        try:
            if mode.endswith('_probe'):
                pump_until(lambda: b'i=31;AAAA' in output)
            else:
                pump_until(lambda: any(event['kind'] == 'render' for event in events()))
            start = time.monotonic()
            if mode in ('quit', 'SIGINT', 'SIGTERM') or mode.endswith('_probe'):
                if mode == 'quit':
                    os.write(master, b'q')
                else:
                    process.send_signal(getattr(signal, mode.removesuffix('_probe')))
                pump_until(lambda: process.poll() is not None)
                # Structural bound is stronger than a flaky wall-clock deadline.
                assert len([event for event in events() if event['kind'] == 'render']) < 5
                assert not any(event['kind'] == 'present' for event in events())
            else:
                if mode == 'rapid':
                    os.write(master, b'++')
                    pump_until(lambda: any(event['kind'] == 'render' and event['fontSize'] == 22 for event in events()))
                    os.write(master, b'---++++')  # 22 -> 24: supersede a second generation.
                else:
                    os.write(master, b'++--+++')  # 18 -> 24, supersede one in-flight layout.
                if mode == 'rapid':
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 16, 70, 700, 320))
                    process.send_signal(signal.SIGWINCH)
                pump_until(lambda: any(event['kind'] == 'present' for event in events()))
                recorded = events()
                frames = [event for event in recorded if event['kind'] == 'present']
                assert all('133%' in event['footer'] for event in frames), frames
                completed = [event for event in recorded if event['kind'] == 'complete']
                if mode == 'late':
                    assert completed[0]['fontSize'] == 18, completed  # Obsolete layout really did return.
                else:
                    assert all(event['fontSize'] == 24 for event in completed), completed
                    assert completed[-1]['columns'] == 70
                    initial_calls = [event for event in recorded if event['kind'] == 'render' and event['fontSize'] == 18]
                    assert len(initial_calls) < 5
                os.write(master, b'q')
                pump_until(lambda: process.poll() is not None)
            assert process.wait(timeout=2) == 0
            # Drain bytes emitted immediately before exit, even if poll won the race.
            while select.select([master], [], [], .05)[0]:
                output.extend(os.read(master, 65536))
            for sequence in (() if mode.endswith('_probe') else (b'\x1b[?7h', b'\x1b[?1006l', b'\x1b[?1000l', b'\x1b[?25h', b'\x1b[?1049l')):
                assert sequence in output, sequence
            restored = termios.tcgetattr(slave)
            assert restored[3] & (termios.ICANON | termios.ECHO) == original[3] & (termios.ICANON | termios.ECHO)
            assert b'AbortError' not in output and b'This operation was aborted' not in output
            print(f'PASS {mode}: {time.monotonic() - start:.3f}s after interruption; terminal restored')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    for case in ('rapid', 'late', 'quit', 'SIGINT', 'SIGTERM', 'SIGINT_probe', 'SIGTERM_probe'):
        run(case)
