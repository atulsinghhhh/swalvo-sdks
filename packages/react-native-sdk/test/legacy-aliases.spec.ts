import * as sdk from '../src';

describe('deprecated Raven* aliases', () => {
  it('are the very same values as the Swalvo* exports', () => {
    expect(sdk.Raven).toBe(sdk.Swalvo);
    expect(sdk.RavenLiveStream).toBe(sdk.SwalvoLiveStream);
    expect(sdk.RavenVideoView).toBe(sdk.SwalvoVideoView);
    expect(sdk.useRavenError).toBe(sdk.useSwalvoError);
    expect(sdk.isRavenPermissionError).toBe(sdk.isSwalvoPermissionError);
    expect(sdk.bootstrapRavenNative).toBe(sdk.bootstrapSwalvoNative);
  });

  it('keeps instanceof working across the old and new error names', () => {
    const error = new sdk.RavenPermissionError('camera', 'denied');
    expect(error).toBeInstanceOf(sdk.SwalvoPermissionError);
    expect(sdk.isRavenPermissionError(error)).toBe(true);
  });
});
