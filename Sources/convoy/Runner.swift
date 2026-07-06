import ConvoyKit
import Foundation
import ArgumentParser

/// The shared correct-by-construction launch flow used by `convoy add` and `convoy cos`:
/// derive + validate → show the wiring → dry-run `st launch` → confirm → launch. Failing any gate
/// stops before a broken agent is ever spawned (AC-1).
enum Runner {
    static func launch(_ spec: AgentSpec, dryRun: Bool, assumeYes: Bool) throws {
        // Footgun-proof setup: if this agent needs a role-base persona and the personas repo
        // isn't present, clone it before we resolve wiring. Real runs only (dry-run touches
        // nothing). Non-fatal — the preflight still warns if a persona can't be resolved.
        if !dryRun, spec.personaOverride == nil {
            do {
                if case let .cloned(path) = try Personas.ensureInstalled(log: { Out.line("  " + $0) }) {
                    Out.line("  installed personas at \(path)")
                }
            } catch {
                Out.err("personas: \(error)")
            }
        }

        let bus = Bus(root: spec.networkRoot)
        let pf = spec.preflight(bus: bus)

        Out.line("derived wiring (correct-by-construction):")
        for (k, v) in pf.derived {
            Out.line("  \(k.padding(toLength: 16, withPad: " ", startingAt: 0)) \(v)")
        }
        for w in pf.warnings { Out.line("  ! \(w)") }

        guard pf.ok else {
            Out.line()
            for e in pf.errors { Out.err(e) }
            throw ExitCode.failure
        }

        Out.line()
        Out.line("preflight (st launch --dry-run):")
        let dry = try spec.dryRun()
        let dryText = (dry.stdout + dry.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
        for l in dryText.split(separator: "\n", omittingEmptySubsequences: false) {
            Out.line("  " + l)
        }
        if !dry.ok {
            Out.line()
            Out.err("st launch --dry-run reported a problem — not launching. Resolve the above first.")
            throw ExitCode.failure
        }

        if dryRun {
            Out.line()
            Out.line("✓ Dry run only. Re-run without --dry-run to launch \(spec.identity).")
            return
        }

        if !assumeYes {
            Out.line()
            print("Launch \(spec.identity) as \(spec.role.rawValue) (\(spec.permissionMode.rawValue))? [y/N] ", terminator: "")
            let answer = readLine()?.lowercased()
            guard answer == "y" || answer == "yes" else {
                Out.line("Aborted.")
                throw ExitCode.failure
            }
        }

        Out.line("Launching \(spec.identity)…")
        let result = try spec.launch()
        if !result.stdout.isEmpty { print(result.stdout, terminator: "") }
        if !result.ok {
            Out.err("st launch failed: \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
            throw ExitCode.failure
        }
        let netFlag = spec.networkRoot.map { " --network \($0)" } ?? ""
        Out.line("✓ \(spec.identity) is under way. `convoy ls\(netFlag)` to see it.")
    }
}
