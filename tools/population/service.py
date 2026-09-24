#!/usr/bin/env python3
"""Private HTTP service for persistent local population calculations."""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import multiprocessing
import os
from pathlib import Path
from queue import Queue
import secrets
import sys
from threading import BoundedSemaphore
import time
from typing import Any, Callable

from engine import METHODS, PopulationEngine, validate_shapes
from tile_index import DEFAULT_INDEX_ROOT, DEFAULT_TILE_SIZE


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8001
DEFAULT_ENGINE_WORKERS = 2
DEFAULT_PROCESS_WORKERS = 0
DEFAULT_QUEUE_SIZE = 8
DEFAULT_RETRY_AFTER_SECONDS = 1
DEFAULT_MAX_REQUEST_BYTES = 1_000_000
HEALTH_REQUEST_RESERVE = 1


def read_integer_setting(name: str, default: int, minimum: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer.") from error
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}.")
    return value


@dataclass(frozen=True)
class PopulationServiceConfig:
    raster_source_path: Path
    tile_index_root: Path
    tile_size: int = DEFAULT_TILE_SIZE
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    engine_workers: int = DEFAULT_ENGINE_WORKERS
    process_workers: int = DEFAULT_PROCESS_WORKERS
    queue_size: int = DEFAULT_QUEUE_SIZE
    retry_after_seconds: int = DEFAULT_RETRY_AFTER_SECONDS
    max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES
    auth_token: str | None = None

    @classmethod
    def from_environment(cls) -> PopulationServiceConfig:
        raster_source = os.environ.get("POPULATION_RASTER_PATH")
        if not raster_source:
            raise ValueError("POPULATION_RASTER_PATH is required.")

        port = read_integer_setting("POPULATION_SERVICE_PORT", DEFAULT_PORT, 1)
        if port > 65_535:
            raise ValueError("POPULATION_SERVICE_PORT must be at most 65535.")

        return cls(
            raster_source_path=Path(raster_source),
            tile_index_root=Path(
                os.environ.get("POPULATION_TILE_INDEX_PATH", str(DEFAULT_INDEX_ROOT))
            ),
            tile_size=read_integer_setting(
                "POPULATION_TILE_SIZE", DEFAULT_TILE_SIZE, 1
            ),
            host=os.environ.get("POPULATION_SERVICE_HOST", DEFAULT_HOST),
            port=port,
            engine_workers=read_integer_setting(
                "POPULATION_SERVICE_WORKERS", DEFAULT_ENGINE_WORKERS, 1
            ),
            process_workers=read_integer_setting(
                "POPULATION_SERVICE_PROCESS_WORKERS", DEFAULT_PROCESS_WORKERS, 0
            ),
            queue_size=read_integer_setting(
                "POPULATION_SERVICE_QUEUE_SIZE", DEFAULT_QUEUE_SIZE, 0
            ),
            retry_after_seconds=read_integer_setting(
                "POPULATION_SERVICE_RETRY_AFTER_SECONDS",
                DEFAULT_RETRY_AFTER_SECONDS,
                1,
            ),
            max_request_bytes=read_integer_setting(
                "POPULATION_SERVICE_MAX_REQUEST_BYTES",
                DEFAULT_MAX_REQUEST_BYTES,
                1,
            ),
            auth_token=os.environ.get("POPULATION_SERVICE_AUTH_TOKEN") or None,
        )


class PopulationEnginePool:
    def __init__(self, engines: list[PopulationEngine]) -> None:
        if not engines:
            raise ValueError("At least one population engine is required.")
        self.size = len(engines)
        self._available: Queue[PopulationEngine] = Queue(maxsize=self.size)
        for engine in engines:
            self._available.put(engine)

    def calculate(
        self,
        shapes: list[dict[str, Any]],
        method: str,
    ) -> list[dict[str, Any]]:
        engine = self._available.get()
        try:
            return engine.calculate(shapes, method)
        finally:
            self._available.put(engine)

    def close(self) -> None:
        pass


_PROCESS_ENGINE: PopulationEngine | None = None


def initialize_process_engine(
    raster_source_path: str,
    tile_size: int,
    tile_index_root: str,
    ready: Any,
) -> None:
    global _PROCESS_ENGINE
    _PROCESS_ENGINE = PopulationEngine(
        Path(raster_source_path),
        tile_size,
        Path(tile_index_root),
    )
    ready.put(os.getpid())


