"""Independent Kitty protocol + pixel verifier. Run with python3 verification.test.py.

Uses only the standard library; the PTY emulator reconstructs each image rather
than concatenating transfers, and checks every placement against retained data.
"""
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
import zlib

ROOT = pathlib.Path(__file__).resolve().parent
ESC = b"\x1b"


def decode_png(png):
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    offset, compressed = 8, bytearray()
    width = height = kind = None
    while offset < len(png):
        length = struct.unpack_from(">I", png, offset)[0]
        name = png[offset + 4:offset + 8]
        data = png[offset + 8:offset + 8 + length]
        if name == b"IHDR":
            width, height, depth, kind, compression, filtering, interlace = struct.unpack(">IIBBBBB", data)
            assert depth == 8 and kind in (2, 6) and not interlace
        elif name == b"IDAT":
            compressed.extend(data)
        offset += length + 12
    channels = 4 if kind == 6 else 3
    stride = width * channels
    raw, result, previous = zlib.decompress(compressed), bytearray(), bytearray(stride)
    assert len(raw) == (stride + 1) * height
    for y in range(height):
        start = y * (stride + 1)
        method, row = raw[start], bytearray(raw[start + 1:start + stride + 1])
        assert method in range(5)
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            above = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if method == 1:
                predictor = left
            elif method == 2:
                predictor = above
            elif method == 3:
                predictor = (left + above) // 2
            elif method == 4:
                p = left + above - corner
                distances = (abs(p - left), abs(p - above), abs(p - corner))
                predictor = (left, above, corner)[distances.index(min(distances))]
            else:
                predictor = 0
            row[x] = (row[x] + predictor) & 255
        result.extend(row)
        previous = row
    if channels == 3:
        result = bytearray(v for i in range(0, len(result), 3) for v in (*result[i:i + 3], 255))
    return width, height, bytes(result)


