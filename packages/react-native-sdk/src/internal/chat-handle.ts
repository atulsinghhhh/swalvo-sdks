import type { LogLevel } from '@swalvo/rtc';
import type { SwalvoChatHandle } from '../types';

interface ChatHandleOptions {
  token: string;
  apiUrl?: string;
  chatUrl?: string;
  logLevel?: LogLevel;
  onTokenExpiring?: () => Promise<string> | string;
}

/**
 * Builds `swalvo.chat` on top of `@swalvo/chat`'s real client.
 *
 * Two things about this file are worth knowing.
 *
 * First, `@swalvo/chat` is **resolved at runtime**, never imported
 * statically. It's an optional peer dependency. An app that only wants
 * video shouldn't be forced to bundle a messaging client, and a static
 * import makes it mandatory at bundle time whether or not `chatToken` was
 * ever set.
 *
 * Second, what comes back is the client itself with two methods layered on
 * top. Not a wrapper that re-implements or re-exports the API.
 * `chat.on(...)`, `chat.messages.list(...)`, `chat.startTyping()` and the
 * rest are the same functions a web app calls, so the chat documentation
 * applies verbatim on mobile (spec §5, no mobile-specific chat protocol).
 */
export function createChatHandle(options: ChatHandleOptions): SwalvoChatHandle | undefined {
  const chatModule = loadChatModule();
  if (!chatModule) {
    // Configured for chat, but the package isn't installed. Say so once and
    // clearly, instead of throwing from a constructor the developer may
    // not connect with chat at all.
    console.warn(
      '[swalvo] chatToken was provided but @swalvo/chat is not installed. ' +
        'Run: npm install @swalvo/chat; swalvo.chat will be undefined until then.',
    );
    return undefined;
  }

  const client = chatModule.createChatClient({
    token: options.token,
    apiUrl: options.apiUrl,
    chatUrl: options.chatUrl,
    logLevel: options.logLevel,
    onTokenExpiring: options.onTokenExpiring,
  });

  const handle = client as unknown as SwalvoChatHandle;
  const baseConnect = client.connect.bind(client);

  // `connect(room)`, not `connect({ room })`. On web the client gets
  // constructed at the point of use and the object form reads naturally
  // next to the other options. On mobile the client is already alive on
  // `swalvo` and the only question left is which room, so the string form is
  // what an app actually writes (spec §5).
  handle.connect = (room: string) => baseConnect({ room });
  handle.send = (text: string) => client.sendMessage({ text });

  return handle;
}

interface ChatModule {
  createChatClient(config: Record<string, unknown>): {
    connect(options: { room?: string }): Promise<void>;
    sendMessage(options: { text: string }): Promise<unknown>;
  };
}

function loadChatModule(): ChatModule | undefined {
  try {
    // Resolved at runtime on purpose. @swalvo/chat is an optional peer,
    // and a static import would make an RTC-only app pay for it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@swalvo/chat');
    return typeof mod?.createChatClient === 'function' ? (mod as ChatModule) : undefined;
  } catch {
    return undefined;
  }
}
