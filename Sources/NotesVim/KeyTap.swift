import AppKit
import CoreGraphics

/// Watches key presses system-wide and lets `handler` decide, per key,
/// whether to swallow it (return true) or let it reach the app (false).
final class KeyTap {
    /// Marks key events NotesVim posts itself so the tap ignores them.
    static let syntheticMarker: Int64 = 0x4E_56_49_4D // "NVIM"

    var handler: ((CGEvent) -> Bool)?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

    var isRunning: Bool { tap != nil }

    /// Needs Accessibility permission. Returns false if macOS refused.
    func start() -> Bool {
        if tap != nil { return true }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        let refcon = Unmanaged.passUnretained(self).toOpaque()

        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let me = Unmanaged<KeyTap>.fromOpaque(refcon).takeUnretainedValue()

                // macOS switches the tap off if a callback is slow or on user
                // input in secure fields; switch it straight back on.
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    if let port = me.tap { CGEvent.tapEnable(tap: port, enable: true) }
                    return Unmanaged.passUnretained(event)
                }
                guard type == .keyDown else { return Unmanaged.passUnretained(event) }
                if event.getIntegerValueField(.eventSourceUserData) == KeyTap.syntheticMarker {
                    return Unmanaged.passUnretained(event)
                }
                if let handler = me.handler, handler(event) {
                    return nil // swallowed: Notes never sees it
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: refcon
        ) else {
            return false
        }

        tap = port
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return true
    }

    func stop() {
        if let port = tap { CGEvent.tapEnable(tap: port, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }
}

/// A key press described the way the Vim engine expects (like a browser
/// KeyboardEvent).
struct VimKeyEvent {
    var key: String
    var code: String
    var ctrl: Bool
    var alt: Bool
    var shift: Bool
    var cmd: Bool

    var dictionary: [String: Any] {
        ["key": key, "code": code, "ctrlKey": ctrl, "altKey": alt, "shiftKey": shift, "metaKey": cmd]
    }

    private static let specialKeys: [Int: String] = [
        53: "Escape", 36: "Enter", 76: "Enter", 48: "Tab", 51: "Backspace", 117: "Delete",
        123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
        115: "Home", 119: "End", 116: "PageUp", 121: "PageDown", 49: " ",
    ]

    // ANSI key positions, used by the engine for Option-key combos.
    private static let codes: [Int: String] = [
        0: "KeyA", 11: "KeyB", 8: "KeyC", 2: "KeyD", 14: "KeyE", 3: "KeyF", 5: "KeyG", 4: "KeyH",
        34: "KeyI", 38: "KeyJ", 40: "KeyK", 37: "KeyL", 46: "KeyM", 45: "KeyN", 31: "KeyO",
        35: "KeyP", 12: "KeyQ", 15: "KeyR", 1: "KeyS", 17: "KeyT", 32: "KeyU", 9: "KeyV",
        13: "KeyW", 7: "KeyX", 16: "KeyY", 6: "KeyZ",
        29: "Digit0", 18: "Digit1", 19: "Digit2", 20: "Digit3", 21: "Digit4", 23: "Digit5",
        22: "Digit6", 26: "Digit7", 28: "Digit8", 25: "Digit9",
    ]

    init?(_ event: CGEvent) {
        let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
        let flags = event.flags
        ctrl = flags.contains(.maskControl)
        alt = flags.contains(.maskAlternate)
        shift = flags.contains(.maskShift)
        cmd = flags.contains(.maskCommand)
        code = Self.codes[keyCode] ?? ""

        if let special = Self.specialKeys[keyCode] {
            key = special
            return
        }
        guard let ns = NSEvent(cgEvent: event) else { return nil }
        // With Control or Command, use the plain key ("r" for Ctrl-R);
        // otherwise use what the key types (Shift and Option included).
        let chars = (ctrl || cmd) ? ns.charactersIgnoringModifiers : ns.characters
        guard let chars, !chars.isEmpty else { return nil } // dead keys, F-keys, etc.
        // Function keys and other non-text keys arrive as private-use characters.
        if let scalar = chars.unicodeScalars.first, (0xF700...0xF8FF).contains(scalar.value) {
            return nil
        }
        key = chars
    }
}