class Terminal:
    def __init__(self, document, editor=None, supported=True, rows=30, columns=90, file_mode="ok", query_mode="normal"):
        self.master, slave = pty.openpty()
        self.resize(rows, columns, fd=slave)
        raster_args = ["--raster-scale", os.environ["VERIFY_RASTER_SCALE"]] if "VERIFY_RASTER_SCALE" in os.environ else []
        self.process = subprocess.Popen(
            ["node", str(ROOT / "browser-cli.js"), str(document), *raster_args], stdin=slave, stdout=slave,
            stderr=slave, env={**{key: value for key, value in os.environ.items() if not key.startswith("ZELLIJ")}, **({"VISUAL": str(editor)} if editor else {})},
            start_new_session=True,
        )
        os.close(slave)
        self.supported = supported
        self.query_mode = query_mode
        self.file_mode = file_mode
        self.file_uploads = self.direct_uploads = self.file_probes = 0
        self.file_paths = []
        self.responded = False
        self.raw = bytearray()
        self.graphics_buffer = b""
        self.footer_buffer = b""
        self.footers = []
        self.images = {}
        self.placements = {}
        self.pending = None
        self.last_crop = None
        self.upload_count = 0
        self.placement_count = 0
        self.protocol_errors = []

    def resize(self, rows, columns, fd=None):
        fcntl.ioctl(self.master if fd is None else fd, termios.TIOCSWINSZ,
                    struct.pack("HHHH", rows, columns, columns * 10, rows * 20))
        if fd is None:
            self.process.send_signal(signal.SIGWINCH)

    def send(self, data):
        os.write(self.master, data)

    def packet(self, packet):
        header, data = packet.split(b";", 1)
        controls = dict(item.split(b"=", 1) for item in header.split(b",") if b"=" in item)
        action = controls.get(b"a")
        if action == b"q":
            reply = b"OK" if self.supported else b"ENOTSUP"
            if controls.get(b"t") == b"f":
                self.file_probes += 1
                filename = pathlib.Path(os.fsdecode(base64.b64decode(data)))
                self.file_paths.append(filename)
                assert filename.read_bytes() == b"\x00" * 3
                if self.file_mode == "reject":
                    reply = b"ENOTSUP"
                elif self.file_mode == "silent":
                    return
            self.send(b"\x1b_Gi=" + controls[b"i"] + b";" + reply + b"\x1b\\")
            return
        if self.pending and action is not None:
            raise AssertionError("graphics control interleaved with unfinished chunked image transfer")
        if action in (b"t", b"T"):
            image_id = int(controls[b"i"])
            transport = controls.get(b"t", b"d")
            assert transport in (b"d", b"f", b"t"), transport
            if transport == b"d":
                self.direct_uploads += 1
                self.pending = (image_id, bytearray(data), controls)
            else:
                filename = os.fsdecode(base64.b64decode(data))
                self.file_paths.append(pathlib.Path(filename))
                self.file_uploads += 1
                if self.file_mode == "fail_once" and self.file_uploads == 1:
                    self.send(b"\x1b_Gi=" + controls[b"i"] + b";ENOENT: unavailable file\x1b\\")
                    return
                try:
                    png = pathlib.Path(filename).read_bytes()
                except FileNotFoundError:
                    self.send(b"\x1b_Gi=" + controls[b"i"] + b";ENOENT: file read delayed\x1b\\")
                    return
                self.store(image_id, png)
                if controls.get(b"q", b"0") == b"0":
                    self.send(b"\x1b_Gi=" + controls[b"i"] + b";OK\x1b\\")
                return
        elif self.pending and action is None:
            self.pending[1].extend(data)
        elif action == b"p":
            image_id = int(controls[b"i"])
            assert image_id in self.images, "placement refers to unuploaded or evicted image"
            w, h, png = self.images[image_id]
            x, y = int(controls.get(b"x", 0)), int(controls.get(b"y", 0))
            crop_w, crop_h = int(controls.get(b"w", w)), int(controls.get(b"h", h))
            assert 0 <= x and 0 <= y and x + crop_w <= w and y + crop_h <= h, (controls, w, h)
            self.placements[(image_id, int(controls.get(b"p", 0)))] = controls
            self.last_crop = (image_id, x, y, crop_w, crop_h)
            self.placement_count += 1
        elif action == b"d":
            image_id = int(controls.get(b"i", 0))
            mode = controls.get(b"d", b"a")
            if mode in (b"i", b"I"):
                self.placements = {key: value for key, value in self.placements.items() if key[0] != image_id}
                if mode == b"I":
                    self.images.pop(image_id, None)
            else:
                raise AssertionError(f"unhandled delete mode {mode!r}")
        if self.pending and controls.get(b"m", b"0") == b"0":
            image_id, data, initial = self.pending
            self.pending = None
            self.store(image_id, base64.b64decode(data))

    def store(self, image_id, png):
        assert png.startswith(b"\x89PNG"), "image transfer must decode as PNG"
        w, h = struct.unpack_from(">II", png, 16)
        self.images[image_id] = (w, h, png)
        self.upload_count += 1

    def poll(self, timeout=.05):
        if not select.select([self.master], [], [], timeout)[0]:
            return
        try:
            chunk = os.read(self.master, 65536)
        except OSError:
            return
        self.raw.extend(chunk)
        if not self.responded and b"\x1b[16t" in self.raw:
            dimensions = {"normal": b"\x1b[6;20;10t\x1b[4;600;900t", "window": b"\x1b[4;600;900t", "none": b""}[self.query_mode]
            self.send(dimensions + b"\x1b]10;rgb:dddd/eeee/ffff\x1b\\")
            self.responded = True
        self.graphics_buffer += chunk
        while True:
            start = self.graphics_buffer.find(b"\x1b_G")
            if start < 0:
                self.graphics_buffer = self.graphics_buffer[-2:]
                break
            end = self.graphics_buffer.find(b"\x1b\\", start)
            if end < 0:
                self.graphics_buffer = self.graphics_buffer[start:]
                break
            self.packet(self.graphics_buffer[start + 3:end])
            self.graphics_buffer = self.graphics_buffer[end + 2:]
        self.footer_buffer += chunk
        matches = list(re.finditer(rb"\x1b\[7m([^\x1b]*)\x1b\[0m", self.footer_buffer))
        for match in matches:
            self.footers.append(match.group(1))
        if matches:
            self.footer_buffer = self.footer_buffer[matches[-1].end():]
        else:
            self.footer_buffer = self.footer_buffer[-4096:]

    def ready(self, key=None, expected=b"", timeout=10, condition=None, after=None):
        marker = len(self.footers) if after is None else after
        if key is not None:
            self.send(key)
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            self.poll()
            if len(self.footers) > marker and b"rendering" not in self.footers[-1] and expected in self.footers[-1] and self.last_crop and (condition is None or condition(self)):
                return time.monotonic() - start
        raise AssertionError(f"timeout for {key!r}/{expected!r}: {bytes(self.raw[-400:])!r}")

    def settle(self, seconds=.3):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.poll(.02)

    def quit(self):
        self.send(b"q")
        deadline = time.monotonic() + 6
        while self.process.poll() is None and time.monotonic() < deadline:
            self.poll()
        self.process.wait(timeout=2)
        self.settle(.1)
        assert self.process.returncode == 0
        assert not self.pending and not self.images and not self.placements, "quit must free all owned terminal graphics"
        assert b"\x1b[?1049l" in self.raw and b"\x1b[?1006l" in self.raw
        assert all(not file.exists() for file in self.file_paths), "file transport must remove private temporary files"

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait()
        os.close(self.master)


