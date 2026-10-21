import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Swalvo,
  SwalvoVideoView,
  useCamera,
  useConnectionState,
  useMicrophone,
  useRemoteParticipants,
  type SwalvoChatHandle,
  type Room,
} from '@swalvo/react-native';
import type { ChatMessage } from '@swalvo/chat';

/**
 * A Swalvo video call with a chat panel, on a phone.
 *
 * Everything here is real: real WebRTC media through Swalvo's SFU, real
 * messages through Swalvo Chat into Postgres. There are no mock arrays and
 * no fake participants anywhere in this file (spec §11).
 *
 * Note what the app never does: construct a WebSocket, register WebRTC
 * globals, manage an audio session, reconnect, or dedupe a retried
 * message. That's all inside the SDK.
 */
const BACKEND_URL = 'http://localhost:8790';

interface Session {
  identity: string;
  room: string;
  rtc: { token: string; endpoint: string; roomName: string; iceServers?: RTCIceServer[]; telemetryUrl?: string };
  chat: { token: string; apiUrl: string; roomId: string };
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  return (
    <SafeAreaView style={styles.flex}>
      {session ? (
        <CallScreen session={session} onLeave={() => setSession(null)} />
      ) : (
        <JoinScreen onJoined={setSession} />
      )}
    </SafeAreaView>
  );
}

