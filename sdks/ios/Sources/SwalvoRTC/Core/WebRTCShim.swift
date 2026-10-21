import LiveKitWebRTC

// The WebRTC binary is LiveKit's libwebrtc build (`LiveKitWebRTC`), whose
// Objective-C classes, enums and constants carry an `LK` prefix
// (`LKRTCPeerConnection`, `kLKRTCMediaStreamTrackKindVideo`) so it can sit
// next to another libwebrtc in one app. These aliases keep the rest of the
// SDK in libwebrtc's ordinary vocabulary. Enum *cases* need no alias:
// `.unifiedPlan`, `.rollback`, `.sendOnly` resolve through the aliased type.

// MARK: Public: these appear in the SDK's public API.

/// libwebrtc's media track (`LKRTCMediaStreamTrack`).
public typealias RTCMediaStreamTrack = LKRTCMediaStreamTrack
/// libwebrtc's video track (`LKRTCVideoTrack`); add a renderer to draw it.
public typealias RTCVideoTrack = LKRTCVideoTrack
/// libwebrtc's audio track (`LKRTCAudioTrack`).
public typealias RTCAudioTrack = LKRTCAudioTrack
/// libwebrtc's capturer base class (`LKRTCVideoCapturer`).
public typealias RTCVideoCapturer = LKRTCVideoCapturer

// MARK: Internal

typealias RTCPeerConnectionFactory = LKRTCPeerConnectionFactory
typealias RTCDefaultVideoEncoderFactory = LKRTCDefaultVideoEncoderFactory
typealias RTCDefaultVideoDecoderFactory = LKRTCDefaultVideoDecoderFactory
typealias RTCPeerConnection = LKRTCPeerConnection
typealias RTCPeerConnectionDelegate = LKRTCPeerConnectionDelegate
typealias RTCConfiguration = LKRTCConfiguration
typealias RTCIceServer = LKRTCIceServer
typealias RTCIceCandidate = LKRTCIceCandidate
typealias RTCMediaConstraints = LKRTCMediaConstraints
typealias RTCSessionDescription = LKRTCSessionDescription
typealias RTCSignalingState = LKRTCSignalingState
typealias RTCIceConnectionState = LKRTCIceConnectionState
typealias RTCIceGatheringState = LKRTCIceGatheringState
typealias RTCPeerConnectionState = LKRTCPeerConnectionState
typealias RTCMediaStream = LKRTCMediaStream
typealias RTCRtpTransceiver = LKRTCRtpTransceiver
typealias RTCRtpTransceiverInit = LKRTCRtpTransceiverInit
typealias RTCRtpEncodingParameters = LKRTCRtpEncodingParameters
typealias RTCRtpMediaType = LKRTCRtpMediaType
typealias RTCRtpSender = LKRTCRtpSender
typealias RTCRtpReceiver = LKRTCRtpReceiver
typealias RTCDataChannel = LKRTCDataChannel
typealias RTCDataChannelDelegate = LKRTCDataChannelDelegate
typealias RTCDataChannelConfiguration = LKRTCDataChannelConfiguration
typealias RTCDataBuffer = LKRTCDataBuffer
typealias RTCAudioDevice = LKRTCAudioDevice
typealias RTCAudioDeviceDelegate = LKRTCAudioDeviceDelegate
typealias RTCVideoSource = LKRTCVideoSource
typealias RTCCameraVideoCapturer = LKRTCCameraVideoCapturer
typealias RTCCVPixelBuffer = LKRTCCVPixelBuffer
typealias RTCVideoFrame = LKRTCVideoFrame
typealias RTCVideoRotation = LKRTCVideoRotation

// Frame encryption (phase 5 §3): only in LiveKit's build, not upstream libwebrtc.
typealias RTCFrameCryptor = LKRTCFrameCryptor
typealias RTCFrameCryptorDelegate = LKRTCFrameCryptorDelegate
typealias RTCFrameCryptorState = LKRTCFrameCryptorState
typealias RTCFrameCryptorKeyProvider = LKRTCFrameCryptorKeyProvider
typealias RTCCryptorAlgorithm = LKRTCCryptorAlgorithm
typealias RTCKeyDerivationAlgorithm = LKRTCKeyDerivationAlgorithm

/// A UIView on iOS and an NSView on macOS in LiveKit's build. (Its macOS
/// slice declares `LKRTCMTLNSVideoView` but does not export the class.)
typealias RTCMTLVideoView = LKRTCMTLVideoView

#if os(iOS)
typealias RTCAudioSession = LKRTCAudioSession
typealias RTCAudioSessionConfiguration = LKRTCAudioSessionConfiguration
#endif

/// `kLKRTCMediaStreamTrackKindVideo` / `kLKRTCMediaStreamTrackKindAudio`.
let kRTCMediaStreamTrackKindVideo = kLKRTCMediaStreamTrackKindVideo
let kRTCMediaStreamTrackKindAudio = kLKRTCMediaStreamTrackKindAudio

@discardableResult
func RTCInitializeSSL() -> Bool { LKRTCInitializeSSL() }
