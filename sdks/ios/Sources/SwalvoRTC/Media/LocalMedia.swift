import AVFoundation
import CoreMedia
import Foundation
import LiveKitWebRTC
#if canImport(ReplayKit) && os(iOS)
import ReplayKit
#endif

/// Options for camera capture.
public struct CameraCaptureOptions: Sendable {
    public enum Position: Sendable { case front, back }
    public var position: Position = .front
    /// A specific `AVCaptureDevice.uniqueID`; overrides `position`.
    public var deviceId: String?
    /// Target capture size; the closest supported format is chosen.
    public var width: Int32 = 1280
    public var height: Int32 = 720
    public var fps: Int = 30

    public init(position: Position = .front, deviceId: String? = nil, width: Int32 = 1280, height: Int32 = 720, fps: Int = 30) {
        self.position = position
        self.deviceId = deviceId
        self.width = width
        self.height = height
        self.fps = fps
    }
}

/// Creates local tracks. Capture only; publish with `room.publish(_:)`, or
/// use `room.enableCamera()` / `enableMicrophone()` which do both.
@MainActor
public enum LocalMedia {
    /// The microphone, through WebRTC's audio device module.
    ///
    /// On iOS configure the audio session first (`AudioSessionConfigurator`)
    /// and declare `NSMicrophoneUsageDescription`.
    public static func createMicrophoneTrack() -> LocalTrack {
        let factory = WebRTCFactory.shared
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: [
            "googEchoCancellation": "true", "googNoiseSuppression": "true", "googAutoGainControl": "true",
        ])
        let source = factory.audioSource(with: constraints)
        let id = "mic-" + UUID().uuidString.lowercased()
        let track = factory.audioTrack(with: source, trackId: id)
        return LocalTrack(trackId: id, source: .microphone, mediaStreamTrack: track)
    }

    /// The camera. Requires `NSCameraUsageDescription`; unavailable in app
    /// extensions.
    public static func createCameraTrack(options: CameraCaptureOptions = CameraCaptureOptions()) async throws -> LocalTrack {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .notDetermined {
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            if !granted { throw RTCError(.cameraPermissionDenied, "Camera access was denied") }
        } else if status != .authorized {
            throw RTCError(.cameraPermissionDenied, "Camera access was denied")
        }

        let devices = RTCCameraVideoCapturer.captureDevices()
        let device: AVCaptureDevice?
        if let wanted = options.deviceId {
            device = devices.first { $0.uniqueID == wanted }
        } else {
            #if os(iOS)
            let position: AVCaptureDevice.Position = options.position == .front ? .front : .back
            device = devices.first { $0.position == position } ?? devices.first
            #else
            device = devices.first
            #endif
        }
        guard let device else { throw RTCError(.deviceNotFound, "No camera is available") }

        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        let target = options.width * options.height
        guard let format = formats.min(by: { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
            let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return abs(da.width * da.height - target) < abs(db.width * db.height - target)
        }) else { throw RTCError(.deviceNotFound, "The camera reports no capture formats") }
        let maxFps = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? Double(options.fps)
        let fps = min(options.fps, Int(maxFps))

        let factory = WebRTCFactory.shared
        let source = factory.videoSource()
        let capturer = RTCCameraVideoCapturer(delegate: source)
        let id = "cam-" + UUID().uuidString.lowercased()
        let rtcTrack = factory.videoTrack(with: source, trackId: id)

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            capturer.startCapture(with: device, format: format, fps: fps) { error in
                if let error { cont.resume(throwing: RTCError(.mediaError, "Could not start the camera: \(error.localizedDescription)")) } else { cont.resume() }
            }
        }
        let track = LocalTrack(trackId: id, source: .camera, mediaStreamTrack: rtcTrack)
        track.videoSource = source
        track.stopCapture = { capturer.stopCapture() }
        return track
    }

    /// A video track fed by the app (`BufferVideoCapturer`): a broadcast
    /// extension's ReplayKit buffers, a game engine, a file.
    public static func createBufferTrack(source kind: TrackSource = .screenShare) -> (LocalTrack, BufferVideoCapturer) {
        let factory = WebRTCFactory.shared
        let source = factory.videoSource(forScreenCast: kind == .screenShare)
        let capturer = BufferVideoCapturer(source: source)
        let id = (kind == .screenShare ? "screen-" : "custom-") + UUID().uuidString.lowercased()
        let rtcTrack = factory.videoTrack(with: source, trackId: id)
        let track = LocalTrack(trackId: id, source: kind, mediaStreamTrack: rtcTrack)
        track.videoSource = source
        return (track, capturer)
    }

    #if canImport(ReplayKit) && os(iOS)
    /// In-app screen share via ReplayKit (`RPScreenRecorder`). Captures this
    /// app only, and only while it is in the foreground. For the whole
    /// device, use a Broadcast Upload Extension (see Templates/).
    public static func createScreenShareTrack() async throws -> LocalTrack {
        let (track, capturer) = createBufferTrack(source: .screenShare)
        let recorder = RPScreenRecorder.shared()
        guard recorder.isAvailable else { throw RTCError(.unsupported, "Screen recording is not available") }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            recorder.startCapture(handler: { buffer, type, error in
                guard error == nil, type == .video else { return }
                capturer.capture(sampleBuffer: buffer)
            }, completionHandler: { error in
                if let error { cont.resume(throwing: RTCError(.permissionDenied, "Screen capture was refused: \(error.localizedDescription)")) } else { cont.resume() }
            })
        }
        track.stopCapture = { recorder.stopCapture(handler: nil) }
        return track
    }
    #else
    /// Screen share is iOS-only in this version (ReplayKit). On macOS,
    /// feed ScreenCaptureKit frames into `createBufferTrack()`.
    public static func createScreenShareTrack() async throws -> LocalTrack {
        throw RTCError(.unsupported, "Screen share capture is implemented for iOS (ReplayKit). On macOS, use LocalMedia.createBufferTrack() with ScreenCaptureKit frames.")
    }
    #endif
}

