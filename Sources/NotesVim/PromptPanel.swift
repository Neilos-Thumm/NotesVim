import AppKit

/// The command-line bar for ":" commands and "/" "?" searches, shown as a
/// small floating panel at the bottom of the Notes window.
///
/// It only displays the command. It never takes keyboard focus: Notes stays the
/// active app, and the keys typed into the bar arrive through the key tap.
final class PromptPanel {
    private let panel: NSPanel
    private let textLabel = NSTextField(labelWithString: "")
    private let descLabel = NSTextField(labelWithString: "")
    private var prefix = ""

    private(set) var isOpen = false

    init() {
        panel = DisplayOnlyPanel(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 34),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
            backing: .buffered,
            defer: true
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true

        textLabel.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        textLabel.lineBreakMode = .byTruncatingHead // long commands keep their end (and the caret) visible
        descLabel.font = NSFont.systemFont(ofSize: 11)
        descLabel.textColor = .secondaryLabelColor

        let row = NSStackView(views: [textLabel, descLabel])
        row.orientation = .horizontal
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        textLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        descLabel.setContentHuggingPriority(.required, for: .horizontal)

        let content = NSView()
        content.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor),
            row.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        panel.contentView = content
    }

    func open(prefix: String, desc: String, value: String, under windowFrame: NSRect?) {
        self.prefix = prefix
        descLabel.stringValue = desc
        descLabel.isHidden = desc.isEmpty
        update(value: value)

        let size = panel.frame.size
        var origin: NSPoint
        if let frame = windowFrame {
            origin = NSPoint(x: frame.midX - size.width / 2, y: frame.minY + 24)
        } else if let screen = NSScreen.main {
            origin = NSPoint(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.minY + 120)
        } else {
            origin = .zero
        }
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
        isOpen = true
    }

    func update(value: String) {
        textLabel.stringValue = prefix + value + "▏"
    }

    func close() {
        isOpen = false
        panel.orderOut(nil)
    }
}

/// A panel that can never become the key window, so showing it can't take
/// keyboard focus away from Notes.
private final class DisplayOnlyPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
