"""Real PTY integration check; a small terminal emulator replies to capability queries."""
import base64
import fcntl
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = pathlib.Path(__file__).resolve().parent


def run():
    with tempfile.TemporaryDirectory(prefix="view-latex-md-") as directory:
        directory = pathlib.Path(directory)
        document = directory / "document.md"
        document.write_text("# 中文 $x^2$\n\n" + "Paragraph $\\alpha_i$.\n\n" * 60)
        editor = directory / "editor.sh"
        editor.write_text("#!/bin/sh\nprintf '# Edited\\n\\n$y^3$\\n' > \"$1\"\n")
        editor.chmod(0o755)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 90, 900, 600))
        process = subprocess.Popen(
            ["node", str(ROOT / "cli.js"), str(document)],
            stdin=slave, stdout=slave, stderr=slave,
            env={**os.environ, "VISUAL": str(editor)}, start_new_session=True,
        )
        os.close(slave)

        def frame(key=None, expected=b"", timeout=10, minimum_y=0):
            if key is not None:
                os.write(master, key)
            output = b""
            answered = False
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if not select.select([master], [], [], .1)[0]:
                    continue
                output += os.read(master, 65536)
                if not answered and b"i=31;AAAA" in output:
                    os.write(master, b"\x1b[6;20;10t\x1b[4;600;900t\x1b]10;rgb:dddd/eeee/ffff\x1b\\\x1b_Gi=31;OK\x1b\\")
                    answered = True
                footers = re.findall(rb"\x1b\[7m([^\x1b]*)\x1b\[0m", output)
                crops = re.findall(rb"a=p,[^;]*,y=(\d+)", output)
                if footers and b"rendering" not in footers[-1] and expected in footers[-1] and crops and int(crops[-1]) >= minimum_y:
                    chunks = re.findall(rb"\x1b_G[^;]*;([^\x1b]*)\x1b\\", output)
                    png = base64.b64decode(b"".join(chunk for chunk in chunks if chunk and chunk != b"AAAA"))
                    return footers[-1], png
            raise AssertionError(f"No frame for {key!r}: {output[-300:]!r}")

        try:
            first, first_png = frame(expected=b"zoom 100%")
            assert first_png[1:4] == b"PNG"
            # Eight wheel ticks should all contribute, without re-uploading PNG data.
            wheel = b"\x1b[<65;10;10M"
            _, scroll_png = frame(wheel * 8, minimum_y=475)
            assert scroll_png == b"", "cached scrolling must only send crop commands"
            # Also handle a mouse packet split across reads.
            os.write(master, wheel[:7])
            _, scroll_png = frame(wheel[7:], minimum_y=535)
            assert scroll_png == b""
            frame(b"g", b"0%  zoom")
            zoomed, zoom_png = frame(b"=", b"zoom 111% (20px)")
            assert zoom_png != first_png, "zoom must change pixels"
            frame(b"-", b"zoom 100% (18px)")
            frame(b"G", b"100%  zoom")
            frame(b"g", b"0%  zoom")
            document.write_text("# Reloaded\n\n$\\sqrt{3}$\n")
            reloaded, reload_png = frame(b"r", b"reloaded ")
            assert reload_png != first_png, "reload must show the changed file"
            frame(b"e", b"reloaded after editor")
            assert document.read_text().startswith("# Edited")
            # Resizing must repaint at the new terminal dimensions.
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 25, 80, 800, 500))
            process.send_signal(signal.SIGWINCH)
            frame(expected=b"zoom 100%")
            os.write(master, b"q")
            # Drain the PTY while the final frame and terminal cleanup are flushed.
            deadline = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    try:
                        os.read(master, 65536)
                    except OSError:
                        break
            process.wait(timeout=5)
            assert process.returncode == 0
            print("PASS: cached smooth scrolling, wheel bursts/split packets, zoom, reload, editor, resize, clean quit")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            os.close(master)


if __name__ == "__main__":
    run()
