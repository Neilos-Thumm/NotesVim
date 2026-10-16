import AppKit
import ApplicationServices

final class AppDelegate: NSObject, NSApplicationDelegate, VimHost {
    let notes = NotesBridge()
    private let tap = KeyTap()
    private let prompt = PromptPanel()
    private var engine: VimEngine?

    private var statusItem: NSStatusItem!
    private var enabledItem: NSMenuItem!
    private var blockCursorItem: NSMenuItem!
    private var errorItem: NSMenuItem!

    private var mode = "normal"
    private var notification: (text: String, until: Date)?
    private var permissionTimer: Timer?

    private var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "enabled") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "enabled") }
    }
    private var blockCursor: Bool {
        get { UserDefaults.standard.object(forKey: "blockCursor") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "blockCursor") }
    }

    static let vimrcURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".notesvimrc")

    // MARK: - Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()

        guard let engine = VimEngine(host: self) else {
            showFatal("Couldn't load the Vim engine (vim.js). Rebuild with scripts/build-app.sh.")
            return
        }
        self.engine = engine
        engine.start(vimrc: try? String(contentsOf: Self.vimrcURL, encoding: .utf8), blockCursor: blockCursor)

        prompt.onSubmit = { [weak self] value in
            guard let self else { return }
            self.engine?.promptSubmit(value)
            self.prompt.close()
            self.notes.activateNotes()
        }
        prompt.onCancel = { [weak self] in
            guard let self else { return }
            self.engine?.promptCancel()
            self.prompt.close()
            self.notes.activateNotes()
        }

        tap.handler = { [weak self] event in self?.handle(event) ?? false }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.updateStatusTitle()
        }

        startWhenTrusted()
    }

    func applicationWillTerminate(_ notification: Notification) {
        collapseBlockCursor()
    }

    /// The event tap needs Accessibility permission; ask once, then keep
    /// checking until it's granted.
    private func startWhenTrusted() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if AXIsProcessTrustedWithOptions(options), tap.start() {
            updateStatusTitle()
            return
        }
        updateStatusTitle()
        permissionTimer?.invalidate()
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            if AXIsProcessTrusted(), self.tap.start() {
                timer.invalidate()
                self.updateStatusTitle()
            }
        }
    }

    // MARK: - Keys

    /// Text length and selection just before a key went through to Notes.
    private var pendingPassThrough: (count: Int, start: Int, length: Int)?

    private func handle(_ event: CGEvent) -> Bool {
        guard enabled, let engine, !prompt.isOpen, notes.isNotesFrontmost else { return false }
        guard notes.refreshFocusedTextArea() else { return false } // only in the note body
        guard let key = VimKeyEvent(event) else {
            notePassThrough()
            return false
        }

        // A key we let through a moment ago may still be queued in Notes. Vim
        // must see its effect first (e.g. the "c" in "abc<Esc>", or the "j"
        // of an `imap jk <Esc>`), so give Notes a moment to apply it.
        waitForPendingPassThrough()

        if key.cmd { // ⌘ shortcuts always belong to Notes
            notePassThrough()
            return false
        }
        let used = engine.handleKey(key)
        if !used { notePassThrough() }
        refreshErrorItem()
        return used
    }

    private func notePassThrough() {
        pendingPassThrough = notes.lightState()
    }

    private func waitForPendingPassThrough() {
        guard let before = pendingPassThrough else { return }
        pendingPassThrough = nil
        let deadline = Date().addingTimeInterval(0.06)
        while Date() < deadline {
            guard let now = notes.lightState() else { return }
            if now != before { return }
            usleep(2_000)
        }
    }

    // MARK: - VimHost

    func vimModeChanged(_ mode: String) {
        self.mode = mode
        updateStatusTitle()
    }

    func vimNotify(_ text: String, durationMs: Int) {
        let seconds = durationMs > 0 ? Double(durationMs) / 1000 : 4
        notification = (text, Date().addingTimeInterval(seconds))
        updateStatusTitle()
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 0.05) { [weak self] in
            self?.updateStatusTitle()
        }
    }

    func vimOpenPrompt(prefix: String, desc: String, value: String) {
        prompt.open(prefix: prefix, desc: desc, value: value, under: notes.focusedWindowFrame())
    }

    func vimClosePrompt() {
        guard prompt.isOpen else { return }
        prompt.close()
        notes.activateNotes()
    }

    // MARK: - Menu bar

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)

        let menu = NSMenu()
        let header = NSMenuItem(title: "NotesVim (Apple Notes only)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        enabledItem = NSMenuItem(title: "Enabled", action: #selector(toggleEnabled), keyEquivalent: "")
        enabledItem.target = self
        menu.addItem(enabledItem)

        blockCursorItem = NSMenuItem(title: "Block cursor in normal mode", action: #selector(toggleBlockCursor), keyEquivalent: "")
        blockCursorItem.target = self
        menu.addItem(blockCursorItem)

        menu.addItem(.separator())
        let openRc = NSMenuItem(title: "Edit ~/.notesvimrc", action: #selector(openVimrc), keyEquivalent: "")
        openRc.target = self
        menu.addItem(openRc)
        let reloadRc = NSMenuItem(title: "Reload ~/.notesvimrc", action: #selector(reloadVimrc), keyEquivalent: "")
        reloadRc.target = self
        menu.addItem(reloadRc)

        menu.addItem(.separator())
        let permission = NSMenuItem(title: "Accessibility Settings…", action: #selector(openAccessibilitySettings), keyEquivalent: "")
        permission.target = self
        menu.addItem(permission)

        errorItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        errorItem.isEnabled = false
        errorItem.isHidden = true
        menu.addItem(errorItem)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit NotesVim", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
        updateMenuState()
        updateStatusTitle()
    }

    private func updateStatusTitle() {
        guard let button = statusItem?.button else { return }
        if !tap.isRunning {
            button.title = "VIM ⚠︎"
            button.toolTip = "NotesVim needs Accessibility permission"
            return
        }
        if let note = notification, note.until > Date() {
            button.title = String(note.text.prefix(48))
            button.toolTip = note.text
            return
        }
        notification = nil
        button.toolTip = nil
        if !enabled {
            button.title = "VIM off"
            return
        }
        guard notes.isNotesFrontmost else {
            button.title = "VIM"
            return
        }
        let names = [
            "normal": "NORMAL", "insert": "INSERT", "visual": "VISUAL",
            "visual line": "V-LINE", "visual block": "V-BLOCK", "replace": "REPLACE",
        ]
        button.title = "-- \(names[mode] ?? mode.uppercased()) --"
    }

    private func updateMenuState() {
        enabledItem?.state = enabled ? .on : .off
        blockCursorItem?.state = blockCursor ? .on : .off
    }

    private func refreshErrorItem() {
        if let error = notes.lastError {
            errorItem.title = "⚠︎ \(error)"
            errorItem.isHidden = false
        }
    }

    // MARK: - Menu actions

    @objc private func toggleEnabled() {
        enabled.toggle()
        if !enabled { collapseBlockCursor() }
        engine?.forgetScreen()
        updateMenuState()
        updateStatusTitle()
    }

    @objc private func toggleBlockCursor() {
        blockCursor.toggle()
        engine?.setBlockCursor(blockCursor)
        if !blockCursor { collapseBlockCursor() }
        engine?.forgetScreen()
        updateMenuState()
    }

    @objc private func openVimrc() {
        let url = Self.vimrcURL
        if !FileManager.default.fileExists(atPath: url.path) {
            let starter = """
            " NotesVim settings — same syntax as Obsidian's .obsidian.vimrc
            " Lines run as Vim ex commands when NotesVim starts.
            " Use the menu's "Reload ~/.notesvimrc" after editing.
            "
            " imap jk <Esc>
            " nmap j gj
            " nmap k gk

            """
            try? starter.write(to: url, atomically: true, encoding: .utf8)
        }
        // A dotfile has no extension, so name the editor explicitly.
        let textEdit = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        NSWorkspace.shared.open([url], withApplicationAt: textEdit, configuration: NSWorkspace.OpenConfiguration())
    }

    @objc private func reloadVimrc() {
        guard let source = try? String(contentsOf: Self.vimrcURL, encoding: .utf8) else { return }
        engine?.loadVimrc(source)
        vimNotify("Reloaded ~/.notesvimrc", durationMs: 2000)
    }

    @objc private func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Helpers

    /// Don't leave the one-character "block cursor" selected when Vim stops
    /// drawing it, or the next typed letter would replace that character.
    private func collapseBlockCursor() {
        guard notes.refreshFocusedTextArea(), let state = notes.read(), state.length == 1 else { return }
        notes.select(start: state.start, length: 0)
    }

    private func showFatal(_ message: String) {
        statusItem.button?.title = "VIM ✕"
        let alert = NSAlert()
        alert.messageText = "NotesVim"
        alert.informativeText = message
        alert.runModal()
    }
}
