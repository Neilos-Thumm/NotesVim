// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NotesVim",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "NotesVim",
            path: "Sources/NotesVim"
        )
    ]
)
