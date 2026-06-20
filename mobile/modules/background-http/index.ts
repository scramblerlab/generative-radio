import { requireOptionalNativeModule } from 'expo-modules-core';

// The native module is Android-only and autolinked from this folder. It is
// `null` on iOS/web and before a native rebuild. Consumers should use the typed
// helpers in src/modules/backgroundHttp.ts rather than this raw handle.
export default requireOptionalNativeModule('BackgroundHttp');
