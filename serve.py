#!/usr/bin/env python3
"""SEG-Y Studio — tiny local server.

Serves the viewer and gives the browser read access to SEG-Y files on mounted
drives (e.g. the Z: survey archive) with HTTP Range support.

    python serve.py [--port 8765] [--root "Z:\\06.GHO\\..."] [--no-browser]

Stdlib only. Binds to 127.0.0.1 by default.
"""
import argparse
import json
import mimetypes
import os
import re
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

BASE = os.path.dirname(os.path.abspath(__file__))
SEGY_EXT = (".sgy", ".segy")
DEFAULT_ROOT = r"Z:\06.GHO\06.Report Registration\2026\Site Survey"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

STATE = {"root": DEFAULT_ROOT}


def human(n):
    return f"{n / 1048576:.1f} MB"


class Handler(BaseHTTPRequestHandler):
    server_version = "SegyStudio/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith("GET /api"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------------------------------------------------------------- helpers
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text, status=400):
        body = text.encode("utf-8", "replace")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def safe_static(self, rel):
        p = os.path.normpath(os.path.join(BASE, rel.lstrip("/\\")))
        if not p.startswith(BASE + os.sep) and p != BASE:
            return None
        return p if os.path.isfile(p) else None

    # ---------------------------------------------------------------- routes
    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = parse_qs(parsed.query)

        if path == "/api/ping":
            root = STATE["root"]
            return self.send_json({
                "ok": True,
                "root": root,
                "rootExists": os.path.isdir(root),
                "sep": os.sep,
            })

        if path == "/api/list":
            target = (qs.get("path") or [STATE["root"]])[0]
            return self.api_list(target)

        if path == "/api/file":
            target = (qs.get("path") or [""])[0]
            return self.api_file(target)

        if path in ("/", "/index.html"):
            return self.static_file("index.html")

        return self.static_file(path.lstrip("/"))

    def api_list(self, target):
        try:
            target = os.path.abspath(target)
            if not os.path.isdir(target):
                return self.send_text("Not a folder: " + target, 404)
            dirs, files = [], []
            with os.scandir(target) as it:
                for e in it:
                    try:
                        if e.is_dir():
                            dirs.append(e.name)
                        elif e.name.lower().endswith(SEGY_EXT):
                            st = e.stat()
                            files.append({
                                "name": e.name,
                                "path": e.path,
                                "size": st.st_size,
                                "mtime": int(st.st_mtime),
                            })
                    except OSError:
                        continue
            dirs.sort(key=str.lower)
            files.sort(key=lambda f: f["name"].lower())
            parent = os.path.dirname(target.rstrip("\\/"))
            if not parent or parent == target:
                parent = None
            self.send_json({
                "path": target,
                "parent": parent,
                "dirs": [{"name": d, "path": os.path.join(target, d)} for d in dirs],
                "files": files,
            })
        except OSError as e:
            self.send_text("Cannot list folder: %s" % e, 500)

    def api_file(self, target):
        try:
            target = os.path.abspath(target)
            if not os.path.isfile(target):
                return self.send_text("Not a file: " + target, 404)
            size = os.path.getsize(target)
            ctype = MIME.get(os.path.splitext(target)[1].lower(), "application/octet-stream")

            start, end = 0, size - 1
            status = 200
            rng = self.headers.get("Range")
            if rng:
                m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
                if m:
                    if m.group(1):
                        start = int(m.group(1))
                    if m.group(2):
                        end = int(m.group(2))
                    if start >= size:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return
                    end = min(end, size - 1)
                    status = 206

            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()

            with open(target, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (OSError, BrokenPipeError) as e:
            try:
                self.send_text("Read failed: %s" % e, 500)
            except Exception:
                pass

    def static_file(self, rel):
        p = self.safe_static(rel)
        if not p:
            return self.send_text("Not found", 404)
        try:
            with open(p, "rb") as f:
                body = f.read()
        except OSError as e:
            return self.send_text("Read failed: %s" % e, 500)
        ext = os.path.splitext(p)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, mimetypes.guess_type(p)[0] or "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser(description="SEG-Y Studio local server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--root", default=DEFAULT_ROOT, help="initial browse folder")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    STATE["root"] = os.path.abspath(args.root) if args.root else DEFAULT_ROOT

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    url = f"http://{args.host}:{args.port}/"
    print("SEG-Y Studio")
    print("  serving :", BASE)
    print("  browse  :", STATE["root"], "(exists)" if os.path.isdir(STATE["root"]) else "(missing)")
    print("  open    :", url)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
