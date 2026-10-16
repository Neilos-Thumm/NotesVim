import AppKit
import ApplicationServices

/// Reads and edits the Apple Notes note body through the Accessibility API.
/// Offsets are UTF-16 code units, matching JavaScript strings.
final class NotesBridge {
    static let bundleID = "com.apple.Notes"

    private var appCache: (pid: pid_t, element: AXUIElement)?
    private var currentElement: AXUIElement?
    private var lastReadElement: AXUIElement?
    private var undoItem: AXUIElement?
    private var redoItem: AXUIElement?

    /// Set when an edit could not be made through Accessibility; shown in the menu.
    private(set) var lastError: String?

    // MARK: - Finding Notes and the note body

    var notesApp: NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID).first
    }

    var isNotesFrontmost: Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Self.bundleID
    }

    private func appElement() -> AXUIElement? {
        guard let app = notesApp else { return nil }
        let pid = app.processIdentifier
        if let cache = appCache, cache.pid == pid { return cache.element }
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 0.5)
        appCache = (pid, element)
        undoItem = nil
        redoItem = nil
        return element
    }

    /// The note body, if it currently has keyboard focus inside Notes.
    /// Remembered so prompts (":" and "/") can still edit it while their
    /// panel has focus.
    @discardableResult
    func refreshFocusedTextArea() -> Bool {
        guard let app = appElement(),
              let focused: AXUIElement = elementAttribute(app, kAXFocusedUIElementAttribute),
              stringAttribute(focused, kAXRoleAttribute) == (kAXTextAreaRole as String)
        else {
            return false
        }
        AXUIElementSetMessagingTimeout(focused, 0.5)
        currentElement = focused
        return true
    }

    private var target: AXUIElement? { currentElement }

    // MARK: - Calls made by the Vim engine

    /// Text and selection of the note body.
    func read() -> (text: String, start: Int, length: Int, elementChanged: Bool)? {
        guard let element = target,
              let text = stringAttribute(element, kAXValueAttribute),
              let range = rangeAttribute(element, kAXSelectedTextRangeAttribute)
        else {
            return nil
        }
        let changed: Bool
        if let last = lastReadElement {
            changed = !CFEqual(last, element)
        } else {
            changed = true
        }
        lastReadElement = element
        return (text, range.location, range.length, changed)
    }

    /// Cheap snapshot (no text) used to tell when Notes has applied a key.
    func lightState() -> (count: Int, start: Int, length: Int)? {
        guard let element = target,
              let count = intAttribute(element, kAXNumberOfCharactersAttribute),
              let range = rangeAttribute(element, kAXSelectedTextRangeAttribute)
        else {
            return nil
        }
        return (count, range.location, range.length)
    }

    @discardableResult
    func select(start: Int, length: Int) -> Bool {
        guard let element = target else { return false }
        var range = CFRange(location: start, length: length)
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        let result = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
        if result != .success {
            lastError = "Couldn't move the cursor (Accessibility error \(result.rawValue))"
            return false
        }
        lastError = nil
        return true
    }

    /// Replace a range. Returns false if Notes will only apply it after this
    /// key press finishes (keyboard fallback).
    func replace(start: Int, length: Int, text: String) -> Bool {
        guard let element = target else { return false }
        guard select(start: start, length: length) else { return false }
        let result = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString)
        if result == .success { return true }

        lastError = "Edited by keyboard fallback (Accessibility error \(result.rawValue))"
        if text.isEmpty {
            if length > 0 { postKey(51) } // Delete (backspace) removes the selection
        } else {
            typeText(text) // replaces the selection; never touches the clipboard
        }
        return false
    }

    /// Runs Notes' own Edit > Undo, so Vim's `u` uses Notes' undo history.
    /// Returns true once Notes has applied it.
    func undo() -> Bool { pressHistoryItem(redo: false) }
    func redo() -> Bool { pressHistoryItem(redo: true) }

    func visibleRange() -> (start: Int, length: Int)? {
        guard let element = target,
              let range = rangeAttribute(element, kAXVisibleCharacterRangeAttribute)
        else {
            return nil
        }
        return (range.location, range.length)
    }

    @discardableResult
    func scroll(toOffset offset: Int) -> Bool {
        guard let element = target else { return false }
        var range = CFRange(location: offset, length: 0)
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        return AXUIElementSetAttributeValue(element, kAXVisibleCharacterRangeAttribute as CFString, value) == .success
    }

    /// Notes window frame in AppKit screen coordinates (bottom-left origin).
    func focusedWindowFrame() -> NSRect? {
        guard let app = appElement(),
              let window: AXUIElement = elementAttribute(app, kAXFocusedWindowAttribute),
              let posValue = axValueAttribute(window, kAXPositionAttribute),
              let sizeValue = axValueAttribute(window, kAXSizeAttribute)
        else {
            return nil
        }
        var origin = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posValue, .cgPoint, &origin)
        AXValueGetValue(sizeValue, .cgSize, &size)
        guard let primary = NSScreen.screens.first else { return nil }
        // Accessibility uses a top-left origin on the primary screen.
        let y = primary.frame.maxY - origin.y - size.height
        return NSRect(x: origin.x, y: y, width: size.width, height: size.height)
    }

    // MARK: - Undo / redo through the Edit menu

    private func pressHistoryItem(redo: Bool) -> Bool {
        guard let element = target else { return false }
        let item = redo ? (redoItem ?? findHistoryItem(redo: true)) : (undoItem ?? findHistoryItem(redo: false))
        guard let item else {
            // No menu item found: send ⌘Z / ⇧⌘Z instead (applied after this key).
            postKey(6, flags: redo ? [.maskCommand, .maskShift] : [.maskCommand])
            return false
        }
        if redo { redoItem = item } else { undoItem = item }

        if boolAttribute(item, kAXEnabledAttribute) == false { return true } // nothing to undo
        let before = stringAttribute(element, kAXValueAttribute)
        guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else {
            if redo { redoItem = nil } else { undoItem = nil }
            postKey(6, flags: redo ? [.maskCommand, .maskShift] : [.maskCommand])
            return false
        }
        // Menu actions can land a moment later; wait briefly for the text to change.
        for _ in 0..<15 {
            if stringAttribute(element, kAXValueAttribute) != before { break }
            usleep(10_000)
        }
        return true
    }

    /// Finds Edit > Undo (⌘Z) or Redo (⇧⌘Z) by shortcut, so it works in any language.
    private func findHistoryItem(redo: Bool) -> AXUIElement? {
        guard let app = appElement(),
              let menuBar: AXUIElement = elementAttribute(app, kAXMenuBarAttribute)
        else {
            return nil
        }
        let wantModifiers = redo ? 1 : 0 // kAXMenuItemModifierShift = 1, ⌘ is implied
        for barItem in children(menuBar) {
            for menu in children(barItem) {
                for item in children(menu) {
                    guard stringAttribute(item, kAXMenuItemCmdCharAttribute)?.uppercased() == "Z",
                          intAttribute(item, kAXMenuItemCmdModifiersAttribute) == wantModifiers
                    else { continue }
                    return item
                }
            }
        }
        return nil
    }

    // MARK: - Keyboard fallbacks

    func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
        guard let pid = notesApp?.processIdentifier else { return }
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else { continue }
            event.flags = flags
            event.setIntegerValueField(.eventSourceUserData, value: KeyTap.syntheticMarker)
            event.postToPid(pid)
        }
    }

    /// Types `text` into Notes as synthetic key presses. Newlines are sent as
    /// Return; everything else as Unicode strings of at most 20 UTF-16 units
    /// (the most one key event carries), never splitting a character.
    private func typeText(_ text: String) {
        guard let pid = notesApp?.processIdentifier else { return }
        func post(_ units: [UniChar]) {
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
                event.flags = []
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                event.setIntegerValueField(.eventSourceUserData, value: KeyTap.syntheticMarker)
                event.postToPid(pid)
            }
        }
        var chunk: [UniChar] = []
        for character in text {
            if character == "\n" || character == "\r\n" {
                if !chunk.isEmpty { post(chunk); chunk = [] }
                postKey(36) // Return
                continue
            }
            let units = Array(String(character).utf16)
            if chunk.count + units.count > 20, !chunk.isEmpty {
                post(chunk)
                chunk = []
            }
            chunk += units
        }
        if !chunk.isEmpty { post(chunk) }
    }

    // MARK: - Accessibility helpers

    private func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
        copyAttribute(element, name) as? String
    }

    private func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool? {
        (copyAttribute(element, name) as? NSNumber)?.boolValue
    }

    private func intAttribute(_ element: AXUIElement, _ name: String) -> Int? {
        (copyAttribute(element, name) as? NSNumber)?.intValue
    }

    private func axValueAttribute(_ element: AXUIElement, _ name: String) -> AXValue? {
        guard let value = copyAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXValue.self)
    }

    private func rangeAttribute(_ element: AXUIElement, _ name: String) -> CFRange? {
        guard let value = axValueAttribute(element, name) else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value, .cfRange, &range) else { return nil }
        return range
    }

    private func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = copyAttribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private func children(_ element: AXUIElement) -> [AXUIElement] {
        guard let value = copyAttribute(element, kAXChildrenAttribute) as? [AnyObject] else { return [] }
        return value.compactMap { child in
            CFGetTypeID(child) == AXUIElementGetTypeID() ? unsafeBitCast(child, to: AXUIElement.self) : nil
        }
    }
}
