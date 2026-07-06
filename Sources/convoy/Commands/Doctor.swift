import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy doctor` — "will this actually work here?" It catches the same footguns AC-1 prevents,
/// so a misconfig is caught here rather than discovered in production.
struct Doctor: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Check that convoy can actually run here (tools, config, bus round-trip)."
    )

    @OptionGroup var net: NetworkOptions

    func run() throws {
        var failures = 0
        func check(_ ok: Bool, _ pass: String, _ fail: String) {
            Out.bullet(ok, ok ? pass : fail)
            if !ok { failures += 1 }
        }

        Out.line("Tooling")
        let st = Shell.which("st")
        let pty = Shell.which("pty")
        check(st != nil, "st on PATH (\(st ?? ""))", "st NOT on PATH — install smalltalk")
        check(pty != nil, "pty on PATH (\(pty ?? ""))", "pty NOT on PATH — sessions can't be managed")

        Out.line("Bus")
        let bus = net.bus
        if let agents = try? bus.agents(enrich: true) {
            let live = agents.filter { $0.status.isLive }.count
            check(true, "bus round-trips (\(agents.count) members, \(live) live)", "")
        } else {
            check(false, "", "bus does NOT round-trip — `st agents --json` failed on \(net.network ?? "default network")")
        }

        Out.line("Network")
        if let root = net.network {
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: root, isDirectory: &isDir) && isDir.boolValue
            check(exists, "network root exists (\(root))", "network root missing — `convoy init \(root)`")
        } else {
            Out.bullet(nil, "using st's default network")
        }

        Out.line("Personas")
        if Personas.isInstalled() {
            Out.bullet(true, "base personas installed (\(Personas.dir()))")
        } else {
            Out.bullet(nil, "base personas not installed — `convoy personas install` (auto-installed by add/cos)")
        }

        Out.line("macOS host")
        let appInstalled = FileManager.default.fileExists(atPath: "/Applications/Convoy.app")
        Out.bullet(appInstalled ? true : nil,
                   appInstalled ? "Convoy.app installed in /Applications"
                                : "Convoy.app not installed (optional; `convoy app install` or brew cask)")

        Out.line()
        if failures == 0 {
            Out.line("✓ convoy is ready here.")
        } else {
            Out.line("✗ \(failures) blocking issue\(failures == 1 ? "" : "s") — resolve the ✗ lines above.")
            throw ExitCode.failure
        }
    }
}
