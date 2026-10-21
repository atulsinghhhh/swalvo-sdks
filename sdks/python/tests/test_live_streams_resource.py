from __future__ import annotations

from unittest.mock import MagicMock

from swalvo._types import (
    AddHostParams,
    CreateIngressParams,
    CreateLiveStreamParams,
    CreateRestreamParams,
    UpdateLiveStreamParams,
    UpdateRestreamParams,
)
from swalvo.resources.live_streams import (
    AsyncLiveStreamIngressResource,
    AsyncLiveStreamRestreamsResource,
    AsyncLiveStreamsResource,
    LiveStreamIngressResource,
    LiveStreamRestreamsResource,
    LiveStreamsResource,
)


def _fake_http(return_value=None):
    http = MagicMock()
    http.request.return_value = return_value
    return http


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


def test_create_posts_the_wire_field_names() -> None:
    http = _fake_http({"id": "stream_1"})
    resource = LiveStreamsResource(http)

    resource.create(CreateLiveStreamParams(title="Friday Q&A", host_identity="user-123"))

    http.request.assert_called_once_with(
        "/v1/live-streams",
        method="POST",
        body={"title": "Friday Q&A", "hostIdentity": "user-123"},
    )


def test_create_omits_unset_fields_rather_than_sending_null() -> None:
    http = _fake_http({"id": "stream_1"})
    resource = LiveStreamsResource(http)

    resource.create(
        CreateLiveStreamParams(title="Friday Q&A", host_identity="user-123", thumbnail_url="https://example.com/t.png")
    )

    _, kwargs = http.request.call_args
    assert kwargs["body"] == {
        "title": "Friday Q&A",
        "hostIdentity": "user-123",
        "thumbnailUrl": "https://example.com/t.png",
    }


def test_list_without_status_sends_no_query() -> None:
    http = _fake_http([])
    resource = LiveStreamsResource(http)

    resource.list()

    http.request.assert_called_once_with("/v1/live-streams", query={})


def test_list_filters_by_status() -> None:
    http = _fake_http([])
    resource = LiveStreamsResource(http)

    resource.list(status="LIVE")

    http.request.assert_called_once_with("/v1/live-streams", query={"status": "LIVE"})


def test_get_includes_the_live_viewer_count() -> None:
    http = _fake_http({"id": "stream_1", "viewerCount": 3})
    resource = LiveStreamsResource(http)

    stream = resource.get("stream_1")

    http.request.assert_called_once_with("/v1/live-streams/stream_1")
    assert stream["viewerCount"] == 3


def test_update_patches_only_given_fields() -> None:
    http = _fake_http({"id": "stream_1"})
    resource = LiveStreamsResource(http)

    resource.update("stream_1", UpdateLiveStreamParams(title="New title"))

    http.request.assert_called_once_with("/v1/live-streams/stream_1", method="PATCH", body={"title": "New title"})


def test_start_posts_to_the_start_endpoint() -> None:
    http = _fake_http({"id": "stream_1", "status": "LIVE"})
    resource = LiveStreamsResource(http)

    resource.start("stream_1")

    http.request.assert_called_once_with("/v1/live-streams/stream_1/start", method="POST")


def test_end_posts_to_the_end_endpoint() -> None:
    http = _fake_http({"id": "stream_1", "status": "ENDED"})
    resource = LiveStreamsResource(http)

    resource.end("stream_1")

    http.request.assert_called_once_with("/v1/live-streams/stream_1/end", method="POST")


# ---------------------------------------------------------------------------
# Hosts and viewer credentials — the security-critical methods
# ---------------------------------------------------------------------------


def test_add_host_posts_identity_and_role() -> None:
    http = _fake_http({"identity": "user-2", "role": "CO_HOST", "rtc": {}, "chat": {}})
    resource = LiveStreamsResource(http)

    resource.add_host("stream_1", AddHostParams(identity="user-2"))

    http.request.assert_called_once_with("/v1/live-streams/stream_1/hosts", method="POST", body={"identity": "user-2"})


def test_add_host_forwards_an_explicit_role() -> None:
    http = _fake_http({"identity": "user-2", "role": "HOST"})
    resource = LiveStreamsResource(http)

    resource.add_host("stream_1", AddHostParams(identity="user-2", role="HOST"))

    _, kwargs = http.request.call_args
    assert kwargs["body"] == {"identity": "user-2", "role": "HOST"}


