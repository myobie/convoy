import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy personas <status|install>` — the base personas convoy installs for roles.
///
/// You rarely need this directly: `add`/`cos` auto-install personas when they need one, and
/// `doctor` reports their status. It's here for explicit control.
struct PersonasCmd: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "personas",
        abstract: "Inspect / install the base personas repo.",
        subcommands: [Status.self, Install.self],
        defaultSubcommand: Status.self
    )

    struct Status: ParsableCommand {
        static let configuration = CommandConfiguration(abstract: "Are the base personas installed?")
        func run() throws {
            let dir = Personas.dir()
            if Personas.isInstalled() {
                Out.bullet(true, "personas installed at \(dir)")
                for role in Role.allCases {
                    Out.bullet(Personas.baseFile(for: role) != nil, role.personaBaseFilename)
                }
            } else {
                Out.bullet(false, "personas not installed (expected at \(dir))")
                Out.line("  install with `convoy personas install` (or set CONVOY_PERSONAS_DIR).")
            }
        }
    }

    struct Install: ParsableCommand {
        static let configuration = CommandConfiguration(
            abstract: "Clone the personas repo if missing (idempotent)."
        )
        func run() throws {
            switch try Personas.ensureInstalled(log: { Out.line($0) }) {
            case .alreadyPresent:
                Out.line("✓ personas already installed at \(Personas.dir())")
            case .cloned(let path):
                Out.line("✓ installed personas at \(path)")
            }
        }
    }
}
