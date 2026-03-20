#!/usr/bin/env python3
"""Simple API smoke checks for the invoice server.

Checks:
1) GET /health returns status ok
2) GET /config returns llm_endpoint and llm_model
3) POST /parse without file returns HTTP 400 with a structured error payload

Usage:
    python smoke_test.py
    python smoke_test.py --base-url http://localhost:5001
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def request_json(url: str, method: str = "GET", data: bytes | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(url=url, method=method, data=data)
    if method != "GET":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            status = res.getcode()
            body = res.read().decode("utf-8")
            return status, json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        parsed = {}
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"raw": body}
        return e.code, parsed


def assert_true(cond: bool, message: str) -> None:
    if not cond:
        raise AssertionError(message)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run smoke tests against invoice API")
    parser.add_argument("--base-url", default="http://localhost:5001", help="Invoice API base URL")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")

    print(f"[1/3] GET {base}/health")
    status, payload = request_json(f"{base}/health")
    assert_true(status == 200, f"/health expected 200, got {status}")
    assert_true(payload.get("status") == "ok", "/health payload missing status=ok")

    print(f"[2/3] GET {base}/config")
    status, payload = request_json(f"{base}/config")
    assert_true(status == 200, f"/config expected 200, got {status}")
    assert_true(bool(payload.get("llm_endpoint")), "/config missing llm_endpoint")
    assert_true(bool(payload.get("llm_model")), "/config missing llm_model")

    print(f"[3/3] POST {base}/parse (no file)")
    status, payload = request_json(f"{base}/parse", method="POST", data=b"")
    assert_true(status == 400, f"/parse without file expected 400, got {status}")
    assert_true(bool(payload.get("error")), "/parse error payload missing error")
    assert_true(bool(payload.get("timestamp")), "/parse error payload missing timestamp")

    print("All smoke checks passed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as err:
        print(f"Smoke test failed: {err}")
        raise SystemExit(1)
    except Exception as err:
        print(f"Unexpected error: {err}")
        raise SystemExit(2)
