#!/usr/bin/env python3
"""In-memory Docker/OCI registry for Liftoff's end-to-end test. Not for real use.

It speaks just enough of the distribution API for `docker login`, `docker push`
and a manifest read-back, and it can ask for credentials the way Harbor does
(Bearer token from a token service) or with plain Basic auth.

Environment:
  REG_USER, REG_PASS   the one account that may sign in
  AUTH_MODE            "bearer" (default, like Harbor) or "basic"
  PUBLIC_URL           address clients use to reach this server, for the token realm
  PORT                 listen port inside the container (default 5000)
"""
import base64
import hashlib
import json
import os
import re
import secrets
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

USER = os.environ.get("REG_USER", "user")
PASS = os.environ.get("REG_PASS", "pass")
MODE = os.environ.get("AUTH_MODE", "bearer")
PUBLIC = os.environ.get("PUBLIC_URL", "http://localhost:5000").rstrip("/")
PORT = int(os.environ.get("PORT", "5000"))

blobs = {}      # digest -> bytes
uploads = {}    # upload id -> bytearray
manifests = {}  # (repository, tag or digest) -> (content type, bytes)
tokens = set()


def sha256(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "liftoff-mock-registry"
    sys_version = ""

    def log_message(self, fmt, *args):  # request line and status only, never headers
        print(fmt % args, flush=True)

    # --- plumbing -----------------------------------------------------------
    def read_body(self):
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            out = bytearray()
            while True:
                size_line = self.rfile.readline()
                if not size_line:
                    break
                size = int(size_line.split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                        pass
                    break
                out += self.rfile.read(size)
                self.rfile.readline()
            return bytes(out)
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def reply(self, status, body=b"", headers=None, content_type="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Docker-Distribution-API-Version", "registry/2.0")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def error(self, status, code, message, headers=None):
        self.reply(status, {"errors": [{"code": code, "message": message}]}, headers)

    def basic_ok(self):
        header = self.headers.get("Authorization") or ""
        if not header.startswith("Basic "):
            return False
        try:
            user, _, password = base64.b64decode(header[6:]).decode().partition(":")
        except Exception:
            return False
        same_user = secrets.compare_digest(user.encode(), USER.encode())
        same_password = secrets.compare_digest(password.encode(), PASS.encode())
        return same_user and same_password

    def authorized(self):
        if MODE == "basic":
            return self.basic_ok()
        header = self.headers.get("Authorization") or ""
        return header.startswith("Bearer ") and header[7:] in tokens

    def challenge(self):
        if MODE == "basic":
            value = 'Basic realm="mock-registry"'
        else:
            value = 'Bearer realm="%s/service/token",service="mock-registry"' % PUBLIC
        self.error(401, "UNAUTHORIZED", "unauthorized: authentication required", {"WWW-Authenticate": value})

    # --- routing ------------------------------------------------------------
    def handle_request(self):
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)
        method = self.command
        body = self.read_body()

        if path == "/service/token" and MODE != "basic":
            if not self.basic_ok():
                return self.error(401, "UNAUTHORIZED", "unauthorized: authentication required")
            token = secrets.token_urlsafe(24)
            tokens.add(token)
            return self.reply(200, {"token": token, "access_token": token, "expires_in": 600})

        if not path.startswith("/v2"):
            return self.error(404, "NOT_FOUND", "not found")
        if not self.authorized():
            return self.challenge()
        if path in ("/v2", "/v2/"):
            return self.reply(200, {})

        match = re.match(r"^/v2/(.+)/blobs/uploads/?$", path)
        if match and method == "POST":
            upload_id = uuid.uuid4().hex
            uploads[upload_id] = bytearray()
            return self.reply(202, b"", {
                "Location": "/v2/%s/blobs/uploads/%s" % (match.group(1), upload_id),
                "Range": "0-0",
                "Docker-Upload-UUID": upload_id,
            })

        match = re.match(r"^/v2/(.+)/blobs/uploads/([0-9a-f]+)$", path)
        if match:
            name, upload_id = match.groups()
            if upload_id not in uploads:
                return self.error(404, "BLOB_UPLOAD_UNKNOWN", "upload not found")
            if method == "PATCH":
                uploads[upload_id] += body
                return self.reply(202, b"", {
                    "Location": "/v2/%s/blobs/uploads/%s" % (name, upload_id),
                    "Range": "0-%d" % max(len(uploads[upload_id]) - 1, 0),
                    "Docker-Upload-UUID": upload_id,
                })
            if method == "PUT":
                data = bytes(uploads.pop(upload_id) + body)
                wanted = (query.get("digest") or [""])[0]
                if sha256(data) != wanted:
                    return self.error(400, "DIGEST_INVALID", "digest does not match the uploaded content")
                blobs[wanted] = data
                return self.reply(201, b"", {
                    "Location": "/v2/%s/blobs/%s" % (name, wanted),
                    "Docker-Content-Digest": wanted,
                })

        match = re.match(r"^/v2/(.+)/blobs/(sha256:[0-9a-f]{64})$", path)
        if match and method in ("GET", "HEAD"):
            digest = match.group(2)
            if digest not in blobs:
                return self.error(404, "BLOB_UNKNOWN", "blob unknown to registry")
            return self.reply(200, blobs[digest], {"Docker-Content-Digest": digest}, "application/octet-stream")

        match = re.match(r"^/v2/(.+)/manifests/([^/]+)$", path)
        if match:
            name, reference = match.groups()
            if method == "PUT":
                digest = sha256(body)
                content_type = self.headers.get("Content-Type") or "application/vnd.docker.distribution.manifest.v2+json"
                manifests[(name, reference)] = (content_type, body)
                manifests[(name, digest)] = (content_type, body)
                return self.reply(201, b"", {
                    "Location": "/v2/%s/manifests/%s" % (name, digest),
                    "Docker-Content-Digest": digest,
                })
            if method in ("GET", "HEAD"):
                found = manifests.get((name, reference))
                if not found:
                    return self.error(404, "MANIFEST_UNKNOWN", "manifest unknown")
                return self.reply(200, found[1], {"Docker-Content-Digest": sha256(found[1])}, found[0])

        match = re.match(r"^/v2/(.+)/tags/list$", path)
        if match and method == "GET":
            name = match.group(1)
            tags = sorted(ref for (repo, ref) in manifests if repo == name and not ref.startswith("sha256:"))
            if not tags:
                return self.error(404, "NAME_UNKNOWN", "repository name not known to registry")
            return self.reply(200, {"name": name, "tags": tags})

        return self.error(404, "NOT_FOUND", "not found")

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = handle_request


if __name__ == "__main__":
    print("mock registry on :%d, auth=%s, public=%s" % (PORT, MODE, PUBLIC), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
