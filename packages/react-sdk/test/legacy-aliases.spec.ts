import * as sdk from '../src';
import * as chatEntry from '../src/chat';

describe('deprecated Raven* aliases', () => {
  it('are the very same values as the Swalvo* exports', () => {
    expect(sdk.RavenRoom).toBe(sdk.SwalvoRoom);
    expect(sdk.useRaven).toBe(sdk.useSwalvo);
    expect(sdk.useRavenClient).toBe(sdk.useSwalvoClient);
    expect(sdk.useRavenError).toBe(sdk.useSwalvoError);
    expect(sdk.RavenVideo).toBe(sdk.SwalvoVideo);
    expect(sdk.RavenAudio).toBe(sdk.SwalvoAudio);
    expect(sdk.RavenChat).toBe(sdk.SwalvoChat);
    expect(sdk.RavenLiveStream).toBe(sdk.SwalvoLiveStream);
    expect(sdk.RavenChatError).toBe(sdk.SwalvoChatError);
    expect(sdk.isRavenChatError).toBe(sdk.isSwalvoChatError);
  });

  it('are exported from the chat-only entry too', () => {
    expect(chatEntry.RavenChat).toBe(chatEntry.SwalvoChat);
    expect(chatEntry.RavenChatError).toBe(chatEntry.SwalvoChatError);
  });
});
