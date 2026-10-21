import Foundation
import LiveKitWebRTC

#if os(iOS)
import UIKit

/// Renders a track and reports its visibility and size to adaptive stream,
/// so off-screen videos pause (layer `off`) and small tiles get the low
/// layer. Wrap it in `UIViewRepresentable` for SwiftUI.
@MainActor
public final class SwalvoVideoView: UIView {
    private let renderer = RTCMTLVideoView(frame: .zero)

    public var track: Track? {
        didSet {
            guard oldValue !== track else { return }
            oldValue?.videoTrack?.remove(renderer)
            (oldValue as? RemoteTrack)?.setVisible(false)
            track?.videoTrack?.add(renderer)
            reportVisibility()
        }
    }

    public var videoContentMode: UIView.ContentMode = .scaleAspectFill {
        didSet { renderer.videoContentMode = videoContentMode }
    }

    public override init(frame: CGRect) {
        super.init(frame: frame)
        renderer.videoContentMode = videoContentMode
        renderer.frame = bounds
        renderer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(renderer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        reportVisibility()
    }

    public override var isHidden: Bool {
        didSet { reportVisibility() }
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        reportVisibility()
    }

    private func reportVisibility() {
        guard let remote = track as? RemoteTrack else { return }
        let visible = window != nil && !isHidden && bounds.width > 0 && bounds.height > 0
        remote.setVisible(visible)
        if visible {
            let scale = window?.screen.scale ?? 2
            remote.setVideoSize(CGSize(width: bounds.width * scale, height: bounds.height * scale))
        }
    }
}
#elseif os(macOS)
import AppKit

/// macOS renderer. Reports visibility/size to adaptive stream like the iOS view.
@MainActor
public final class SwalvoVideoView: NSView {
    private let renderer = RTCMTLVideoView(frame: .zero)

    public var track: Track? {
        didSet {
            guard oldValue !== track else { return }
            oldValue?.videoTrack?.remove(renderer)
            (oldValue as? RemoteTrack)?.setVisible(false)
            track?.videoTrack?.add(renderer)
            reportVisibility()
        }
    }

    public override init(frame: NSRect) {
        super.init(frame: frame)
        renderer.frame = bounds
        renderer.autoresizingMask = [.width, .height]
        addSubview(renderer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        reportVisibility()
    }

    public override func layout() {
        super.layout()
        reportVisibility()
    }

    private func reportVisibility() {
        guard let remote = track as? RemoteTrack else { return }
        let visible = window != nil && !isHidden && bounds.width > 0 && bounds.height > 0
        remote.setVisible(visible)
        if visible {
            let scale = window?.backingScaleFactor ?? 2
            remote.setVideoSize(CGSize(width: bounds.width * scale, height: bounds.height * scale))
        }
    }
}
#endif
