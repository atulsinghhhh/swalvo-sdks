import AVFoundation
import CoreMedia
import Foundation
import LiveKitWebRTC

// Phase 7 §3: screen-share audio from an iOS Broadcast Upload Extension.
//
// libwebrtc has no "push PCM into this audio track" API: audio tracks are
// fed by the audio device module. A broadcast extension never records the
// microphone, so its process can swap the device for one that "records"
// ReplayKit's `.audioApp` buffers instead. Every audio track created in that
// process then carries app audio — which is exactly one track, published
// with source `screenShareAudio`. The app's own process is untouched.

extension LocalMedia {
    /// A `screenShareAudio` track fed by a broadcast extension's
    /// `.audioApp` sample buffers (`BroadcastAudioCapturer.capture`).
    ///
    /// **Broadcast Upload Extension only**, and call it before
    /// `room.connect`: it replaces this process's WebRTC audio device, so
    /// the process can no longer capture the microphone. Throws
    /// `.unsupported` if WebRTC was already set up in this process.
    /// The token needs `publishAudio`.
    public static func createBroadcastAudioTrack() throws -> (LocalTrack, BroadcastAudioCapturer) {
        let device: PushAudioDevice
        if let existing = WebRTCFactory.audioDevice as? PushAudioDevice {
            device = existing
        } else {
            guard !WebRTCFactory.isCreated else {
                throw RTCError(.unsupported, "Create the broadcast audio track before connecting a Room in this process")
            }
            device = PushAudioDevice()
            WebRTCFactory.audioDevice = device
        }
        let factory = WebRTCFactory.shared
        // App audio is not speech: no echo cancellation, suppression or AGC.
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: [
            "googEchoCancellation": "false", "googNoiseSuppression": "false", "googAutoGainControl": "false",
        ])
        let source = factory.audioSource(with: constraints)
        let id = "screen-audio-" + UUID().uuidString.lowercased()
        let rtcTrack = factory.audioTrack(with: source, trackId: id)
        let track = LocalTrack(trackId: id, source: .screenShareAudio, mediaStreamTrack: rtcTrack)
        let capturer = BroadcastAudioCapturer(device: device)
        track.stopCapture = { capturer.stop() }
        return (track, capturer)
    }
}

/// Feeds ReplayKit `.audioApp` (or `.audioMic`) sample buffers to the
/// `screenShareAudio` track from `LocalMedia.createBroadcastAudioTrack()`.
/// Thread-safe; call it straight from `processSampleBuffer`.
public final class BroadcastAudioCapturer: @unchecked Sendable {
    private let device: PushAudioDevice
    private let lock = NSLock()
    private var converter = PCMConverter(outputSampleRate: PushAudioDevice.sampleRate)
    private var stopped = false

    init(device: PushAudioDevice) {
        self.device = device
    }

    /// Feeds one linear-PCM audio sample buffer. Any rate, 16-bit integer
    /// (either endianness) or 32-bit float, interleaved or not; it is mixed
    /// to mono and resampled to 48 kHz.
    public func capture(sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferIsValid(sampleBuffer),
              let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
        else { return }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0 else { return }

        var blockBuffer: CMBlockBuffer?
        var sizeNeeded = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard sizeNeeded > 0 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: sizeNeeded,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer)
        guard status == noErr else { return }
        // `mBuffers` is a variable-length C array: walk it by hand (the
        // `UnsafeMutableAudioBufferListPointer` helper is not on every SDK slice).
        let count = Int(list.pointee.mNumberBuffers)
        let offset = MemoryLayout<AudioBufferList>.offset(of: \AudioBufferList.mBuffers) ?? 0
        let buffers = (0..<count).map { index -> Data in
            let buffer = raw.load(fromByteOffset: offset + index * MemoryLayout<AudioBuffer>.stride, as: AudioBuffer.self)
            guard let data = buffer.mData else { return Data() }
            return Data(bytes: data, count: Int(buffer.mDataByteSize))
        }
        capture(pcm: buffers, format: asbd, frameCount: frames)
    }

    /// Feeds raw linear PCM: one `Data` for interleaved audio, one per
    /// channel otherwise.
    public func capture(pcm buffers: [Data], format: AudioStreamBasicDescription, frameCount: Int) {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        let samples = converter.convert(buffers: buffers, format: format, frameCount: frameCount)
        lock.unlock()
        if !samples.isEmpty { device.push(samples) }
    }

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }
}

