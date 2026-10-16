import AppKit

/// The command-line bar for ":" commands and "/" "?" searches, shown as a
/// small floating panel at the bottom of the Notes window.
final class PromptPanel: NSObject, NSTextFieldDelegate {
    var onSubmit: ((String) -> Void)?
    var onCancel: (() -> Void)?

    private let panel: NSPanel
    private let prefixLabel = NSTextField(labelWithString: "")
    private let field = NSTextField(string: "")
    private let descLabel = NSTextField(labelWithString: "")
    private var finished = false

    var isOpen: Bool { panel.isVisible }

    override init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 34),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: true
        )
        super.init()

        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true

        let mono = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        prefixLabel.font = mono
        field.font = mono
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.delegate = self
        field.cell?.usesSingleLineMode = true
        field.cell?.isScrollable = true
        descLabel.font = NSFont.systemFont(ofSize: 11)
        descLabel.textColor = .secondaryLabelColor

        let row = NSStackView(views: [prefixLabel, field, descLabel])
        row.orientation = .horizontal
        row.spacing = 4
        row.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        prefixLabel.setContentHuggingPriority(.required, for: .horizontal)
        descLabel.setContentHuggingPriority(.required, for: .horizontal)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let content = NSView()
        content.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            row.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        panel.contentView = content
    }

    func open(prefix: String, desc: String, value: String, under windowFrame: NSRect?) {
        finished = false
        prefixLabel.stringValue = prefix
        descLabel.stringValue = desc
        descLabel.isHidden = desc.isEmpty
        field.stringValue = value

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

        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        field.currentEditor()?.selectedRange = NSRange(location: value.utf16.count, length: 0)
    }

    func close() {
        finished = true
        panel.orderOut(nil)
    }

    // Enter submits, Escape cancels.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            guard !finished else { return true }
            finished = true
            onSubmit?(field.stringValue)
            return true
        }
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            guard !finished else { return true }
            finished = true
            onCancel?()
            return true
        }
        // Backspace on an empty line leaves the prompt, like Vim.
        if selector == #selector(NSResponder.deleteBackward(_:)) && field.stringValue.isEmpty {
            guard !finished else { return true }
            finished = true
            onCancel?()
            return true
        }
        return false
    }
}