def calculate_with_process_engine(
    shapes: list[dict[str, Any]],
    method: str,
) -> list[dict[str, Any]]:
    if _PROCESS_ENGINE is None:
        raise RuntimeError("Population process engine was not initialized.")
    return _PROCESS_ENGINE.calculate(shapes, method)


def process_worker_identity() -> int:
    return os.getpid()


class ProcessPopulationEnginePool:
    def __init__(
        self,
        size: int,
        raster_source_path: Path,
        tile_size: int,
        tile_index_root: Path,
        startup_timeout_seconds: int = 900,
    ) -> None:
        if size <= 0:
            raise ValueError("At least one population process is required.")

        self.size = size
        self._context = multiprocessing.get_context("spawn")
        self._ready = self._context.Queue()
        self._executor = ProcessPoolExecutor(
            max_workers=size,
            mp_context=self._context,
            initializer=initialize_process_engine,
            initargs=(
                str(raster_source_path),
                tile_size,
                str(tile_index_root),
                self._ready,
            ),
        )

        startup_futures = [
            self._executor.submit(process_worker_identity) for _ in range(size)
        ]
        deadline = time.monotonic() + startup_timeout_seconds
        try:
            initialized_pids: set[int] = set()
            while len(initialized_pids) < size:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Population process initialization timed out.")
                initialized_pids.add(self._ready.get(timeout=remaining))
            for future in startup_futures:
                future.result()
        except Exception:
            self.close()
            raise

    def calculate(
        self,
        shapes: list[dict[str, Any]],
        method: str,
    ) -> list[dict[str, Any]]:
        return self._executor.submit(
            calculate_with_process_engine,
            shapes,
            method,
        ).result()

    def close(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)
        self._ready.close()
        self._ready.join_thread()


class ServiceSaturatedError(RuntimeError):
    pass


class PopulationServiceState:
    def __init__(
        self,
        engine_pool: PopulationEnginePool | ProcessPopulationEnginePool | None,
        queue_size: int,
        retry_after_seconds: int,
        max_request_bytes: int,
        auth_token: str | None = None,
    ) -> None:
        self.engine_pool = engine_pool
        self.retry_after_seconds = retry_after_seconds
        self.max_request_bytes = max_request_bytes
        self.auth_token = auth_token
        engine_count = 0 if engine_pool is None else engine_pool.size
        self.capacity = engine_count + queue_size
        self._calculation_slots = BoundedSemaphore(max(1, self.capacity))

    @property
    def ready(self) -> bool:
        return self.engine_pool is not None

    @property
    def engine_count(self) -> int:
        return 0 if self.engine_pool is None else self.engine_pool.size

    def calculate(
        self,
        shapes: list[dict[str, Any]],
        method: str,
    ) -> list[dict[str, Any]]:
        if self.engine_pool is None:
            raise RuntimeError("Population service is not ready.")
        if not self._calculation_slots.acquire(blocking=False):
            raise ServiceSaturatedError("Population service is saturated.")
        try:
            return self.engine_pool.calculate(shapes, method)
        finally:
            self._calculation_slots.release()

    def is_authorized(self, authorization: str | None) -> bool:
        if self.auth_token is None:
            return True
        if authorization is None:
            return False
        return secrets.compare_digest(authorization, f"Bearer {self.auth_token}")

    def close(self) -> None:
        if self.engine_pool is not None:
            self.engine_pool.close()


class PopulationHTTPServer(HTTPServer):
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        state: PopulationServiceState,
    ) -> None:
        self.state = state
        handler_workers = max(1, state.capacity) + HEALTH_REQUEST_RESERVE
        self._request_slots = BoundedSemaphore(handler_workers)
        self._executor = ThreadPoolExecutor(
            max_workers=handler_workers,
            thread_name_prefix="population-http",
        )
        super().__init__(server_address, PopulationRequestHandler)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._request_slots.acquire(blocking=False):
            self._reject_saturated_connection(request)
            return
        try:
            self._executor.submit(self._process_request, request, client_address)
        except Exception:
            self._request_slots.release()
            self.shutdown_request(request)
            raise

    def _process_request(self, request: Any, client_address: Any) -> None:
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)
            self._request_slots.release()

    def _reject_saturated_connection(self, request: Any) -> None:
        body = b'{"error":"Population service is saturated."}'
        response = (
            b"HTTP/1.1 503 Service Unavailable\r\n"
            b"Content-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\n".encode("ascii")
            + f"Retry-After: {self.state.retry_after_seconds}\r\n".encode("ascii")
            + b"Connection: close\r\n\r\n"
            + body
        )
        try:
            request.sendall(response)
        except OSError:
            pass
        finally:
            self.shutdown_request(request)

    def server_close(self) -> None:
        super().server_close()
        self._executor.shutdown(wait=True, cancel_futures=True)
        self.state.close()


class PopulationRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: PopulationHTTPServer

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if self.path == "/ready":
            if self.server.state.ready:
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "status": "ready",
                        "engines": self.server.state.engine_count,
                        "queueCapacity": (
                            self.server.state.capacity
                            - self.server.state.engine_count
                        ),
                    },
                )
            else:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"status": "not_ready"},
                    retry_after=self.server.state.retry_after_seconds,
                )
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})

    def do_POST(self) -> None:
        if self.path != "/v1/calculate":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
            return
        if not self.server.state.is_authorized(self.headers.get("Authorization")):
            self._send_json(
                HTTPStatus.UNAUTHORIZED,
                {"error": "Invalid or missing population service credentials."},
                response_headers={"WWW-Authenticate": "Bearer"},
            )
            return

        try:
            payload = self._read_json_body()
            if not isinstance(payload, dict):
                raise ValueError("Request body must be a JSON object.")
            method = payload.get("method")
            if method not in METHODS:
                raise ValueError('method must be either "fractional" or "center".')
            shapes = validate_shapes(payload.get("shapes"))
        except RequestTooLargeError as error:
            self._send_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                {"error": str(error)},
            )
            return
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        try:
            results = self.server.state.calculate(shapes, method)
        except ServiceSaturatedError as error:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": str(error)},
                retry_after=self.server.state.retry_after_seconds,
            )
            return
        except Exception as error:
            self.log_error("population calculation failed: %s", error)
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "Population calculation failed."},
            )
            return

        self._send_json(HTTPStatus.OK, {"results": results})

    def _read_json_body(self) -> Any:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise ValueError("Content-Length is required.")
        try:
            body_size = int(content_length)
        except ValueError as error:
            raise ValueError("Content-Length must be an integer.") from error
        if body_size < 0:
            raise ValueError("Content-Length must not be negative.")
        if body_size > self.server.state.max_request_bytes:
            raise RequestTooLargeError(
                f"Request body exceeds {self.server.state.max_request_bytes} bytes."
            )
        try:
            return json.loads(self.rfile.read(body_size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Malformed JSON.") from error

    def _send_json(
        self,
        status: HTTPStatus,
        payload: dict[str, Any],
        retry_after: int | None = None,
        response_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        for name, value in (response_headers or {}).items():
            self.send_header(name, value)
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True


class RequestTooLargeError(ValueError):
    pass


def create_population_server(
    config: PopulationServiceConfig,
    engine_factory: Callable[[Path, int, Path], PopulationEngine] = PopulationEngine,
) -> PopulationHTTPServer:
    if config.process_workers:
        engine_pool: PopulationEnginePool | ProcessPopulationEnginePool = (
            ProcessPopulationEnginePool(
                config.process_workers,
                config.raster_source_path,
                config.tile_size,
                config.tile_index_root,
            )
        )
    else:
        engines = [
            engine_factory(
                config.raster_source_path,
                config.tile_size,
                config.tile_index_root,
            )
            for _ in range(config.engine_workers)
        ]
        engine_pool = PopulationEnginePool(engines)

    state = PopulationServiceState(
        engine_pool,
        config.queue_size,
        config.retry_after_seconds,
        config.max_request_bytes,
        config.auth_token,
    )
    return PopulationHTTPServer((config.host, config.port), state)


def configured_execution_description(config: PopulationServiceConfig) -> str:
    if config.process_workers:
        return f"{config.process_workers} process engines"
    return f"{config.engine_workers} threaded engines"


def main() -> int:
    try:
        config = PopulationServiceConfig.from_environment()
        server = create_population_server(config)
    except Exception as error:
        print(f"Population service startup failed: {error}", file=sys.stderr)
        return 1

    host, port = server.server_address[:2]
    print(
        f"Population service ready on http://{host}:{port} "
        f"with {configured_execution_description(config)} "
        f"and queue capacity {config.queue_size}.",
        file=sys.stderr,
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
