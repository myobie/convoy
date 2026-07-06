import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy add <role> --identity <id>` — add an agent to the convoy, correct-by-construction.
///
/// This is the footgun-proof front door (AC-1). You supply high-level intent; convoy derives ALL
/// wiring (permission mode from role, ST_AGENT, network tag, transport, hooks), validates it, and
/// only launches if the wiring is coherent. No hand-authored pty.toml; no way to fumble an env var.
struct Add: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Add an agent to the convoy (correct-by-construction; was `st launch`).",
        discussion: """
        Roles map to a fixed, reviewable wiring — you never hand-set the permission mode or ENV:
          chief-of-staff (cos) → bypassPermissions, permanent (spawner)
          supervisor           → bypassPermissions            (spawner)
          technical-manager    → bypassPermissions            (spawner)
          worker               → auto                         (worker)

        Examples:
          convoy add cos --identity cos
          convoy add worker --identity build-wk --transport ding
          convoy add supervisor --identity sup --network ~/nets/demo --dry-run
        """
    )

    @Argument(help: "Role: chief-of-staff|cos, supervisor, worker, technical-manager|tm.")
    var role: String

    @Option(name: .long, help: "The agent's identity (ST_AGENT is derived from this — never hand-set).")
    var identity: String

    @Option(name: .long, help: "Transport: mcp (default) or ding.")
    var transport: String = "mcp"

    @Option(name: .long, help: "Network root (ST_ROOT). Defaults to st's default network.")
    var network: String?

    @Option(name: .long, help: "Persona file to install. Defaults to the role's base persona.")
    var persona: String?

    @Option(name: .long, help: "Directory to install the agent into (its working dir). Defaults to the current directory.")
    var dir: String?

    @Option(name: .long, help: "Harness binary: claude (default) or codex.")
    var harness: String = "claude"

    @Flag(name: .long, help: "Validate + show the derived wiring and dry-run, but don't launch.")
    var dryRun = false

    @Flag(name: [.short, .long], help: "Skip the confirmation prompt.")
    var yes = false

    func run() throws {
        // Parse intent into typed values — reject unknowns loudly.
        guard let role = Role.parse(self.role) else {
            throw ConvoyError("unknown role \"\(self.role)\". Valid: "
                + Role.allCases.map { $0.rawValue }.joined(separator: ", "))
        }
        guard let harness = Harness(rawValue: self.harness.lowercased()) else {
            throw ConvoyError("unknown harness \"\(self.harness)\". Valid: claude, codex")
        }
        guard let transport = Transport(rawValue: self.transport.lowercased()) else {
            throw ConvoyError("unknown transport \"\(self.transport)\". Valid: mcp, ding")
        }

        let spec = AgentSpec(
            harness: harness,
            role: role,
            identity: identity,
            transport: transport,
            networkRoot: network,
            personaOverride: persona,
            workingDir: dir
        )

        Out.line("convoy add — \(identity)")
        try Runner.launch(spec, dryRun: dryRun, assumeYes: yes)
    }
}
