"""Browser-free CLI integration against a PTY that answers Kitty capability queries."""
import base64
import fcntl
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import zlib

ROOT = pathlib.Path(__file__).resolve().parent


def png_size(png):
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", png[16:24])
    assert width > 0 and height > 0
    offset = 8
    compressed = bytearray()
    while offset < len(png):
        size = struct.unpack(">I", png[offset:offset + 4])[0]
        kind = png[offset + 4:offset + 8]
        data = png[offset + 8:offset + 8 + size]
        crc = struct.unpack(">I", png[offset + 8 + size:offset + 12 + size])[0]
        assert zlib.crc32(kind + data) & 0xffffffff == crc, "PNG transfer CRC mismatch"
        if kind == b"IDAT":
            compressed.extend(data)
        offset += size + 12
    assert zlib.decompress(compressed), "PNG must contain a complete raster"
    return width, height


def uploaded_pngs(frame):
    result, pending = [], None
    for control, data in re.findall(rb"\x1b_G([^;]*);([^\x1b]*)\x1b\\", frame):
        if b"a=t," in control:
            pending = bytearray()
        if pending is not None and (b"a=t," in control or control.startswith(b"m=")):
            pending.extend(data)
            if control.endswith(b"m=0"):
                result.append(base64.b64decode(pending, validate=True))
                pending = None
    return result


def run(zellij=False):
    with tempfile.TemporaryDirectory(prefix="native-terminal-test-") as directory:
        directory = pathlib.Path(directory)
        document = directory / "document.md"
        document.write_text(
            "左邊 $\\dfrac{\\dfrac{a}{b}}{c}$ 中間 $x^2$ 右邊。\n\n"
            + "原生中文段落 $x^2$ 結尾。\n\n" * 40
        )
        guard = directory / "guard.mjs"
        guard.write_text("""import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
for (const name of ['spawn','spawnSync','execFile','execFileSync']) {
  const original = child[name];
  child[name] = function(command, ...args) {
    if (/(chrome|chromium|headless_shell|latex|tectonic|cargo|rustc)/i.test(String(command)))
      throw new Error('Native CLI attempted external rendering: ' + command);
    return original.call(this, command, ...args);
  };
}
syncBuiltinESMExports();
""")
        editor = directory / "editor.sh"
        editor.write_text("#!/bin/sh\nprintf '# Edited\\n\\n原生文字 $z$\\n' > \"$1\"\n")
        editor.chmod(0o755)
        environment = {key: value for key, value in os.environ.items() if not key.startswith("ZELLIJ")}
        environment.update({"NODE_OPTIONS": f"--import={guard}", "VISUAL": str(editor),
                            "PUPPETEER_EXECUTABLE_PATH": "/nonexistent/native-cli-must-not-use-chrome"})
        if zellij:
            environment["ZELLIJ"] = "0"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 90, 900, 400))
        process = subprocess.Popen([shutil.which("node"), str(ROOT / "cli.js"), str(document), "--font-size", "24"],
                                   stdin=slave, stdout=slave, stderr=slave, env=environment, start_new_session=True)
        os.close(slave)
        def frame(key=None, expected=b"", timeout=10):
            if key is not None:
                os.write(master, key)
            output = bytearray()
            answered_probes = 0
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if not select.select([master], [], [], .1)[0]:
                    if process.poll() is not None:
                        break
                    continue
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
                probes = output.count(b"i=31;AAAA")
                while answered_probes < probes:
                    os.write(master, b"\x1b[6;20;10t\x1b[4;400;900t\x1b]10;rgb:dddd/eeee/ffff\x1b\\\x1b_Gi=31;OK\x1b\\")
                    answered_probes += 1
                footers = re.findall(rb"\x1b\[7m([^\x1b]*)\x1b\[0m", output)
                if footers and expected in footers[-1] and output.endswith(b"\x1b[?2026l"):
                    return bytes(output)
            raise AssertionError(f"No native frame {key!r}/{expected!r}: {bytes(output[-500:])!r}")

        try:
            initial = frame(expected=b"native")
            assert "左邊".encode() in initial and "右邊".encode() in initial, "body prose must remain terminal text"
            assert b"\\dfrac" not in initial, "rendered formula source must not leak into native prose"
            images = uploaded_pngs(initial)
            assert len(images) == 2, "only two unique formulas should upload"
            original_sizes = [png_size(image) for image in images]
            assert all(width < 150 and height < 150 for width, height in original_sizes), "only formulas, not entire pages, are rasterized"
            scrolled = frame(b"j", b"native")
            if not zellij:
                assert not uploaded_pngs(scrolled), "warm scroll must reuse original textures"
                assert any(int(value) > 0 for value in re.findall(rb"a=p,[^;]*,y=(\d+)", scrolled)), "top clipping must update formula source offset"
            else:
                assert all(png_size(image)[0] % 10 == 0 and png_size(image)[1] % 20 == 0 for image in uploaded_pngs(scrolled))
            frame(b"g", b"0%")
            unchanged = frame(b"r", b"unchanged")
            assert not uploaded_pngs(unchanged), "unchanged reload must preserve texture cache"
            # Graphics acknowledgements may be split across stdin reads. Their
            # payload must never be interpreted as shortcuts such as q or r.
            os.write(master, b"\x1b_Gi=999;q")
            time.sleep(.02)
            os.write(master, b"reload\x1b\\")
            assert process.poll() is None
            frame(b"j", b"native")
            # A wheel packet split in the middle remains one event, and a
            # burst contributes all its scroll steps while sharing textures.
            wheel = b"\x1b[<65;10;10M"
            os.write(master, wheel[:7])
            time.sleep(.01)
            frame(wheel[7:] + wheel * 7, b"native")
            frame(b"g", b"0%")
            zoomed = frame(b"=", b"108%")
            assert uploaded_pngs(zoomed), "formula zoom must change pixels"
            frame(b"=" * 10, b"192%")
            frame(b"-" * 10, b"108%")
            source = frame(b"s", b"source")
            assert b"\\dfrac" in source, "source mode must expose selectable original TeX"
            assert not uploaded_pngs(source)
            frame(b"s", b"native")
            document.write_text("# Reloaded\n\n變更後的原生文字 $y^3$。\n")
            reloaded = frame(b"r", b"reloaded")
            assert "變更後".encode() in reloaded and uploaded_pngs(reloaded)
            edited = frame(b"e", b"reloaded after editor")
            assert document.read_text().startswith("# Edited") and b"Edited" in edited
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 16, 70, 700, 320))
            process.send_signal(signal.SIGWINCH)
            frame(expected=b"native")
            os.write(master, b"q")
            deadline = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    try:
                        os.read(master, 65536)
                    except OSError:
                        break
            process.wait(timeout=5)
            assert process.returncode == 0
            if not zellij:
                sizes = []
                for scale in (1, 2):
                    exported = directory / f"export-{scale}.png"
                    result = subprocess.run([shutil.which("node"), str(ROOT / "cli.js"), str(document),
                                             "--render", str(exported), "--raster-scale", str(scale)],
                                            env=environment, capture_output=True, timeout=15, check=True)
                    assert b"Rendered" in result.stdout
                    sizes.append(png_size(exported.read_bytes()))
                assert sizes[1] == tuple(value * 2 for value in sizes[0]), "2x export must double both raster dimensions"
            print(f"PASS ({'Zellij transport mode' if zellij else 'direct Kitty'}): native CJK prose, real formula PNGs, clipping, warm cache, zoom, source, reload, editor, resize, quit; no browser/Rust/TeX process")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            os.close(master)


if __name__ == "__main__":
    run()
    run(zellij=True)
