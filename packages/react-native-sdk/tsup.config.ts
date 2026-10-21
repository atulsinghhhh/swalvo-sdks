import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  treeshake: true,
  minify: false,
  // Every peer stays external. Bundling react-native or the WebRTC layer
  // would produce a second copy of native-backed modules, and two
  // registerGlobals() implementations fighting over the same globals is
  // exactly the kind of bug that only shows up on a device.
  external: [
    'react',
    'react-native',
    'react-native-webrtc',
    'react-native-incall-manager',
    '@react-native-community/netinfo',
    '@swalvo/rtc',
    '@swalvo/chat',
  ],
});
