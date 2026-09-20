from __future__ import annotations

import http.client
import json
from pathlib import Path
import sys
from threading import Condition, Event, Lock, Thread
import time
import unittest
from typing import Any


POPULATION_TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(POPULATION_TOOLS))

from service import (  # noqa: E402
    PopulationHTTPServer,
    PopulationServiceConfig,
    PopulationServiceState,
    create_population_server,
)


def shape(shape_id: str) -> dict[str, Any]:
    return {
        "id": shape_id,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [12.0, 41.0],
                    [12.1, 41.0],
                    [12.1, 41.1],
                    [12.0, 41.0],
                ]
            ],
        },
    }


class EngineTracker:
    def __init__(self, blocked: bool = False) -> None:
        self.release = Event()
        if not blocked:
            self.release.set()
        self.condition = Condition()
        self.active = 0
        self.max_active = 0
        self.entered = 0
        self.methods: list[str] = []

    def calculate(
        self,
        shapes: list[dict[str, Any]],
        method: str,
    ) -> list[dict[str, Any]]:
        with self.condition:
            self.active += 1
            self.entered += 1
            self.max_active = max(self.max_active, self.active)
            self.methods.append(method)
            self.condition.notify_all()
        try:
            if not self.release.wait(timeout=5):
                raise TimeoutError("Test engine was not released.")
            return [
                {"id": submitted["id"], "population": float(index + 1)}
                for index, submitted in enumerate(shapes)
            ]
        finally:
            with self.condition:
                self.active -= 1
                self.condition.notify_all()

    def wait_for_entered(self, count: int) -> bool:
        deadline = time.monotonic() + 5
        with self.condition:
            while self.entered < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self.condition.wait(remaining)
        return True


class FakeEngine:
    def __init__(self, tracker: EngineTracker) -> None:
        self.tracker = tracker

    def calculate(
        self,
        shapes: list[dict[str, Any]],
        method: str,
    ) -> list[dict[str, Any]]:
        return self.tracker.calculate(shapes, method)


class RunningServer:
    def __init__(self, server: PopulationHTTPServer) -> None:
        self.server = server
        self.thread = Thread(target=server.serve_forever, daemon=True)

    def __enter__(self) -> RunningServer:
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], dict[str, Any]]:
        body = None if payload is None else json.dumps(payload)
        request_headers = dict(headers or {})
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            response_body = json.loads(response.read())
            return response.status, dict(response.getheaders()), response_body
        finally:
            connection.close()


