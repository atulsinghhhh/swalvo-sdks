// Deprecated Raven* names for the chat integration, kept so code written
// against the pre-rename package keeps compiling. Each is the very same
// value as its Swalvo* replacement.
import { SwalvoChat, type SwalvoChatProps } from './swalvo-chat';
import type { SwalvoChatSnapshot } from './chat-store';

/** @deprecated Renamed to {@link SwalvoChat}. */
export const RavenChat = SwalvoChat;
/** @deprecated Renamed to {@link SwalvoChatProps}. */
export type RavenChatProps = SwalvoChatProps;
/** @deprecated Renamed to {@link SwalvoChatSnapshot}. */
export type RavenChatSnapshot = SwalvoChatSnapshot;

/** @deprecated Renamed to `isSwalvoChatError` / `SwalvoChatError`. */
export { isRavenChatError, RavenChatError } from '@swalvo/chat';