/// Linear PCM → mono 16-bit at a fixed rate, with a resampler that keeps
/// its phase across calls (so chunk boundaries do not click).
struct PCMConverter {
    let outputSampleRate: Double
    private var position: Double = 0
    private var previous: Float = 0

    init(outputSampleRate: Double) {
        self.outputSampleRate = outputSampleRate
    }

    /// Mono float samples in -1...1, or nil for a format it cannot read.
    static func monoSamples(buffers: [Data], format: AudioStreamBasicDescription, frameCount: Int) -> [Float]? {
        guard format.mFormatID == kAudioFormatLinearPCM, format.mChannelsPerFrame > 0 else { return nil }
        let flags = format.mFormatFlags
        let isFloat = flags & kAudioFormatFlagIsFloat != 0
        let bigEndian = flags & kAudioFormatFlagIsBigEndian != 0
        let nonInterleaved = flags & kAudioFormatFlagIsNonInterleaved != 0
        let bits = Int(format.mBitsPerChannel)
        guard (isFloat && bits == 32) || (!isFloat && bits == 16) else { return nil }
        let channels = Int(format.mChannelsPerFrame)
        let bytesPerSample = bits / 8

        func sample(_ data: Data, at index: Int) -> Float {
            let offset = index * bytesPerSample
            guard offset + bytesPerSample <= data.count else { return 0 }
            return data.withUnsafeBytes { raw -> Float in
                if isFloat {
                    var bitsValue = raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
                    bitsValue = bigEndian ? UInt32(bigEndian: bitsValue) : UInt32(littleEndian: bitsValue)
                    return Float(bitPattern: bitsValue)
                }
                var value = raw.loadUnaligned(fromByteOffset: offset, as: UInt16.self)
                value = bigEndian ? UInt16(bigEndian: value) : UInt16(littleEndian: value)
                return Float(Int16(bitPattern: value)) / 32768
            }
        }

        var out = [Float](repeating: 0, count: frameCount)
        for frame in 0..<frameCount {
            var sum: Float = 0
            for channel in 0..<channels {
                if nonInterleaved {
                    guard channel < buffers.count else { continue }
                    sum += sample(buffers[channel], at: frame)
                } else {
                    guard let data = buffers.first else { continue }
                    sum += sample(data, at: frame * channels + channel)
                }
            }
            out[frame] = sum / Float(channels)
        }
        return out
    }

    mutating func convert(buffers: [Data], format: AudioStreamBasicDescription, frameCount: Int) -> [Int16] {
        guard let mono = Self.monoSamples(buffers: buffers, format: format, frameCount: frameCount),
              format.mSampleRate > 0 else { return [] }
        let step = format.mSampleRate / outputSampleRate
        var out: [Int16] = []
        out.reserveCapacity(Int(Double(mono.count) / step) + 1)
        // `position` is in input samples, relative to this chunk; -1 is the
        // last sample of the previous chunk (`previous`).
        while position < Double(mono.count - 1) {
            let base = Int(position.rounded(.down))
            let fraction = Float(position - Double(base))
            let a = base < 0 ? previous : mono[base]
            let b = mono[base + 1]
            let value = max(-1, min(1, a + (b - a) * fraction))
            out.append(Int16(value * 32767))
            position += step
        }
        position -= Double(mono.count)
        previous = mono.last ?? previous
        return out
    }
}

/// An `RTCAudioDevice` that "records" whatever is pushed into it: mono
/// 16-bit 48 kHz, delivered to WebRTC in 10 ms chunks from one thread. It
/// never plays anything out (a broadcast extension subscribes to nothing).
final class PushAudioDevice: NSObject, RTCAudioDevice, @unchecked Sendable {
    static let sampleRate: Double = 48_000
    static let framesPer10ms = 480