def test_remove_host_is_a_delete_on_the_identity_path() -> None:
    http = _fake_http(None)
    resource = LiveStreamsResource(http)

    resource.remove_host("stream_1", "user-2")

    http.request.assert_called_once_with("/v1/live-streams/stream_1/hosts/user-2", method="DELETE")


def test_create_viewer_token_sends_only_an_identity_never_a_role() -> None:
    http = _fake_http({"identity": "user-3", "role": "VIEWER", "rtc": {}})
    resource = LiveStreamsResource(http)

    resource.create_viewer_token("stream_1", "user-3")

    http.request.assert_called_once_with(
        "/v1/live-streams/stream_1/viewer-tokens", method="POST", body={"identity": "user-3"}
    )


def test_leave_posts_the_identity_as_a_clean_leave_signal() -> None:
    http = _fake_http(None)
    resource = LiveStreamsResource(http)

    resource.leave("stream_1", "user-3")

    http.request.assert_called_once_with("/v1/live-streams/stream_1/leave", method="POST", body={"identity": "user-3"})


# ---------------------------------------------------------------------------
# Restreams (RTMP out)
# ---------------------------------------------------------------------------


def test_restreams_create_posts_the_wire_field_names() -> None:
    http = _fake_http({"id": "rst_1", "keyLast4": "ab12"})
    resource = LiveStreamsResource(http)

    resource.restreams.create(
        "stream_1",
        CreateRestreamParams(url="rtmps://a.rtmp.youtube.com/live2", stream_key="xxxx-ab12", label="YouTube"),
    )

    http.request.assert_called_once_with(
        "/v1/live-streams/stream_1/restreams",
        method="POST",
        body={"url": "rtmps://a.rtmp.youtube.com/live2", "streamKey": "xxxx-ab12", "label": "YouTube"},
    )


def test_restreams_create_omits_an_unset_label() -> None:
    http = _fake_http({"id": "rst_1"})
    resource = LiveStreamsResource(http)

    resource.restreams.create("stream_1", CreateRestreamParams(url="rtmp://live.twitch.tv/app", stream_key="live_1"))

    _, kwargs = http.request.call_args
    assert kwargs["body"] == {"url": "rtmp://live.twitch.tv/app", "streamKey": "live_1"}


def test_restreams_list_gets_the_collection() -> None:
    http = _fake_http([{"id": "rst_1"}])
    resource = LiveStreamsResource(http)

    assert resource.restreams.list("stream_1") == [{"id": "rst_1"}]
    http.request.assert_called_once_with("/v1/live-streams/stream_1/restreams")


def test_restreams_update_patches_only_given_fields() -> None:
    http = _fake_http({"id": "rst_1", "enabled": False})
    resource = LiveStreamsResource(http)

    resource.restreams.update("stream_1", "rst_1", UpdateRestreamParams(enabled=False))

    http.request.assert_called_once_with(
        "/v1/live-streams/stream_1/restreams/rst_1", method="PATCH", body={"enabled": False}
    )


def test_restreams_delete_is_a_delete_on_the_restream_path() -> None:
    http = _fake_http(None)
    resource = LiveStreamsResource(http)

    resource.restreams.delete("stream_1", "rst_1")

    http.request.assert_called_once_with("/v1/live-streams/stream_1/restreams/rst_1", method="DELETE")


# ---------------------------------------------------------------------------
# Ingress (WHIP / RTMP in)
# ---------------------------------------------------------------------------


def test_ingress_create_posts_the_wire_field_names() -> None:
    http = _fake_http({"id": "ing_1", "streamKey": "sk_abc"})
    resource = LiveStreamsResource(http)

    created = resource.ingress.create(
        "stream_1", CreateIngressParams(protocol="WHIP", auto_start=False, reconnect_window_sec=30)
    )

    assert created["streamKey"] == "sk_abc"
    http.request.assert_called_once_with(
        "/v1/live-streams/stream_1/ingress",
        method="POST",
        body={"protocol": "WHIP", "autoStart": False, "reconnectWindowSec": 30},
    )


def test_ingress_create_without_params_sends_an_empty_body() -> None:
    http = _fake_http({"id": "ing_1"})
    resource = LiveStreamsResource(http)

    resource.ingress.create("stream_1")

    http.request.assert_called_once_with("/v1/live-streams/stream_1/ingress", method="POST", body={})


def test_ingress_get_reset_delete_hit_the_right_routes() -> None:
    http = _fake_http({"id": "ing_1"})
    resource = LiveStreamsResource(http)

    resource.ingress.get("stream_1")
    resource.ingress.reset("stream_1")
    resource.ingress.delete("stream_1")

    assert [c.args[0] for c in http.request.call_args_list] == [
        "/v1/live-streams/stream_1/ingress",
        "/v1/live-streams/stream_1/ingress/reset",
        "/v1/live-streams/stream_1/ingress",
    ]
    assert [c.kwargs.get("method") for c in http.request.call_args_list] == [None, "POST", "DELETE"]


