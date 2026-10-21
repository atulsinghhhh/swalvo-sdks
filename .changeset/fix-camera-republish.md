---
"@swalvo/rtc": patch
---

Fix: turning the camera off and on again during a call now reaches everyone else in the room. Since simulcast publishing landed, a re-enabled camera reused its old transceiver, so the media server never saw a new track and other participants silently stopped receiving that camera. The old transceiver is now stopped on unpublish and the camera gets a fresh one; the browser recycles the m-section, so the SDP does not grow per toggle.
