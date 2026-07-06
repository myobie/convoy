import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy cos --repo <dir>` — bootstrap a Chief of Staff: create/point-at its private repo, then
/// launch it (correct-by-construction) into that repo. The CoS runs its own first-run interview
/// from its persona on boot — convoy sets the stage; the agent conducts the interview.
///
/// Per the manifesto: the CoS owns a private repo it commits to constantly and rehydrates from.
struct Cos: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "cos",
        abstract: "Bootstrap a Chief of Staff (private repo + first-run interview + launch).",
        discussion: """
        Creates (or points at) the CoS's private git repo, then launches a chief-of-staff agent
        into it — permission-mode, permanence, persona, and wiring all derived. The CoS's
        first-run interview happens inside the agent on boot (from its persona), not here.

        Example:
          convoy cos --repo ~/cos --network ~/nets/demo
        """
    )

    @Option(name: .long, help: "The CoS identity. Defaults to \"cos\".")
    var identity: String = "cos"

    @Option(name: .long, help: "The CoS's private repo directory (created if missing).")
    var repo: String

    @Option(name: .long, help: "Network root (ST_ROOT). Defaults to st's default network.")
    var network: String?

    @Option(name: .long, help: "Persona file. Defaults to the chief-of-staff base persona.")
    var persona: String?

    @Option(name: .long, help: "Transport: mcp (default) or ding.")
    var transport: String = "mcp"

    @Flag(name: .long, help: "Show what would happen; touch nothing.")
    var dryRun = false

    @Flag(name: [.short, .long], help: "Skip confirmation prompts.")
    var yes = false

    func run() throws {
        guard let transport = Transport(rawValue: transport.lowercased()) else {
            throw ConvoyError("unknown transport \"\(self.transport)\". Valid: mcp, ding")
        }
        let repoPath = (repo as NSString).expandingTildeInPath
        let absRepo = URL(fileURLWithPath: repoPath).standardizedFileURL.path

        Out.line("convoy cos — \(identity)")
        Out.line("private repo: \(absRepo)")

        let exists = FileManager.default.fileExists(atPath: absRepo)
        if dryRun {
            if !exists {
                Out.line("  would create + git-init the repo here (skipped in --dry-run)")
                Out.line("\n✓ Dry run only. Re-run without --dry-run to bootstrap \(identity).")
                return
            }
            Out.line("  repo exists — dry-running the launch against it")
        } else {
            try ensureRepo(at: absRepo)
        }

        let spec = AgentSpec(
            role: .chiefOfStaff,
            identity: identity,
            transport: transport,
            networkRoot: network,
            personaOverride: persona,
            workingDir: absRepo
        )
        try Runner.launch(spec, dryRun: dryRun, assumeYes: yes)

        if !dryRun {
            Out.line("The CoS will run its first-run interview on boot. `convoy ls\(network.map { " --network \($0)" } ?? "")` to watch it come up.")
        }
    }

    /// Ensure `path` is a private git repo the CoS can commit to. Idempotent: creates + inits +
    /// seeds it if missing; leaves an existing repo alone; git-inits a plain existing directory.
    private func ensureRepo(at path: String) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) {
            try fm.createDirectory(atPath: path, withIntermediateDirectories: true)
            Out.line("  created \(path)")
        }
        let cwd = URL(fileURLWithPath: path)

        let isGit = (try? Shell.run("git", ["rev-parse", "--is-inside-work-tree"], cwd: cwd, check: false))?.ok ?? false
        if !isGit {
            try Shell.run("git", ["init", "--quiet"], cwd: cwd)
            Out.line("  git-init'd the repo")
        }

        // Seed a starter README + .gitignore (agent infra excluded) if the repo is empty of them.
        let readme = path + "/README.md"
        if !fm.fileExists(atPath: readme) {
            try "# \(identity)\n\nPrivate Chief-of-Staff repo. Durable state lives here (notes, plans, decisions).\n"
                .write(toFile: readme, atomically: true, encoding: .utf8)
        }
        let gitignore = path + "/.gitignore"
        if !fm.fileExists(atPath: gitignore) {
            let ignore = """
            # Agent infra (managed by st launch / convoy) — never commit
            PERSONA.md
            DING-BUS.md
            .mcp.json
            pty.toml
            .claude-session-id
            .codex-session-id
            .claude/settings.local.json
            .DS_Store
            """
            try ignore.write(toFile: gitignore, atomically: true, encoding: .utf8)
        }

        // Initial commit so the CoS starts from a clean, rehydratable base (only if nothing committed yet).
        let hasHead = (try? Shell.run("git", ["rev-parse", "--verify", "HEAD"], cwd: cwd, check: false))?.ok ?? false
        if !hasHead {
            try Shell.run("git", ["add", "README.md", ".gitignore"], cwd: cwd, check: false)
            try Shell.run("git", ["commit", "--quiet", "-m", "convoy: bootstrap CoS repo"], cwd: cwd, check: false)
            Out.line("  seeded README + .gitignore, initial commit")
        }
    }
}