function JoinScreen({ onJoined }: { onJoined: (session: Session) => void }) {
  const [identity, setIdentity] = useState('alice');
  const [room, setRoom] = useState('standup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The app authenticates against its OWN backend. A Swalvo API key
      // never exists on the device (spec §15).
      const response = await fetch(`${BACKEND_URL}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity: identity.trim(), room: room.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not start the session');
      onJoined({ ...body, identity: identity.trim(), room: room.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [identity, room, onJoined]);

  return (
    <View style={styles.centered}>
      <Text style={styles.title}>Swalvo</Text>
      <Text style={styles.subtitle}>Video and chat, on the same screen.</Text>

      <TextInput
        style={styles.input}
        value={identity}
        onChangeText={setIdentity}
        placeholder="Your identity"
        autoCapitalize="none"
      />
      <TextInput style={styles.input} value={room} onChangeText={setRoom} placeholder="Room" autoCapitalize="none" />

      <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={join} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Joining…' : 'Join'}</Text>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function CallScreen({ session, onLeave }: { session: Session; onLeave: () => void }) {
  const [swalvo, setSwalvo] = useState<Swalvo>();
  const [room, setRoom] = useState<Room>();
  const [error, setError] = useState<string>();
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    // One Swalvo instance for the life of this screen. Constructing it
    // registers the WebRTC globals; nothing else has to.
    const instance = new Swalvo({
      token: session.rtc.token,
      endpoint: session.rtc.endpoint,
      iceServers: session.rtc.iceServers,
      telemetryUrl: session.rtc.telemetryUrl,
      chatToken: session.chat.token,
      chatApiUrl: session.chat.apiUrl,
      logLevel: 'info',
    });
    setSwalvo(instance);

    let cancelled = false;

    instance
      .join(session.rtc.roomName)
      .then(async (joined) => {
        if (cancelled) {
          // The screen went away mid-connect. Leaving immediately is the
          // only correct move: otherwise the call outlives its own UI.
          await instance.dispose();
          return;
        }
        setRoom(joined);
        await instance.chat?.connect(session.chat.roomId).catch(() => undefined);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
      // dispose(), not leave(), because the whole feature is going
      // away, chat connection included.
      void instance.dispose();
    };
  }, [session]);

  const remotes = useRemoteParticipants(room);
  const connectionState = useConnectionState(room);
  const camera = useCamera(room);
  const microphone = useMicrophone(room);

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error}</Text>
        <Pressable style={styles.button} onPress={onLeave}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (!room) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
        <Text style={styles.subtitle}>Connecting…</Text>
      </View>
    );
  }

  const featured = remotes[0];

  return (
    <View style={styles.flex}>
      <View style={styles.stage}>
        <SwalvoVideoView
          participant={featured}
          room={room}
          style={styles.flex}
          placeholder={
            <View style={styles.centered}>
              <Text style={styles.subtitle}>
                {featured ? `${featured.identity} has their camera off` : 'Waiting for someone to join…'}
              </Text>
            </View>
          }
        />

        {/* The local preview floats above the remote video — zOrder 1 is
            what puts it there on Android. */}
        <SwalvoVideoView participant={room.localParticipant} room={room} style={styles.pip} zOrder={1} />

        <View style={styles.statusBar}>
          <Text style={styles.statusText}>
            {session.room} · {connectionState}
            {remotes.length > 0 ? ` · ${remotes.length + 1} in call` : ''}
          </Text>
        </View>
      </View>

      {chatOpen ? <ChatPanel chat={swalvo?.chat} identity={session.identity} /> : null}

      <View style={styles.controls}>
        <ControlButton
          label={camera.enabled ? 'Camera off' : 'Camera on'}
          busy={camera.busy}
          onPress={() => void camera.toggle().catch(() => undefined)}
        />
        <ControlButton
          label={microphone.enabled ? 'Mute' : 'Unmute'}
          busy={microphone.busy}
          onPress={() => void microphone.toggle().catch(() => undefined)}
        />
        <ControlButton label={chatOpen ? 'Hide chat' : 'Chat'} onPress={() => setChatOpen((open) => !open)} />
        <ControlButton label="Leave" destructive onPress={onLeave} />
      </View>

      {camera.error ? <Text style={styles.error}>{camera.error.message}</Text> : null}
    </View>
  );
}

function ChatPanel({ chat, identity }: { chat?: SwalvoChatHandle; identity: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    if (!chat) return undefined;

    // History first, so the panel opens with context, not empty.
    void chat.messages
      .list({ limit: 50 })
      .then((page) => setMessages([...page.data].reverse()))
      .catch(() => undefined);

    // on() returns an unsubscribe function: calling it on unmount is
    // what stops a closed panel leaking handlers.
    const offMessage = chat.on('message', (message) => {
      setMessages((current) =>
        current.some((existing) => existing.id === message.id) ? current : [...current, message],
      );
    });

    const offTyping = chat.on('typing', (event) => {
      if (event.userId === identity) return;
      setTypingUsers((current) =>
        event.isTyping
          ? current.includes(event.userId)
            ? current
            : [...current, event.userId]
          : current.filter((user) => user !== event.userId),
      );
    });

    return () => {
      offMessage();
      offTyping();
    };
  }, [chat, identity]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !chat) return;
    setDraft('');
    await chat.stopTyping().catch(() => undefined);
    // Resolves once Swalvo has durably stored it. The message itself
    // arrives through the normal event stream.
    await chat.send(text).catch(() => undefined);
  }, [draft, chat]);

  return (
    <KeyboardAvoidingView style={styles.chatPanel} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(message) => message.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => (
          <Text style={styles.message}>
            {item.deleted ? (
              <Text style={styles.subtitle}>message deleted</Text>
            ) : (
              <>
                <Text style={styles.messageSender}>{item.senderId}: </Text>
                {item.text}
                {item.edited ? <Text style={styles.subtitle}> (edited)</Text> : null}
              </>
            )}
          </Text>
        )}
      />

      <Text style={styles.typing}>{typingUsers.length > 0 ? `${typingUsers.join(', ')} typing…` : ' '}</Text>

      <View style={styles.composer}>
        <TextInput
          style={[styles.input, styles.composerInput]}
          value={draft}
          placeholder="Message…"
          onChangeText={(text) => {
            setDraft(text);
            // Safe per keystroke: the server only broadcasts on the
            // transition into typing, and the state expires on a TTL.
            void chat?.startTyping().catch(() => undefined);
          }}
          onSubmitEditing={() => void send()}
        />
        <Pressable style={styles.button} onPress={() => void send()}>
          <Text style={styles.buttonText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function ControlButton({
  label,
  onPress,
  busy,
  destructive,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      style={[styles.control, destructive && styles.controlDestructive, busy && styles.buttonDisabled]}
      onPress={onPress}
      disabled={busy}
    >
      <Text style={styles.controlText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#0b0b0d' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { color: '#fff', fontSize: 28, fontWeight: '600' },
  subtitle: { color: '#8b8b93', fontSize: 14, textAlign: 'center' },
  input: {
    width: '100%',
    backgroundColor: '#17171b',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  button: { backgroundColor: '#3b5bfd', borderRadius: 8, paddingHorizontal: 18, paddingVertical: 10 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#ff6b6b', padding: 12, textAlign: 'center' },

  stage: { flex: 1 },
  pip: { position: 'absolute', right: 16, top: 16, width: 96, height: 140, borderRadius: 10 },
  statusBar: {
    position: 'absolute',
    left: 16,
    top: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusText: { color: '#fff', fontSize: 12 },

  controls: { flexDirection: 'row', justifyContent: 'space-around', padding: 12, gap: 8 },
  control: { backgroundColor: '#1e1e24', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  controlDestructive: { backgroundColor: '#5b1f26' },
  controlText: { color: '#fff', fontSize: 13 },

  chatPanel: { height: 280, borderTopWidth: 1, borderTopColor: '#22222a', padding: 12 },
  message: { color: '#e6e6ea', paddingVertical: 3 },
  messageSender: { color: '#8ea2ff', fontWeight: '600' },
  typing: { color: '#8b8b93', fontSize: 12, minHeight: 16 },
  composer: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  composerInput: { flex: 1 },
});
