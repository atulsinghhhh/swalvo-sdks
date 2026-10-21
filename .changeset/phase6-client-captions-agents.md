---
"@swalvo/rtc": minor
"@swalvo/react": minor
"@swalvo/react-native": minor
---

Live transcription captions and AI voice agents on the client (Phase 6, docs/architecture/phase6-contracts.md §4, §8).

- **Room events** (`@swalvo/rtc`): `transcriptionSegment(segment)` for each `transcription.segment` (interim segments share a `segmentId` and replace each other, the final closes it, an empty final clears the interim; agent speech included with `participantId` = the agent), `transcriptionStateChanged(state)` (`{ transcriptionId, status, language }`), and `agentStateChanged(participant, state)` (`'listening' | 'thinking' | 'speaking' | 'ended'`, only on a change; a state that arrives before the agent joins is held until its `participantJoined`). Malformed frames and unknown states are ignored.
- **Participants**: `participant.isAgent` (identity `agent-…`), `participant.isTranscriber` (`transcriber-…`), `participant.agentState`, and a per-participant `agentStateChanged(state)` event.
- **`CaptionStore`**: a framework-free reducer (`attach(room)`, `subscribe`, `getSnapshot()` → `{ segments, interim, active, state }`) that applies the interim/final rules for any UI layer. Also `isAgentIdentity` / `isTranscriberIdentity`.
- **React** (`@swalvo/react`): `useTranscription({ participant?, maxSegments? })`, `useAgentState(participant)`, `<Captions>` (speaker name, italic interim, finals fade after `fadeAfterMs`, `aria-live="polite"`), `<CaptionsToggle>`, `<AgentVisualizer>` (state ring plus audio-level bars), and `<VideoConference captions>` for a CC button and overlay. Styled in `video/styles.css`.
- **React Native** (`@swalvo/react-native`): `useTranscription(room, { participant? })` and `useAgentState(participant)`, from the same `CaptionStore`; the new types and `CaptionStore` are re-exported.
