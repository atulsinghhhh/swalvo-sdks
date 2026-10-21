// swift-tools-version:5.9
//
// SwalvoRTC — the native iOS / macOS client for Swalvo RTC.
//
// Implements docs/rtc/signaling.md and the Phase 1/2/5 contracts in
// docs/architecture/. The WebRTC binary is LiveKit's libwebrtc build
// (github.com/livekit/webrtc-xcframework, product `LiveKitWebRTC`, Chromium
// M150, classes prefixed `LK`). Unlike upstream libwebrtc it ships
// `RTCFrameCryptor`, which phase 5 §3 end-to-end encryption needs. Its tags
// are `<milestone>.<branch>.<patch>`, so it is pinned exactly; bump it
// deliberately (and re-run the E2EE device checks in the README).
import PackageDescription

let package = Package(
    name: "SwalvoRTC",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "SwalvoRTC", targets: ["SwalvoRTC"]),
    ],
    dependencies: [
        .package(url: "https://github.com/livekit/webrtc-xcframework.git", exact: "150.7871.02"),
    ],
    targets: [
        .target(
            name: "SwalvoRTC",
            dependencies: [
                .product(name: "LiveKitWebRTC", package: "webrtc-xcframework"),
            ],
            path: "Sources/SwalvoRTC"
        ),
        .testTarget(
            name: "SwalvoRTCTests",
            dependencies: ["SwalvoRTC"],
            path: "Tests/SwalvoRTCTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
