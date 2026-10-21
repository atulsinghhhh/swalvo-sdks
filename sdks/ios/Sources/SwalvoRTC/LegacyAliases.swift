// Deprecated names from before the Swalvo rename. Same types, so existing
// code keeps compiling (with a deprecation warning) after changing
// `import LivqenoRTC` to `import SwalvoRTC`.

@available(*, deprecated, renamed: "SwalvoClient")
public typealias RavenClient = SwalvoClient

@available(*, deprecated, renamed: "SwalvoRTCVersion")
public typealias LivqenoRTCVersion = SwalvoRTCVersion

#if os(iOS) || os(macOS)
@available(*, deprecated, renamed: "SwalvoVideoView")
public typealias LivqenoVideoView = SwalvoVideoView
#endif