def run():
    with tempfile.TemporaryDirectory(prefix="view-latex-md-verify-") as directory:
        directory = pathlib.Path(directory)
        document = directory / "document.md"
        document.write_text("# 中文 $x^2$\n\n" + "\n\n".join(f"## Section {i}\n\nParagraph {i} $\\frac{{a_i}}{{b_i}}$." for i in range(100)))
        editor = directory / "editor.sh"
        editor.write_text("#!/bin/sh\nif [ -f \"$1.fail\" ]; then exit 9; fi\nprintf '# Edited\\n\\n$y^3$\\n' > \"$1\"\n")
        editor.chmod(0o755)
        reference = directory / "reference.png"
        reference_script = "import {createRenderer} from './render.js'; import fs from 'node:fs/promises'; const r=await createRenderer(); try{for(const scale of [1,2]){const {maxScroll}=await r.load(process.argv[1],{width:900,height:580,foreground:'#ddeeff',scale});await fs.writeFile(process.argv[2]+'.'+scale+'.png',await r.frame(0));await fs.writeFile(process.argv[2]+'.bottom.'+scale+'.png',await r.frame(maxScroll));}}finally{await r.close();}"
        subprocess.run(["node", "--input-type=module", "-e", reference_script, str(document), str(reference)], cwd=ROOT, check=True)
        terminal = Terminal(document, editor=editor)
        try:
            initial_time = terminal.ready(expected=b"zoom 100%")
            # Drain speculative transfers before the intentionally expensive
            # pure-Python PNG decoder pauses the emulator's read loop.
            terminal.settle(.5)
            image_id, x, y, w, h = terminal.last_crop
            tile_w, tile_h, png = terminal.images[image_id]
            scale = tile_w // 900
            assert scale in (1, 2)
            expected_w, expected_h, expected_pixels = decode_png(pathlib.Path(str(reference) + f".{scale}.png").read_bytes())
            decoded_w, decoded_h, pixels = decode_png(png)
            assert (decoded_w, decoded_h) == (tile_w, tile_h)
            assert (x, y, w, h) == (0, 0, expected_w, expected_h)
            crop_pixels = pixels[:expected_w * expected_h * 4]
            differences = [(i, a, b) for i, (a, b) in enumerate(zip(crop_pixels, expected_pixels)) if a != b]
            # Separate Chromium captures can differ at a handful of glyph edge
            # pixels. Geometry/content must agree across >99.99% of channels.
            assert len(differences) <= len(expected_pixels) * .0001, f"initial terminal crop differs at {len(differences)} channels; examples {differences[:12]}"
            terminal.settle(.3)
            # Simulate a terminal evicting the visible image. Return an error
            # bytewise, including every boundary of ESC_G and ESC-backslash.
            # Shortcut letters inside protocol traffic must remain inert.
            old_id = terminal.last_crop[0]
            terminal.images.pop(old_id)
            terminal.placements = {key: value for key, value in terminal.placements.items() if key[0] != old_id}
            before_retry = terminal.upload_count
            before_reply_footer = len(terminal.footers)
            before_document = document.read_text()
            reply = b"\x1b_Gi=" + str(old_id).encode() + b";ENOENT: q e r G\x1b\\"
            for byte in reply:
                terminal.send(bytes([byte]))
                terminal.poll(.01)
                assert terminal.process.poll() is None, "graphics error text must not trigger quit"
            terminal.ready(expected=b"zoom 100%", timeout=2,
                           condition=lambda t: t.upload_count > before_retry, after=before_reply_footer)
            assert document.read_text() == before_document, "graphics reply text must not launch the editor"
            baseline_uploads = terminal.upload_count
            warm_time = terminal.ready(b"\x1b[<65;10;10M" * 8, condition=lambda t: t.last_crop[2] >= round(8 * 18 * 1.65 * scale))
            terminal.settle()
            assert terminal.upload_count == baseline_uploads, "warm scrolling inside the current strip must not retransmit PNG data"
            terminal.ready(b"g", b"0%  zoom")
            terminal.settle(.2)
            before_unchanged = terminal.upload_count
            terminal.ready(b"r", b"reloaded ")
            terminal.settle(.2)
            assert terminal.upload_count == before_unchanged, "unchanged reload must reuse terminal images and transmit zero PNGs"
            cold_time = terminal.ready(b" " * 5)
            terminal.settle(.5)
            assert terminal.upload_count > baseline_uploads, "cold boundary must exercise a new strip"
            terminal.ready(b"G", b"100%  zoom")
            image_id, x, y, w, h = terminal.last_crop
            bottom_w, bottom_h, bottom_pixels = decode_png(terminal.images[image_id][2])
            _, _, expected_bottom = decode_png(pathlib.Path(str(reference) + f".bottom.{scale}.png").read_bytes())
            actual_bottom = bottom_pixels[y * bottom_w * 4:(y + h) * bottom_w * 4]
            assert len(actual_bottom) == len(expected_bottom)
            assert sum(a != b for a, b in zip(actual_bottom, expected_bottom)) <= len(expected_bottom) * .0001, "bottom jump must display the correct document content, beyond a merely valid source rectangle"
            terminal.ready(b"g", b"0%  zoom")
            terminal.send(b"\x1b[<65;10;10M" * 80)
            time.sleep(.02)
            terminal.ready(b"G", b"100%  zoom")
            terminal.ready(b"g", b"0%  zoom")
            terminal.ready(b"===---", b"zoom 100% (18px)", timeout=15)
            terminal.settle(.3)
            terminal.ready(b"r" * 4, b"reloaded ", timeout=15)
            terminal.settle(.5)
            for rows, columns in [(24, 70), (33, 110), (20, 80), (28, 90)]:
                terminal.resize(rows, columns)
                time.sleep(.02)
            terminal.ready(expected=b"zoom 100%", timeout=15,
                           condition=lambda t: t.last_crop[3:] == (900 * scale, 540 * scale))
            terminal.settle(.3)
            old_stat = document.stat()
            document.write_text("# Reloaded $\\sqrt{3}$\n\nDifferent content.\n")
            os.utime(document, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
            terminal.ready(b"r", b"reloaded ")
            _, _, updated_png = terminal.images[terminal.last_crop[0]]
            assert decode_png(updated_png)[2][:expected_w * 200 * 4] != expected_pixels[:expected_w * 200 * 4], "reload must visibly change decoded pixels"
            terminal.ready(b"e", b"reloaded after editor")
            assert document.read_text().startswith("# Edited")
            fail_flag = pathlib.Path(str(document) + ".fail")
            fail_flag.touch()
            terminal.ready(b"e", b"Editor exited with 9")
            fail_flag.unlink()
            terminal.ready(b"r", b"reloaded ")
            document.unlink()
            terminal.ready(b"r", b"ENOENT")
            document.write_text("# Restored $z$\n")
            terminal.ready(b"r", b"reloaded ")
            terminal.quit()
            print(f"PASS: decoded PNG viewport fidelity, atomic uploads, retained placement/crop geometry, warm/cold scrolling, jump during capture, zoom/reload/resize bursts, edit, error recovery and cleanup. startup={initial_time:.3f}s warm={warm_time:.3f}s cold-first-frame={cold_time:.3f}s uploads={terminal.upload_count} placements={terminal.placement_count}")
        finally:
            terminal.close()
        unsupported = Terminal(document, supported=False)
        try:
            deadline = time.monotonic() + 5
            while unsupported.process.poll() is None and time.monotonic() < deadline:
                unsupported.poll()
            unsupported.process.wait(timeout=2)
            unsupported.settle(.1)
            assert unsupported.process.returncode == 1
            assert b"did not acknowledge Kitty" in unsupported.raw
            assert b"\x1b[?1049h" not in unsupported.raw, "unsupported terminal must not enter alternate screen"
            print("PASS: unsupported terminal exits without entering fullscreen")
        finally:
            unsupported.close()
        for mode in ("reject", "silent", "fail_once"):
            fallback = Terminal(document, file_mode=mode)
            try:
                fallback.ready(expected=b"zoom 100%", timeout=5)
                fallback.settle(.2)
                assert fallback.file_probes == 1, "file capability must be probed"
                assert fallback.direct_uploads > 0, f"{mode} file transport must recover via direct upload"
                if mode == "fail_once":
                    assert fallback.file_uploads == 1, "file failure must disable file transport for later uploads"
                fallback.quit()
                print(f"PASS: file transport {mode} falls back to direct upload and cleans files")
            finally:
                fallback.close()
        for mode, size in (("window", (900, 580)), ("none", (810, 522))):
            dimensions = Terminal(document, query_mode=mode)
            try:
                dimensions.ready(expected=b"zoom 100%", timeout=5)
                scale = 2 if os.environ.get("VERIFY_RASTER_SCALE") == "2" else 1
                assert dimensions.last_crop[3:] == tuple(value * scale for value in size)
                dimensions.quit()
                print(f"PASS: terminal {mode} dimension reply uses correct fallback geometry")
            finally:
                dimensions.close()
        document.write_text("# Short\n\n" + "Paragraph $x^2$.\n\n" * 16)
        short = Terminal(document)
        try:
            short.ready(expected=b"zoom 100%")
            short.settle(.3)
            first_id = short.last_crop[0]
            scale = short.last_crop[3] // 900
            initial_count = short.upload_count
            assert initial_count == 1, "a complete short document must not preupload empty neighboring strips"
            _, image_height, _ = short.images[first_id]
            assert 580 * scale < image_height < 1740 * scale, "short scrolling fixture must capture real document height"
            short.ready(b"G", b"100%  zoom")
            short.settle(.2)
            assert short.upload_count == initial_count and short.last_crop[0] == first_id
            short.ready(b"g", b"0%  zoom")
            assert short.upload_count == initial_count
            short.quit()
            print("PASS: short scrolling document uses one real-height image for top and bottom without empty prefetch")
        finally:
            short.close()
        image = directory / "changing-image.svg"
        local_svg = lambda color: f'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="{color}"/></svg>'
        image.write_text(local_svg("red"))
        document.write_text("![asset](changing-image.svg)\n")
        assets = Terminal(document)
        try:
            assets.ready(expected=b"zoom 100%")
            assets.settle(.2)
            asset_scale = assets.last_crop[3] // 900
            image_id = assets.last_crop[0]
            w, h, red_pixels = decode_png(assets.images[image_id][2])
            pixel_offset = (40 * asset_scale * w + 40 * asset_scale) * 4
            assert red_pixels[pixel_offset:pixel_offset + 4] == bytes((255, 0, 0, 255))
            assert h == 580 * asset_scale and assets.upload_count == 1, "one-screen asset document must not capture blank overscan"
            previous_stat = image.stat()
            image.write_text(local_svg("blue"))
            os.utime(image, ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns))
            assets.ready(b"r", b"reloaded ")
            _, _, blue_pixels = decode_png(assets.images[assets.last_crop[0]][2])
            assert blue_pixels[pixel_offset:pixel_offset + 4] == bytes((0, 0, 255, 255)), "unchanged Markdown must reread changed local image content even with unchanged mtime"
            assets.quit()
            print("PASS: unchanged Markdown reload rereads local asset bytes and replaces red pixels with blue")
        finally:
            assets.close()
        interactive_editor = directory / "interactive-editor.sh"
        interactive_editor.write_text("#!/bin/sh\nprintf 'EDITOR-READ-READY\\n'\nIFS= read -r reply\nprintf '# %s\\n' \"$reply\" > \"$1\"\n")
        interactive_editor.chmod(0o755)
        editing = Terminal(document, editor=interactive_editor)
        try:
            editing.ready(expected=b"zoom 100%")
            marker = len(editing.footers)
            editing.send(b"e")
            deadline = time.monotonic() + 5
            while b"EDITOR-READ-READY" not in editing.raw and time.monotonic() < deadline:
                editing.poll()
            assert b"EDITOR-READ-READY" in editing.raw
            editing.send(b"editor queued input\n")
            editing.ready(expected=b"reloaded after editor", after=marker)
            assert document.read_text() == "# editor queued input\n", "editor must own stdin while the reader is suspended"
            editing.quit()
            print("PASS: interactive editor owns stdin and viewer resumes afterward")
        finally:
            editing.close()


if __name__ == "__main__":
    run()
