from __future__ import annotations

from unittest.mock import MagicMock

from swalvo.resources.ai import AgentsResource, TranscriptionsResource


def _fake_http(return_value=None):
    http = MagicMock()
    http.request.return_value = return_value
    return http


def test_transcriptions_map_onto_the_contract_routes() -> None:
    http = _fake_http({})
    trx = TranscriptionsResource(http)

    trx.start("r1", language="en", provider_keys={"deepgram": "k"})
    trx.get("r1")
    trx.stop("r1")
    trx.transcript("trx_1", cursor="c", limit=5)
    trx.export("trx_1", "txt")

    calls = http.request.call_args_list
    assert calls[0].args == ("/v1/rooms/r1/transcription",)
    assert calls[0].kwargs == {
        "method": "POST",
        "body": {"language": "en", "providerKeys": {"deepgram": "k"}},
        "retryable": False,
    }
    assert calls[2].kwargs == {"method": "DELETE"}
    assert calls[3].kwargs == {"query": {"cursor": "c", "limit": 5}}
    assert calls[4].args == ("/v1/transcripts/trx_1.txt",)
    assert calls[4].kwargs == {"text": True}


def test_agents_map_onto_the_contract_routes() -> None:
    http = _fake_http({})
    agents = AgentsResource(http)

    agents.create("r1", {"name": "Bot", "instructions": "Hi"})
    agents.update("agt_1", listen_to=["alice"])
    agents.say("agt_1", "hello")
    agents.interrupt("agt_1")
    agents.delete("agt_1")

    calls = http.request.call_args_list
    assert calls[0].args == ("/v1/rooms/r1/agents",)
    assert calls[1].kwargs == {"method": "PATCH", "body": {"listenTo": ["alice"]}}
    assert calls[2].args == ("/v1/agents/agt_1/say",)
    assert calls[3].args == ("/v1/agents/agt_1/interrupt",)
    assert calls[4].kwargs == {"method": "DELETE"}
