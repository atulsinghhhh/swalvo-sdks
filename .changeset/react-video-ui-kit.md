---
"@swalvo/react": minor
---

Add a prebuilt video UI kit, on par with LiveKit's components and Agora UIKit.

- `<VideoConference>`: a complete call screen in one component — a paginated grid that switches to a focus layout for a remote screen share or a pinned tile, an active-speaker ring, a control bar with device menus, remote audio, an autoplay-unlock button, reconnection toasts, and an optional chat side panel (`chat={…}`) that takes the chat UI kit.
- `<PreJoin>`: camera preview, live mic level meter, device pickers and a name field, plus an optional network test (`connectionTest`) that runs `runConnectionTest()` and shows the results. Its `onSubmit` choices go straight to `<VideoConference userChoices>`.
- Pieces: `<GridLayout>` (pauses off-page videos at the SFU through adaptive-stream visibility), `<FocusLayout>`, `<ParticipantTile>` (avatar placeholder, mute icon, speaking ring, connection bars, E2EE badge, "Video paused to save bandwidth"), `<ControlBar>`, `<TrackToggle>`, `<MediaDeviceMenu>`, `<DisconnectButton>`, `<ChatToggle>`, `<ConnectionQualityIndicator>`, `<RoomAudioRenderer>`, `<StartAudio>`, `<Toast>`, `<ConnectionStateToast>`, `<LayoutContextProvider>`.
- Hooks: `useTracks`, `useTrackToggle`, `useScreenShare`, `useMediaDevices`, `useMediaDeviceSelect`, `useRoomConnectionState`, `useDisconnectButton`, `useIsMuted`, `useParticipantTrack`, `usePinnedTracks`, `useChatToggle`, `useAudioPlayback`, `useAudioLevel`, `usePagination`, `useGridLayout`.
- Unstyled by default (`swalvo-*` classes, state as `data-*` attributes), keyboard-operable with ARIA states. The optional stylesheet ships as `@swalvo/react/video/styles.css`, themed with CSS variables, dark-first, honoring `prefers-reduced-motion`.

Everything is additive and side-effect free: an app that imports only hooks bundles none of the components.