# ---------------------------------------------------------------------------
# Async parity
# ---------------------------------------------------------------------------


class _AsyncHttp:
    """Minimal awaitable stand-in — MagicMock doesn't await cleanly."""

    def __init__(self, return_value=None) -> None:
        self.return_value = return_value
        self.calls: list[tuple[tuple, dict]] = []

    async def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.return_value


async def test_async_create_matches_the_sync_body() -> None:
    http = _AsyncHttp({"id": "stream_1"})
    resource = AsyncLiveStreamsResource(http)  # type: ignore[arg-type]

    await resource.create(CreateLiveStreamParams(title="Friday Q&A", host_identity="user-123"))

    args, kwargs = http.calls[0]
    assert args[0] == "/v1/live-streams"
    assert kwargs["body"] == {"title": "Friday Q&A", "hostIdentity": "user-123"}


async def test_async_add_host_matches_the_sync_body() -> None:
    http = _AsyncHttp({"identity": "user-2", "role": "CO_HOST"})
    resource = AsyncLiveStreamsResource(http)  # type: ignore[arg-type]

    await resource.add_host("stream_1", AddHostParams(identity="user-2"))

    args, kwargs = http.calls[0]
    assert args[0] == "/v1/live-streams/stream_1/hosts"
    assert kwargs["body"] == {"identity": "user-2"}


async def test_async_surface_matches_sync_surface() -> None:
    # The two clients must not drift. A method that exists on one and not
    # the other is a bug a user only finds after switching.
    sync_methods = {m for m in dir(LiveStreamsResource) if not m.startswith("_")}
    async_methods = {m for m in dir(AsyncLiveStreamsResource) if not m.startswith("_")}
    assert sync_methods == async_methods


async def test_async_restreams_create_matches_the_sync_body() -> None:
    http = _AsyncHttp({"id": "rst_1"})
    resource = AsyncLiveStreamsResource(http)  # type: ignore[arg-type]

    await resource.restreams.create("stream_1", CreateRestreamParams(url="rtmp://live.twitch.tv/app", stream_key="k"))

    args, kwargs = http.calls[0]
    assert args[0] == "/v1/live-streams/stream_1/restreams"
    assert kwargs == {"method": "POST", "body": {"url": "rtmp://live.twitch.tv/app", "streamKey": "k"}}


async def test_async_ingress_reset_posts_to_reset() -> None:
    http = _AsyncHttp({"id": "ing_1", "streamKey": "sk_new"})
    resource = AsyncLiveStreamsResource(http)  # type: ignore[arg-type]

    await resource.ingress.reset("stream_1")

    args, kwargs = http.calls[0]
    assert args[0] == "/v1/live-streams/stream_1/ingress/reset"
    assert kwargs == {"method": "POST"}


async def test_async_sub_resource_surfaces_match_sync() -> None:
    for sync_cls, async_cls in (
        (LiveStreamRestreamsResource, AsyncLiveStreamRestreamsResource),
        (LiveStreamIngressResource, AsyncLiveStreamIngressResource),
    ):
        sync_methods = {m for m in dir(sync_cls) if not m.startswith("_")}
        async_methods = {m for m in dir(async_cls) if not m.startswith("_")}
        assert sync_methods == async_methods


def test_v2_viewer_token_playback_and_stage_routes() -> None:
    from unittest.mock import MagicMock

    from swalvo.resources.live_streams import LiveStreamsResource

    http = MagicMock()
    http.request.return_value = {}
    streams = LiveStreamsResource(http)
    streams.create_viewer_token("stream_1", "dave")
    streams.create_viewer_token("stream_1", "dave", accept_playback=True)
    streams.invite_to_stage("stream_1", "dave")
    streams.promote_to_stage("stream_1", "dave")
    streams.demote_from_stage("stream_1", "dave")
    calls = http.request.call_args_list
    assert calls[0].kwargs["body"] == {"identity": "dave"}
    assert calls[1].kwargs["body"] == {"identity": "dave", "acceptPlayback": True}
    assert [c.args[0] for c in calls[2:]] == [
        "/v1/live-streams/stream_1/stage/invites",
        "/v1/live-streams/stream_1/stage/promote",
        "/v1/live-streams/stream_1/stage/demote",
    ]
