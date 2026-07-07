import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy remove <id>` — remove an agent from the convoy (the symmetric partner to `add`).
///
/// Teardown: resolve the agent's pty sessions (its main session + any `-ding` sidecar) from pty's
/// registry and stop each; with `--purge`, also remove its membership dir. Message history is
/// never hard-deleted unless you pass `--purge`.
struct Remove: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Remove an agent from the convoy (teardown / decommission)."
    )

    @Argument(help: "The identity to remove.")
    var identity: String

    @Option(name: .long, help: "Network root (ST_ROOT). Defaults to st's default network.",
            completion: .directory)
    var network: String?

    @Flag(name: .long, help: "Also delete the agent's membership dir (inbox/archive) — destroys message history.")
    var purge = false

    @Flag(name: .long, help: "Show what would happen; touch nothing.")
    var dryRun = false

    @Flag(name: [.short, .long], help: "Skip confirmation prompts.")
    var yes = false

    func run() throws {
        let bus = Bus(root: network)

        // Must exist to remove.
        let members = (try? bus.agents()) ?? []
        guard members.contains(where: { $0.identity == identity }) else {
            throw ConvoyError("no agent \"\(identity)\" on this network. `convoy ls\(network.map { " --network \($0)" } ?? "")` to list members.")
        }

        // Resolve the agent's actual sessions from pty's registry (main + any -ding sidecar).
        let sessions = Pty.sessions(for: identity, root: network)

        Out.line("convoy remove — plan:")
        if sessions.isEmpty {
            Out.line("  no running pty sessions for \(identity) (already down)")
        } else {
            for s in sessions {
                Out.line("  stop pty session \(s.displayName ?? s.name) (\(s.name))")
            }
        }
        if purge { Out.line("  purge membership dir (\(network ?? "default")/\(identity)) — DELETES message history") }

        if dryRun {
            Out.line("\n✓ Dry run only. Re-run without --dry-run to execute.")
            return
        }

        if !yes {
            let what = purge ? "Stop and PURGE" : "Stop"
            print("\n\(what) \(identity)? [y/N] ", terminator: "")
            guard let a = readLine()?.lowercased(), a == "y" || a == "yes" else {
                Out.line("Aborted."); throw ExitCode.failure
            }
        }

        // Stop each resolved session by its pty id.
        for s in sessions {
            let label = s.displayName ?? s.name
            if Pty.kill(s.name, root: network) {
                Out.line("✓ stopped \(label)")
            } else {
                Out.line("• \(label) didn't stop cleanly (already exited?)")
            }
        }

        if purge {
            let root = network ?? defaultNetworkRoot()
            let dir = root + "/" + identity
            if FileManager.default.fileExists(atPath: dir) {
                try FileManager.default.removeItem(atPath: dir)
                Out.line("✓ purged \(dir)")
            } else {
                Out.line("• membership dir not found at \(dir)")
            }
        }

        Out.line("✓ \(identity) removed from the convoy.")
    }

    private func defaultNetworkRoot() -> String {
        ProcessInfo.processInfo.environment["ST_ROOT"]
            ?? (ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()) + "/.local/state/smalltalk"
    }
}
