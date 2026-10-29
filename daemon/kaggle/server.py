# wdash model server for a Kaggle GPU notebook. Pushed by `wdash-daemon kaggle up` (daemon/src/kaggle.ts),
# which fills in CONFIG. Runs Ollama (it speaks the Anthropic Messages API, so Claude Code agents can use it),
# puts a key-checking proxy in front, exposes that through a Cloudflare quick tunnel, and announces the tunnel
# URL on a one-off ntfy.sh topic the daemon polls. Exits when idle so it doesn't burn the weekly GPU quota.
import http.client
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

CONFIG = json.loads(r'''__WDASH_CONFIG__''')
KEY = CONFIG["key"]
TOPIC = CONFIG["topic"]
MODELS = CONFIG["models"]
IDLE_SECONDS = CONFIG["idleMinutes"] * 60
MAX_SECONDS = CONFIG["maxHours"] * 3600
OLLAMA = ("127.0.0.1", 11434)
PROXY_PORT = 8080

started = time.time()
last_used = time.time()
stop = threading.Event()


def announce(state, **extra):
    body = json.dumps({"state": state, "at": int(time.time() * 1000), **extra}).encode()
    print("announce", body.decode(), flush=True)
    try:
        urllib.request.urlopen(urllib.request.Request(f"https://ntfy.sh/{TOPIC}", data=body, method="POST"), timeout=20)
    except Exception as e:
        print("announce failed:", e, flush=True)


def sh(cmd):
    print("$", cmd, flush=True)
    subprocess.run(cmd, shell=True, check=True)


def ollama(method, path, body=None, timeout=3600):
    c = http.client.HTTPConnection(*OLLAMA, timeout=timeout)
    c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json"})
    r = c.getresponse()
    data = r.read()
    if r.status >= 400:
        raise RuntimeError(f"{path}: {r.status} {data[:300]!r}")
    return json.loads(data or b"{}")


class Proxy(http.server.BaseHTTPRequestHandler):
    # HTTP/1.0 so a streamed response can simply end by closing the connection.
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        pass

    def authed(self):
        bearer = self.headers.get("Authorization", "")
        return bearer == f"Bearer {KEY}" or self.headers.get("x-api-key") == KEY

    def reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self):
        global last_used
        if not self.authed():
            return self.reply(401, {"error": "bad key"})
        last_used = time.time()
        if self.path == "/wdash/health":
            return self.reply(200, {"ok": True, "models": MODELS, "uptime": int(time.time() - started)})
        if self.path == "/wdash/stop":
            self.reply(200, {"ok": True})
            stop.set()
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "authorization", "x-api-key", "content-length", "connection")}
        if self.path.startswith("/v1/messages") and body and json.loads(body).get("stream"):
            return self.stream_messages(body, headers)
        c = http.client.HTTPConnection(*OLLAMA, timeout=3600)
        c.request(self.command, self.path, body=body, headers=headers)
        r = c.getresponse()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                self.send_header(k, v)
        self.end_headers()
        while True:
            chunk = r.read1(65536)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()
            last_used = time.time()

    def stream_messages(self, body, headers):
        # Loading a model and reading a long prompt can take minutes before the first token, and Cloudflare drops
        # a request that sends nothing for 100 s. So answer 200 at once and send SSE comments until Ollama starts.
        global last_used
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.flush()
        result = {}
        got = threading.Event()

        def call():
            try:
                c = http.client.HTTPConnection(*OLLAMA, timeout=3600)
                c.request("POST", self.path, body=body, headers=headers)
                result["r"] = c.getresponse()
            except Exception as e:
                result["error"] = str(e)
            got.set()

        threading.Thread(target=call, daemon=True).start()
        while not got.wait(15):
            self.wfile.write(b": waiting for the model\n\n")
            self.wfile.flush()
        r = result.get("r")
        if r is None or r.status >= 400:
            detail = result.get("error") or r.read()[:500].decode(errors="replace")
            err = {"type": "error", "error": {"type": "api_error", "message": f"ollama: {detail}"}}
            self.wfile.write(f"event: error\ndata: {json.dumps(err)}\n\n".encode())
            return
        while True:
            chunk = r.read1(65536)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()
            last_used = time.time()

    do_GET = do_POST = do_HEAD = handle_any


def tunnel():
    sh("curl -fsSL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /tmp/cloudflared")
    p = subprocess.Popen(["/tmp/cloudflared", "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PROXY_PORT}"], stderr=subprocess.PIPE, text=True)
    for line in p.stderr:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m:
            threading.Thread(target=lambda: [None for _ in p.stderr], daemon=True).start()
            return m.group(0)
    raise RuntimeError("cloudflared exited without a URL")


def main():
    announce("booting", models=MODELS)
    # Without a GPU (weekly quota used up, or no T4s free) a 27B model runs at under 1 token/s: fail fast instead.
    if subprocess.run("nvidia-smi -L", shell=True).returncode != 0:
        raise RuntimeError("Kaggle gave this session no GPU (weekly GPU quota used up, or no T4s free)")
    subprocess.run("apt-get -qq update && apt-get -qq install -y zstd", shell=True)
    sh("curl -fsSL https://ollama.com/install.sh | sh")
    env = dict(os.environ, OLLAMA_HOST=f"{OLLAMA[0]}:{OLLAMA[1]}", OLLAMA_CONTEXT_LENGTH=str(CONFIG["contextLength"]), OLLAMA_KEEP_ALIVE="-1")
    subprocess.Popen(["ollama", "serve"], env=env)
    for _ in range(120):
        try:
            ollama("GET", "/api/version", timeout=5)
            break
        except Exception:
            time.sleep(1)
    for m in MODELS:
        announce("pulling", model=m)
        ollama("POST", "/api/pull", {"model": m, "stream": False})
    # Load the first model now so the first agent turn doesn't wait for it.
    ollama("POST", "/api/generate", {"model": MODELS[0], "prompt": "hi", "stream": False, "options": {"num_predict": 1}})

    server = http.server.ThreadingHTTPServer(("127.0.0.1", PROXY_PORT), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = tunnel()
    global last_used
    last_used = time.time()
    announce("ready", url=url, models=MODELS)

    while not stop.wait(30):
        if time.time() - last_used > IDLE_SECONDS:
            announce("stopped", reason="idle")
            return
        if time.time() - started > MAX_SECONDS:
            announce("stopped", reason="time limit")
            return
    announce("stopped", reason="asked to stop")


try:
    main()
except Exception as e:
    announce("failed", error=str(e)[:500])
    raise
