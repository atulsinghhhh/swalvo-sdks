"""Minimal FastAPI backend for the Live Streaming demo.

Calls the Live Streams REST API directly with `httpx` rather than through
`swalvo` — Live Streaming has no Python SDK wrapper yet (explicitly out
of scope for this phase; see docs/live-streaming/overview.md#known-
limitations). This is the same "call the REST endpoint directly" pattern
`examples/media-demo/server.py` already uses for the one conversation
operation the Node/Python SDKs don't wrap either.

SWALVO_API_KEY never leaves this process. The browser only ever receives
the RTC + chat credentials a host/viewer endpoint mints — never the key
itself.
"""

from __future__ import annotations

import os

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.requests import Request
from pydantic import BaseModel

SWALVO_API_URL = os.environ.get("SWALVO_API_URL", "http://localhost:4100")
SWALVO_API_KEY = os.environ["SWALVO_API_KEY"]

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

client = httpx.Client(
    base_url=SWALVO_API_URL,
    headers={"Authorization": f"Bearer {SWALVO_API_KEY}"},
    timeout=10.0,
)


@app.exception_handler(httpx.HTTPStatusError)
async def swalvo_error_handler(_request: Request, error: httpx.HTTPStatusError) -> JSONResponse:
    body = error.response.json() if error.response.content else {}
    print(f"Swalvo request failed [{error.response.status_code}] {body.get('code')}: {body.get('message')}")
    return JSONResponse(status_code=error.response.status_code, content=body)


class CreateStreamRequest(BaseModel):
    title: str
    hostIdentity: str


class JoinRequest(BaseModel):
    identity: str


@app.post("/api/streams")
def create_stream(req: CreateStreamRequest) -> dict:
    """Creates the stream and immediately mints the host's own credentials — one call for the demo's "Go Live" button."""
    stream = client.post("/v1/live-streams", json={"title": req.title, "hostIdentity": req.hostIdentity})
    stream.raise_for_status()
    stream_data = stream.json()

    host = client.post(f"/v1/live-streams/{stream_data['id']}/hosts", json={"identity": req.hostIdentity, "role": "HOST"})
    host.raise_for_status()

    return {"stream": stream_data, "credentials": host.json()}


@app.post("/api/streams/{stream_id}/start")
def start_stream(stream_id: str) -> dict:
    res = client.post(f"/v1/live-streams/{stream_id}/start")
    res.raise_for_status()
    return res.json()


@app.post("/api/streams/{stream_id}/end")
def end_stream(stream_id: str) -> dict:
    res = client.post(f"/v1/live-streams/{stream_id}/end")
    res.raise_for_status()
    return res.json()


@app.get("/api/streams/{stream_id}")
def get_stream(stream_id: str) -> dict:
    res = client.get(f"/v1/live-streams/{stream_id}")
    res.raise_for_status()
    return res.json()


@app.post("/api/streams/{stream_id}/viewer-tokens")
def viewer_token(stream_id: str, req: JoinRequest) -> dict:
    """A viewer never sees a HOST option here — this is the only endpoint the viewer page calls, and it only ever mints subscribe-only credentials (enforced server-side, not by this backend's own logic)."""
    res = client.post(f"/v1/live-streams/{stream_id}/viewer-tokens", json={"identity": req.identity})
    res.raise_for_status()
    return res.json()
