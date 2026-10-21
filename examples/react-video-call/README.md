# React video-call example — `@swalvo/react`

A real, buildable React app (Vite + TypeScript): a full video call in a
few lines, using `@swalvo/react`'s prebuilt UI kit — `<PreJoin>` for the
lobby (camera preview, mic level, device pickers) and `<VideoConference>`
for the call (grid and screen-share focus layouts, active-speaker ring,
mic/camera/screen controls with device menus, reconnection toasts, leave).
No media-plane types appear anywhere in `src/`.

This is a sibling to `examples/video-call/` (the original no-build-step,
plain-JS `@swalvo/rtc` demo, kept exactly as-is) — this one shows the same
underlying SDK from the React/hooks side.

## Running it

Sign up for a Swalvo Cloud project at the
[dashboard](https://app.swalvo.com) and create an API key from the
project's API Keys tab.

```bash
cd examples/react-video-call
npm install   # installs @swalvo/rtc and @swalvo/react from npm
npm run dev   # → http://localhost:8901
```

Mint a real RTC token against `https://api.swalvo.com` (e.g.
`swalvo rooms create` + a direct `POST /v1/rooms/:roomId/rtc-tokens` with
your API key as a bearer token), paste the full JSON response into the
textarea, click **Continue**, pick your devices, then **Join**. Open a second tab with a different
`participantIdentity` in the same room to see two-way video.

## What this proves

- `<SwalvoRoom>` plus one `<VideoConference>` is a complete call screen;
  `import '@swalvo/react/video/styles.css'` gives it the Swalvo look.
- `<PreJoin onSubmit>` hands its choices (devices, camera/mic on or off)
  to `<VideoConference userChoices>`, which publishes accordingly once
  connected.
- Every piece (`<GridLayout>`, `<ParticipantTile>`, `<ControlBar>`,
  `useTracks()`, `useTrackToggle()`…) is exported on its own for a custom
  layout — see the React components docs page (`apps/docs/content/sdk/react-components.mdx`).

Needs `@swalvo/react` 0.2.0 or later (the release with the video UI kit).

## Strict Mode

`main.tsx` deliberately does not wrap `<App>` in `<StrictMode>` — see the
comment there and `docs/sdk/react.md#strict-mode` for why (StrictMode's
dev-only double-invoke of effects would join → leave → rejoin the same
room on every mount, which is more confusing than useful in a demo whose
entire point is to show one clean connection lifecycle).
