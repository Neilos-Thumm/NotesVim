import AppKit
import JavaScriptCore

/// What the Vim engine needs from the app.
protocol VimHost: AnyObject {
    var notes: NotesBridge { get }
    func vimModeChanged(_ mode: String)
    func vimNotify(_ text: String, durationMs: Int)
    func vimOpenPrompt(prefix: String, desc: String, value: String)
    func vimUpdatePrompt(_ value: String)
    func vimClosePrompt()
    func vimSetStatus(_ text: String)
}

/// Runs Obsidian's Vim engine (vim.js) plus the Notes adapter in JavaScriptCore.
final class VimEngine {
    private let context: JSContext
    private weak var host: VimHost?
    private var api: JSValue?

    init?(host: VimHost) {
        // `as JSContext?` compiles whether or not the SDK marks init as failable.
        guard let context = JSContext() as JSContext? else { return nil }
        self.context = context
        self.host = host

        context.exceptionHandler = { _, exception in
            NSLog("NotesVim JS error: \(exception?.toString() ?? "unknown")")
        }

        installNative()

        guard let vimURL = VimEngine.resourceURL("vim", "js"),
              let adapterURL = VimEngine.resourceURL("notes-adapter", "js"),
              var vimSource = try? String(contentsOf: vimURL, encoding: .utf8),
              let adapterSource = try? String(contentsOf: adapterURL, encoding: .utf8)
        else {
            NSLog("NotesVim: could not find vim.js / notes-adapter.js")
            return nil
        }
        // vim.js is an ES module; JavaScriptCore scripts can't use `export`.
        // Strip `export { ... }` lists and `export` / `export default` keywords.
        vimSource = vimSource
            .replacingOccurrences(of: #"(?m)^export\s*\{[^}]*\};?[ \t]*$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?m)^export\s+(default\s+)?"#, with: "", options: .regularExpression)

        context.evaluateScript(vimSource, withSourceURL: vimURL)
        guard let initVim = context.objectForKeyedSubscript("initVim") as JSValue?, initVim.isObject else {
            NSLog("NotesVim: vim.js did not define initVim (has the engine's export changed?)")
            return nil
        }
        context.evaluateScript(adapterSource, withSourceURL: adapterURL)

        guard let api = context.objectForKeyedSubscript("NotesVim") as JSValue?, !api.isUndefined else {
            NSLog("NotesVim: adapter did not load")
            return nil
        }
        self.api = api
    }

    func start(vimrc: String?, blockCursor: Bool) {
        var options: [String: Any] = ["blockCursor": blockCursor]
        if let vimrc { options["vimrc"] = vimrc }
        api?.invokeMethod("init", withArguments: [options])
    }

    /// Returns true if Vim used the key and it must not reach Notes.
    func handleKey(_ event: VimKeyEvent) -> Bool {
        guard let result = api?.invokeMethod("handleKey", withArguments: [event.dictionary]) else { return false }
        return result.toBool()
    }

    func promptCancel() { api?.invokeMethod("promptCancel", withArguments: []) }
    func loadVimrc(_ source: String) { api?.invokeMethod("loadVimrc", withArguments: [source]) }
    func forgetScreen() { api?.invokeMethod("forgetScreen", withArguments: []) }

    func setBlockCursor(_ on: Bool) {
        api?.objectForKeyedSubscript("options")?.setObject(on, forKeyedSubscript: "blockCursor" as NSString)
    }

    // MARK: - The `native` object the adapter calls

    private func installNative() {
        guard let native = JSValue(newObjectIn: context) as JSValue? else { return }

        let read: @convention(block) () -> NSDictionary? = { [weak self] in
            guard let state = self?.host?.notes.read() else { return nil }
            return [
                "text": state.text,
                "start": state.start,
                "length": state.length,
                "elementChanged": state.elementChanged,
            ] as NSDictionary
        }
        let select: @convention(block) (Int, Int) -> Bool = { [weak self] start, length in
            self?.host?.notes.select(start: start, length: length) ?? false
        }
        let replace: @convention(block) (Int, Int, String) -> Bool = { [weak self] start, length, text in
            self?.host?.notes.replace(start: start, length: length, text: text) ?? false
        }
        let undo: @convention(block) () -> Bool = { [weak self] in self?.host?.notes.undo() ?? false }
        let redo: @convention(block) () -> Bool = { [weak self] in self?.host?.notes.redo() ?? false }
        let visibleRange: @convention(block) () -> NSDictionary? = { [weak self] in
            guard let range = self?.host?.notes.visibleRange() else { return nil }
            return ["start": range.start, "length": range.length] as NSDictionary
        }
        let scrollTo: @convention(block) (Int) -> Bool = { [weak self] offset in
            self?.host?.notes.scroll(toOffset: offset) ?? false
        }
        let setMode: @convention(block) (String) -> Void = { [weak self] mode in
            self?.host?.vimModeChanged(mode)
        }
        let notify: @convention(block) (String, Int) -> Void = { [weak self] text, ms in
            self?.host?.vimNotify(text, durationMs: ms)
        }
        let openPrompt: @convention(block) (String, String, String) -> Void = { [weak self] prefix, desc, value in
            self?.host?.vimOpenPrompt(prefix: prefix, desc: desc, value: value)
        }
        let updatePrompt: @convention(block) (String) -> Void = { [weak self] value in
            self?.host?.vimUpdatePrompt(value)
        }
        let closePrompt: @convention(block) () -> Void = { [weak self] in
            self?.host?.vimClosePrompt()
        }
        let setStatus: @convention(block) (String) -> Void = { [weak self] text in
            self?.host?.vimSetStatus(text)
        }
        let clipboardRead: @convention(block) () -> String = {
            NSPasteboard.general.string(forType: .string) ?? ""
        }
        let clipboardWrite: @convention(block) (String) -> Void = { text in
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        let setTimer: @convention(block) (Int, Int) -> Void = { [weak self] id, ms in
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(max(0, ms))) {
                _ = self?.api?.invokeMethod("fireTimer", withArguments: [id])
            }
        }
        let log: @convention(block) (String) -> Void = { text in
            NSLog("NotesVim: \(text)")
        }

        // Blocks must be handed to JavaScriptCore as Objective-C block objects.
        func expose(_ name: String, _ block: AnyObject) {
            native.setObject(block, forKeyedSubscript: name as NSString)
        }
        expose("read", unsafeBitCast(read, to: AnyObject.self))
        expose("select", unsafeBitCast(select, to: AnyObject.self))
        expose("replace", unsafeBitCast(replace, to: AnyObject.self))
        expose("undo", unsafeBitCast(undo, to: AnyObject.self))
        expose("redo", unsafeBitCast(redo, to: AnyObject.self))
        expose("visibleRange", unsafeBitCast(visibleRange, to: AnyObject.self))
        expose("scrollTo", unsafeBitCast(scrollTo, to: AnyObject.self))
        expose("setMode", unsafeBitCast(setMode, to: AnyObject.self))
        expose("notify", unsafeBitCast(notify, to: AnyObject.self))
        expose("openPrompt", unsafeBitCast(openPrompt, to: AnyObject.self))
        expose("updatePrompt", unsafeBitCast(updatePrompt, to: AnyObject.self))
        expose("closePrompt", unsafeBitCast(closePrompt, to: AnyObject.self))
        expose("setStatus", unsafeBitCast(setStatus, to: AnyObject.self))
        expose("clipboardRead", unsafeBitCast(clipboardRead, to: AnyObject.self))
        expose("clipboardWrite", unsafeBitCast(clipboardWrite, to: AnyObject.self))
        expose("setTimer", unsafeBitCast(setTimer, to: AnyObject.self))
        expose("log", unsafeBitCast(log, to: AnyObject.self))
        context.setObject(native, forKeyedSubscript: "native" as NSString)
    }

    /// Inside the .app the scripts are in Contents/Resources; when run with
    /// `swift run` they're found next to the source tree.
    static func resourceURL(_ name: String, _ ext: String) -> URL? {
        if let url = Bundle.main.url(forResource: name, withExtension: ext) { return url }
        let sourceDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let dev = sourceDir.appendingPathComponent("../../Resources/\(name).\(ext)").standardizedFileURL
        return FileManager.default.fileExists(atPath: dev.path) ? dev : nil
    }
}