class PopulationServiceTests(unittest.TestCase):
    def create_server(
        self,
        tracker: EngineTracker,
        workers: int = 1,
        queue_size: int = 0,
        retry_after: int = 1,
        auth_token: str | None = None,
    ) -> PopulationHTTPServer:
        config = PopulationServiceConfig(
            raster_source_path=Path("unused-rasters"),
            tile_index_root=Path("unused-index"),
            host="127.0.0.1",
            port=0,
            engine_workers=workers,
            queue_size=queue_size,
            retry_after_seconds=retry_after,
            auth_token=auth_token,
        )
        return create_population_server(
            config,
            engine_factory=lambda *_: FakeEngine(tracker),
        )

    def test_health_and_readiness_report_initialized_engine_pool(self) -> None:
        tracker = EngineTracker()
        with RunningServer(self.create_server(tracker, workers=2, queue_size=3)) as service:
            health_status, _, health = service.request("GET", "/health")
            ready_status, _, ready = service.request("GET", "/ready")

        self.assertEqual(health_status, 200)
        self.assertEqual(health, {"status": "ok"})
        self.assertEqual(ready_status, 200)
        self.assertEqual(
            ready,
            {"status": "ready", "engines": 2, "queueCapacity": 3},
        )

    def test_readiness_returns_503_before_engines_are_available(self) -> None:
        state = PopulationServiceState(
            engine_pool=None,
            queue_size=0,
            retry_after_seconds=4,
            max_request_bytes=1_000,
        )
        with RunningServer(PopulationHTTPServer(("127.0.0.1", 0), state)) as service:
            status, headers, body = service.request("GET", "/ready")

        self.assertEqual(status, 503)
        self.assertEqual(headers["Retry-After"], "4")
        self.assertEqual(body, {"status": "not_ready"})

    def test_calculate_contract_preserves_mode_and_shape_order(self) -> None:
        tracker = EngineTracker()
        with RunningServer(self.create_server(tracker)) as service:
            for method in ("fractional", "center"):
                with self.subTest(method=method):
                    status, _, body = service.request(
                        "POST",
                        "/v1/calculate",
                        {
                            "method": method,
                            "shapes": [shape("second"), shape("first")],
                        },
                    )
                    self.assertEqual(status, 200)
                    self.assertEqual(
                        body,
                        {
                            "results": [
                                {"id": "second", "population": 1.0},
                                {"id": "first", "population": 2.0},
                            ]
                        },
                    )

        self.assertEqual(tracker.methods, ["fractional", "center"])

    def test_calculate_requires_configured_bearer_token(self) -> None:
        tracker = EngineTracker()
        with RunningServer(
            self.create_server(tracker, auth_token="service-secret")
        ) as service:
            unauthorized_status, unauthorized_headers, unauthorized_body = (
                service.request(
                    "POST",
                    "/v1/calculate",
                    {"method": "center", "shapes": [shape("unauthorized")]},
                )
            )
            authorized_status, _, _ = service.request(
                "POST",
                "/v1/calculate",
                {"method": "center", "shapes": [shape("authorized")]},
                headers={"Authorization": "Bearer service-secret"},
            )

        self.assertEqual(unauthorized_status, 401)
        self.assertEqual(unauthorized_headers["WWW-Authenticate"], "Bearer")
        self.assertEqual(
            unauthorized_body,
            {"error": "Invalid or missing population service credentials."},
        )
        self.assertEqual(authorized_status, 200)

    def test_engine_concurrency_never_exceeds_worker_count(self) -> None:
        tracker = EngineTracker(blocked=True)
        server = self.create_server(tracker, workers=2, queue_size=1)
        results: list[int] = []
        results_lock = Lock()

        with RunningServer(server) as service:
            def submit(shape_id: str) -> None:
                status, _, _ = service.request(
                    "POST",
                    "/v1/calculate",
                    {"method": "fractional", "shapes": [shape(shape_id)]},
                )
                with results_lock:
                    results.append(status)

            threads = [Thread(target=submit, args=(str(index),)) for index in range(3)]
            for thread in threads:
                thread.start()

            self.assertTrue(tracker.wait_for_entered(2))
            time.sleep(0.05)
            self.assertEqual(tracker.max_active, 2)
            tracker.release.set()

            for thread in threads:
                thread.join(timeout=5)

        self.assertEqual(sorted(results), [200, 200, 200])
        self.assertEqual(tracker.max_active, 2)

    def test_saturated_service_returns_503_with_retry_after(self) -> None:
        tracker = EngineTracker(blocked=True)
        first_result: list[int] = []

        with RunningServer(
            self.create_server(tracker, workers=1, queue_size=0, retry_after=3)
        ) as service:
            first = Thread(
                target=lambda: first_result.append(
                    service.request(
                        "POST",
                        "/v1/calculate",
                        {"method": "center", "shapes": [shape("running")]},
                    )[0]
                )
            )
            first.start()
            self.assertTrue(tracker.wait_for_entered(1))

            status, headers, body = service.request(
                "POST",
                "/v1/calculate",
                {"method": "center", "shapes": [shape("rejected")]},
            )
            tracker.release.set()
            first.join(timeout=5)

        self.assertEqual(status, 503)
        self.assertEqual(headers["Retry-After"], "3")
        self.assertEqual(body, {"error": "Population service is saturated."})
        self.assertEqual(first_result, [200])


if __name__ == "__main__":
    unittest.main()
