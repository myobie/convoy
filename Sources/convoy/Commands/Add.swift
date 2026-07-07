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
        abstract: "Add an agent to the convoy (correct-by-construction wiring).",
        discussion: """
        Roles map to a fixed, reviewable wiring — you never hand-set the permission mode or ENV:
          chief-of-staff (cos) → bypassPermissions, permanent (spawner)
          supervisor           → bypassPermissions            (spawner)
          technical-manager    → bypassPermissions            (spawner)
          worker               → auto                         (worker)

        Transport is ding-only by default (no MCP); pass --mcp to opt into MCP wiring.

        Examples:
          convoy add cos --identity cos                               # ding-only (default)
          convoy add worker --identity build-wk --mcp                 # opt into MCP wiring
          convoy add supervisor --identity sup --network ~/nets/demo --dry-run
        """
    )

    @Argument(help: "Role: chief-of-staff|cos, supervisor, worker, technical-manager|tm.",
              completion: .list(["chief-of-staff", "cos", "supervisor", "sup", "worker", "wk", "technical-manager", "tm"]))
    var role: String

    @Option(name: .long, help: "The agent's identity (ST_AGENT is derived from this — never hand-set).")
    var identity: String

    @Option(name: .long, help: "Transport: ding (default) or mcp. MCP is opt-in — prefer --mcp.",
            completion: .list(["ding", "mcp"]))
    var transport: String = "ding"

    @Flag(name: .long, help: "Opt into MCP wiring (shorthand for --transport mcp; ding is the default).")
    var mcp = false

    @Option(name: .long, help: "Network root (ST_ROOT). Defaults to st's default network.",
            completion: .directory)
    var network: String?

    @Option(name: .long, help: "Persona file to install. Defaults to the role's base persona.",
            completion: .file())
    var persona: String?

    @Option(name: .long, help: "Directory to install the agent into (its working dir). Defaults to the current directory.",
            completion: .directory)
    var dir: String?

    @Option(name: .long, help: "Harness binary: claude (default) or codex.", completion: .list(["claude", "codex"]))
    var harness: String = "claude"

    @Flag(name: .long, help: "Force always-on: the host (convoy up) respawns this agent if it dies. Required for any long-lived agent — only the CoS is permanent by role.")
    var permanent = false

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
        // MCP is opt-in: `--mcp` forces MCP; otherwise the default is ding.
        let transportRaw = mcp ? "mcp" : self.transport
        guard let transport = Transport(rawValue: transportRaw.lowercased()) else {
            throw ConvoyError("unknown transport \"\(self.transport)\". Valid: ding, mcp")
        }

        let spec = AgentSpec(
            harness: harness,
            role: role,
            identity: identity,
            transport: transport,
            networkRoot: network,
            personaOverride: persona,
            workingDir: dir,
            // Opt-in override only — never force-OFF the role default (the CoS stays permanent).
            permanentOverride: permanent ? true : nil
        )

        Out.line("convoy add — \(identity)")
        try Runner.launch(spec, dryRun: dryRun, assumeYes: yes)
    }
}