    private let lock = NSCondition()
    private var delegate: RTCAudioDeviceDelegate?
    private var pending: [Int16] = []
    private var thread: Thread?
    /// Bumped on every start/stop so a stale delivery thread exits.
    private var generation = 0
    private var _isInitialized = false
    private var _isPlayoutInitialized = false
    private var _isPlaying = false
    private var _isRecordingInitialized = false
    private var _isRecording = false

    var deviceInputSampleRate: Double { Self.sampleRate }
    var inputIOBufferDuration: TimeInterval { 0.01 }
    var inputNumberOfChannels: Int { 1 }
    var inputLatency: TimeInterval { 0 }
    var deviceOutputSampleRate: Double { Self.sampleRate }
    var outputIOBufferDuration: TimeInterval { 0.01 }
    var outputNumberOfChannels: Int { 1 }
    var outputLatency: TimeInterval { 0 }

    var isInitialized: Bool { locked { _isInitialized } }
    var isPlayoutInitialized: Bool { locked { _isPlayoutInitialized } }
    var isPlaying: Bool { locked { _isPlaying } }
    var isRecordingInitialized: Bool { locked { _isRecordingInitialized } }
    var isRecording: Bool { locked { _isRecording } }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        locked {
            self.delegate = delegate
            _isInitialized = true
        }
        return true
    }

    func terminateDevice() -> Bool {
        _ = stopRecording()
        locked {
            delegate = nil
            _isInitialized = false
            _isPlayoutInitialized = false
            _isPlaying = false
            _isRecordingInitialized = false
        }
        return true
    }

    func initializePlayout() -> Bool { locked { _isPlayoutInitialized = true }; return true }
    func startPlayout() -> Bool { locked { _isPlaying = true }; return true }
    func stopPlayout() -> Bool { locked { _isPlaying = false }; return true }
    func initializeRecording() -> Bool { locked { _isRecordingInitialized = true }; return true }

    func startRecording() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !_isRecording else { return true }
        _isRecording = true
        generation += 1
        let mine = generation
        pending.removeAll()
        // WebRTC wants recorded audio delivered from one thread.
        let thread = Thread { [weak self] in self?.deliveryLoop(generation: mine) }
        thread.name = "swalvo.broadcast-audio"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
        return true
    }

    func stopRecording() -> Bool {
        lock.lock()
        _isRecording = false
        generation += 1
        thread = nil
        pending.removeAll()
        lock.broadcast()
        lock.unlock()
        return true
    }

    /// Queues mono 48 kHz samples. Bounded at one second, dropping the
    /// oldest, so a stalled delivery thread cannot grow without limit.
    func push(_ samples: [Int16]) {
        lock.lock()
        defer { lock.unlock() }
        guard _isRecording else { return }
        pending.append(contentsOf: samples)
        let cap = Int(Self.sampleRate)
        if pending.count > cap { pending.removeFirst(pending.count - cap) }
        if pending.count >= Self.framesPer10ms { lock.signal() }
    }

    private func deliveryLoop(generation mine: Int) {
        var sampleTime: Float64 = 0
        while true {
            lock.lock()
            while generation == mine && pending.count < Self.framesPer10ms {
                lock.wait()
            }
            guard generation == mine, _isRecording, let delegate else {
                lock.unlock()
                return
            }
            var chunk = Array(pending.prefix(Self.framesPer10ms))
            pending.removeFirst(Self.framesPer10ms)
            lock.unlock()

            var flags = AudioUnitRenderActionFlags()
            var timestamp = AudioTimeStamp()
            timestamp.mSampleTime = sampleTime
            timestamp.mFlags = .sampleTimeValid
            sampleTime += Float64(Self.framesPer10ms)
            chunk.withUnsafeMutableBytes { bytes in
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
                    mNumberChannels: 1, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
                _ = delegate.deliverRecordedData(&flags, &timestamp, 0, UInt32(Self.framesPer10ms), &list, nil, nil)
            }
        }
    }
}
