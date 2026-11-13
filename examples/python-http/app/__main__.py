from http.server import BaseHTTPRequestHandler, HTTPServer
from os import environ
from urllib.parse import urlsplit


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path != "/healthz":
            self.send_error(404)
            return

        body = b'{"status":"ok","language":"python"}\n'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(environ.get("PORT", "8080"))
    with HTTPServer(("127.0.0.1", port), HealthHandler) as server:
        server.serve_forever()
