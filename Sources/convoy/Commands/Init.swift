import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy init [dir]` — create + wire a smalltalk network folder so agents added into it are
/// correct-by-construction (AC-2). Wraps `st init`; no hand-editing to make a network usable.
struct Init: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Create and wire a smalltalk network folder (ST_ROOT, bus layout, hooks)."
    )

    @Argument(help: "Directory to initialize as a network root. Defaults to st's default.",
              completion: .directory)
    var dir: String?

    @Flag(name: .long, help: "Skip channel-mode MCP wiring in the generated network.")
    var noChannel = false

    @Flag(name: .long, help: "Print what would happen; touch nothing.")
    var dryRun = false

    func run() throws {
        var args = ["init"]
        if let dir {
            // `st init` requires the target directory to already exist. Creating it is convoy's
            // job — the whole point is that a network comes up without hand-preparation.
            if !dryRun && !FileManager.default.fileExists(atPath: dir) {
                try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                Out.line("created \(dir)")
            }
            args.append(dir)
        }
        if noChannel { args.append("--no-channel") }
        if dryRun { args.append("--print") }

        let result = try Shell.run("st", args, check: false)
        if !result.stdout.isEmpty { print(result.stdout, terminator: "") }
        if !result.ok {
            Out.err("st init failed: \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
            throw ExitCode.failure
        }
        if !dryRun {
            // Footgun-proof setup: make sure the base personas are present so `convoy add`/`cos`
            // resolve role personas without a manual step. Non-fatal.
            do {
                if case let .cloned(path) = try Personas.ensureInstalled(log: { Out.line($0) }) {
                    Out.line("installed personas at \(path)")
                }
            } catch {
                Out.err("personas: \(error) (add/cos will retry)")
            }

            let where_ = dir ?? "the default network"
            Out.line("✓ network ready at \(where_). Add agents with `convoy add <role> --identity <id>\(dir.map { " --network \($0)" } ?? "")`.")
        }
    }
}
