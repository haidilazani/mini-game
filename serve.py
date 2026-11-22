"""Dev server for the Mini Game site.

Same as `python -m http.server`, but tells the browser never to cache,
so edits always show up on a plain refresh.

Usage:  python serve.py  ->  http://localhost:8000/
"""
import http.server
import os

PORT = 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler) as httpd:
        print(f"Serving Mini Game at http://localhost:{PORT}/  (Ctrl+C to stop)")
        httpd.serve_forever()
