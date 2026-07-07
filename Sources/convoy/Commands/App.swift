import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy app <install|status>` — manage the macOS menubar host (`Convoy.app`).
///
/// The brew cask is the primary install path; this is the non-brew path (`convoy app install`)
/// and a quick `convoy app status`.
struct App: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "app",
        abstract: "Install / inspect the Convoy.app menubar host.",
        subcommands: [Install.self, Status.self],
        defaultSubcommand: Status.self
    )

    struct Status: ParsableCommand {
        static let configuration = CommandConfiguration(abstract: "Is Convoy.app installed / running?")
        func run() throws {
            let installed = FileManager.default.fileExists(atPath: "/Applications/Convoy.app")
            Out.bullet(installed, installed ? "Convoy.app installed in /Applications"
                                            : "Convoy.app not installed")
            let running = (try? Shell.run("pgrep", ["-x", "Convoy"], check: false))?.ok ?? false
            Out.bullet(running ? true : nil, running ? "menubar app running" : "menubar app not running")
        }
    }

    struct Install: ParsableCommand {
        static let configuration = CommandConfiguration(
            abstract: "Copy Convoy.app to /Applications (non-brew install path)."
        )

        @Option(name: .long, help: "Path to a built Convoy.app bundle. Defaults to a nearby build output.",
                completion: .directory)
        var bundle: String?

        func run() throws {
            let fm = FileManager.default
            let candidates = [bundle].compactMap { $0 } + [
                ".build/bundler/Convoy.app",
                ".build/release/Convoy.app",
                "Convoy.app",
            ]
            guard let src = candidates.first(where: { fm.fileExists(atPath: $0) }) else {
                throw ConvoyError("no Convoy.app found. Build it first (`swift bundler bundle` — see BUILD.md), or pass --bundle <path>.")
            }
            let dest = "/Applications/Convoy.app"
            if fm.fileExists(atPath: dest) { try fm.removeItem(atPath: dest) }
            try fm.copyItem(atPath: src, toPath: dest)
            Out.line("✓ installed \(dest)")
            Out.line("  Open it from /Applications (right-click → Open the first time; the build is ad-hoc signed).")
        }
    }
}
