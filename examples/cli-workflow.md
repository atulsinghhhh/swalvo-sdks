# CLI workflow: zero to a joined room

The canonical path through `@swalvo/cli` against hosted Swalvo Cloud
(`https://api.livqeno.com`, dashboard at `https://app.livqeno.com`).
Every command below is real — no placeholders elided for brevity beyond
your own project name.

> **Caveat:** `@swalvo/cli` is published to npm (see `PUBLISHING.md`),
> and the commands below reflect the CLI's documented behavior against
> the hosted API. This workflow was previously verified end-to-end
> against a local `docker compose` deployment; it has not been
> re-verified end-to-end against production exactly as written below, so
> treat step 7's health check and any environment-specific behavior as
> unconfirmed against the hosted stack until you've run it yourself.

```bash
# 1. Install
npm install -g @swalvo/cli

# 2. Authenticate — opens your browser, no password in the terminal
swalvo login
# ✔ Waiting for browser authentication…
# ✔ Logged in as dev@example.com

# 3. Confirm identity
swalvo whoami
# dev@example.com
# Projects: 0
# Environment: development

# 4. Create a project
swalvo projects create my-video-app
# ✔ Created project "my-video-app" (proj_...)

# 5. Link the current directory to it
mkdir my-video-app && cd my-video-app
swalvo init
# ? Select a project: my-video-app
# ✔ Linked this directory to "my-video-app". Wrote swalvo.json
# Next: swalvo sdk install

# 6. Install the browser SDK
swalvo sdk install
# (auto-detects npm/pnpm/yarn/bun and runs the install)

# 7. Sanity-check the setup
swalvo status
# Project: my-video-app
# Database:  Healthy
# Redis:     Healthy
# SFU:       Healthy
# TURN:      Healthy

# 8. Create an API key for your backend (shown once — save it now)
swalvo keys create --name dev-key
# rvk_xxxxxxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy

# 9. Create a room
swalvo rooms create my-room
# ✔ Created room "my-room" (a1b2c3d4-...)

swalvo rooms list
# NAME       LIVE PARTICIPANTS  STATUS
# my-room    0                  idle

# 10. Mint a short-lived RTC token from YOUR OWN BACKEND using the API
#     key from step 8 — never mint tokens in the browser, and the CLI
#     itself never mints a permanent one either:
curl -X POST https://api.livqeno.com/v1/rooms/a1b2c3d4-.../rtc-tokens \
  -H "Authorization: Bearer rvk_xxxxxxxxxxxx.yyyy..." \
  -H "Content-Type: application/json" \
  -d '{"participantIdentity": "alice", "permissions": {"join": true, "subscribe": true, "publish": true, "publishAudio": true, "publishVideo": true}}'

# 11. Run examples/video-call, paste that token JSON, click "Join Room"
python3 -m http.server 8900 --directory examples/video-call
open http://localhost:8900/index.html

# 12. Repeat steps 10-11 with a second identity ("bob") in a second tab
#     to see both participants join the same room.

# 13. Expected outcome: Terminal → Swalvo CLI → Swalvo API → Swalvo
#     infrastructure → a real RTC application, end to end.
```

## What this proves

- `swalvo login` reuses the dashboard's real session auth — no separate
  password flow.
- `swalvo projects create` / `swalvo init` / `swalvo keys create` /
  `swalvo rooms create` all hit the same Control API the dashboard uses —
  there is no CLI-only backend.
- The API key minted by the CLI mints a real, working RTC token from the
  Control API, which a real browser SDK client (`@swalvo/rtc`) can use to
  join and connect to a real Swalvo SFU node — expect `Status: connected`
  and correct remote-participant discovery in both browser tabs, with
  real signaling frames visible in the browser console (see the caveat
  above on end-to-end re-verification against the hosted platform).

## A note on step 11 in an automated/headless environment

Camera/microphone capture requires a real, human-granted browser
permission prompt (native browser UI, outside the page). In an
automated test harness without a way to click "Allow" on that OS-level
dialog, connection/signaling can be fully verified (as above) while
actual frame capture cannot — that's a property of the test
environment, not of the CLI or SDK. On a real developer machine, the
browser prompts normally and camera/microphone work as documented in
`docs/sdk.md`.