/// Pushes app-supplied frames into a WebRTC video source.
public final class BufferVideoCapturer: RTCVideoCapturer, @unchecked Sendable {
    private let source: RTCVideoSource

    init(source: RTCVideoSource) {
        self.source = source
        super.init(delegate: source)
    }

    /// Feeds one frame. `rotation` is in degrees (0/90/180/270).
    public func capture(pixelBuffer: CVPixelBuffer, timestampNs: Int64, rotation: Int = 0) {
        let buffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let rtcRotation: RTCVideoRotation
        switch rotation {
        case 90: rtcRotation = ._90
        case 180: rtcRotation = ._180
        case 270: rtcRotation = ._270
        default: rtcRotation = ._0
        }
        let frame = RTCVideoFrame(buffer: buffer, rotation: rtcRotation, timeStampNs: timestampNs)
        source.capturer(self, didCapture: frame)
    }

    /// Feeds a ReplayKit / AVFoundation sample buffer. `rotation` in degrees;
    /// for ReplayKit, derive it from `RPVideoSampleOrientationKey`
    /// (see `BufferVideoCapturer.rotation(forReplayKitOrientation:)`).
    public func capture(sampleBuffer: CMSampleBuffer, rotation: Int = 0) {
        guard CMSampleBufferIsValid(sampleBuffer), let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let ns = Int64(CMTimeGetSeconds(time) * 1_000_000_000)
        capture(pixelBuffer: pixelBuffer, timestampNs: ns, rotation: rotation)
    }

    /// Maps a `CGImagePropertyOrientation` raw value (what ReplayKit attaches
    /// under `RPVideoSampleOrientationKey`) to a rotation in degrees.
    public static func rotation(forReplayKitOrientation raw: UInt32) -> Int {
        switch raw {
        case 6, 5: return 90   // .right, .leftMirrored
        case 3, 4: return 180  // .down, .downMirrored
        case 8, 7: return 270  // .left, .rightMirrored
        default: return 0
        }
    }
}
