"""Loopback-only CPU motion caption service. Run: python -m motion_service.server"""
from __future__ import annotations
import argparse
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from .preprocessing import MotionInputError
from .runtime import MotionRuntime, ServiceError

MAX_BODY_BYTES = 256 * 1024
ALLOWED_ORIGINS = {'http://127.0.0.1:4173','http://localhost:4173'}


class CaptionServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = 'GhostingMotionCPU/1.0'

    def json_response(self, status: int, value: dict) -> None:
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error_response(self, status: int, code: str, message: str) -> None:
        self.json_response(status, {'error':{'code':code,'message':message}})

    def allowed(self) -> bool:
        port = self.server.server_address[1]
        if self.client_address[0] != '127.0.0.1' or self.headers.get('Host') not in {f'127.0.0.1:{port}',f'localhost:{port}'}:
            self.error_response(403,'HOST_DENIED','Only loopback requests to the configured service host are accepted.')
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin not in ALLOWED_ORIGINS:
            self.error_response(403,'ORIGIN_DENIED','This origin cannot access the local motion model.')
            return False
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.error_response(403,'ORIGIN_DENIED','Cross-site browser requests are not accepted.')
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        if self.path != '/health':
            self.error_response(404,'NOT_FOUND','Endpoint not found.')
            return
        self.json_response(200,self.server.runtime.health())

    def do_POST(self):
        if not self.allowed():
            return
        if self.path != '/caption':
            self.error_response(404,'NOT_FOUND','Endpoint not found.')
            return
        if self.headers.get('Content-Type','').split(';')[0].strip().lower() != 'application/json' or self.headers.get('Transfer-Encoding'):
            self.error_response(415,'INVALID_CONTENT_TYPE','Use a bounded JSON request.')
            return
        try:
            length = int(self.headers.get('Content-Length','0'))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY_BYTES:
            self.error_response(413,'PAYLOAD_TOO_LARGE','Motion input must be between 1 and 262144 bytes.')
            return
        try:
            self.connection.settimeout(15)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete body')
            payload = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite JSON number')))
            result = self.server.runtime.caption(payload)
            self.json_response(200,result)
        except MotionInputError as error:
            self.error_response(400,error.code,str(error))
        except ServiceError as error:
            self.error_response(error.status,error.code,str(error))
        except (ValueError, UnicodeDecodeError):
            self.error_response(400,'INVALID_JSON','Motion input must be valid finite JSON.')
        except (TimeoutError, socket.timeout):
            self.error_response(408,'BODY_TIMEOUT','Reading the motion input timed out.')
        except Exception as error:
            # Keep body data and filesystem paths out of HTTP diagnostics.
            print('Motion caption failed: '+type(error).__name__,flush=True)
            self.error_response(503,'MOTIONGPT_INFERENCE_FAILED','The CPU motion model could not complete this recording. Try a clear, continuous full-body movement.')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--no-warmup',action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    runtime = MotionRuntime()
    server = CaptionServer(('127.0.0.1',args.port),Handler)
    server.runtime = runtime
    if not args.no_warmup:
        threading.Thread(target=runtime.warmup,daemon=True).start()
    print(f'MotionGPT CPU loopback service: http://127.0.0.1:{args.port}',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
