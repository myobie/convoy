import Foundation

/// A loud, user-facing convoy failure. Printed as `convoy: <message>` and exits non-zero.
/// AC-1: an invalid or ambiguous config must fail here — never launch a broken agent.
public struct ConvoyError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// The harness binary an agent runs.
public enum Harness: String, Sendable, CaseIterable {
    case claude, codex
}

/// The result of validating an `AgentSpec` before launch. Errors block the launch (fail loud);
/// warnings are surfaced but non-fatal; `derived` is the correct-by-construction wiring we'll
/// hand to `st launch`, shown to the user so there are no hidden decisions.
public struct Preflight: Sendable {
    public var errors: [String] = []
    public var warnings: [String] = []
    public var derived: [(String, String)] = []
    public var ok: Bool { errors.isEmpty }
}

/// High-level intent for one agent. convoy derives ALL wiring from these fields and validates
/// before launch — there is no hand-authored `pty.toml`, no hand-set ENV, no hand-chosen
/// permission mode. This is the footgun-proof front door (AC-1).
public struct AgentSpec: Sendable {
    public let harness: Harness
    public let role: Role
    public let identity: String
    public let transport: Transport
    /// The network root (ST_ROOT). `nil` = st's default network.
    public let networkRoot: String?
    /// Explicit persona path override. `nil` = resolve the role's base persona.
    public let personaOverride: String?
    /// The directory to install the agent into (its working dir / repo). `st launch` writes the
    /// agent's infra (pty.toml, .mcp.json, hooks, session-id) here. `nil` = convoy's cwd.
    public let workingDir: String?

    public init(
        harness: Harness = .claude,
        role: Role,
        identity: String,
        transport: Transport = .mcp,
        networkRoot: String? = nil,
        personaOverride: String? = nil,
        workingDir: String? = nil
    ) {
        self.harness = harness
        self.role = role
        self.identity = identity
        self.transport = transport
        self.networkRoot = networkRoot
        self.personaOverride = personaOverride
        self.workingDir = workingDir
    }

    private var cwdURL: URL? { workingDir.map { URL(fileURLWithPath: $0) } }

    // MARK: Derivation (correct-by-construction)

    public var permissionMode: PermissionMode { role.permissionMode }
    public var permanent: Bool { role.permanent }

    /// Valid identity shape: lowercase alnum plus `. _ -`, starting alnum. Matches the live
    /// network's naming (e.g. `convoy-claude`, `app-web-claude`, `build-wk.2`).
    public static func isValidIdentity(_ id: String) -> Bool {
        guard let first = id.first, first.isLetter || first.isNumber else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789._-")
        return !id.isEmpty && id.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    /// Where role-base personas live. Delegates to `Personas` (single source of truth).
    public static func personasDir() -> String { Personas.dir() }

    /// Resolve the persona file to install: explicit override wins; else the role's base file.
    /// Returns `nil` if no override and the base file isn't found (non-fatal → warning).
    public func resolvedPersonaPath() -> String? {
        if let personaOverride { return personaOverride }
        return Personas.baseFile(for: role)
    }

    // MARK: Validation

    /// Validate intent and compute the derived wiring. Never launches. `bus` is used for the
    /// duplicate-identity check against live members.
    public func preflight(bus: Bus) -> Preflight {
        var pf = Preflight()

        // Identity
        if !AgentSpec.isValidIdentity(identity) {
            pf.errors.append(
                "invalid identity \"\(identity)\": use lowercase letters, digits, and . _ - (start alphanumeric)")
        }

        // Duplicate on the target network
        if let existing = try? bus.agents(), existing.contains(where: { $0.identity == identity }) {
            pf.errors.append(
                "identity \"\(identity)\" already exists on this network — pick another or `convoy remove \(identity)` first")
        }

        // Network root
        if let networkRoot {
            var isDir: ObjCBool = false
            if !FileManager.default.fileExists(atPath: networkRoot, isDirectory: &isDir) {
                pf.errors.append("network root does not exist: \(networkRoot) (run `convoy init \(networkRoot)` first)")
            } else if !isDir.boolValue {
                pf.errors.append("network root is not a directory: \(networkRoot)")
            }
        }

        // Persona
        if let personaOverride {
            if !FileManager.default.fileExists(atPath: personaOverride) {
                pf.errors.append("persona file not found: \(personaOverride)")
            }
        } else if resolvedPersonaPath() == nil {
            pf.warnings.append(
                "no base persona found for role \"\(role.rawValue)\" in \(AgentSpec.personasDir()) — launching without a persona (set CONVOY_PERSONAS_DIR or pass --persona)")
        }

        // Working directory (where the agent's infra gets written) must exist.
        if let workingDir {
            var isDir: ObjCBool = false
            if !FileManager.default.fileExists(atPath: workingDir, isDirectory: &isDir) || !isDir.boolValue {
                pf.errors.append("working directory does not exist: \(workingDir)")
            }
        }

        // Codex ignores permission-mode + is always ding-mode; flag if the user asked for mcp.
        if harness == .codex && transport == .mcp {
            pf.warnings.append("codex has no MCP transport — it always runs ding-mode; ignoring --transport mcp")
        }

        // Derived wiring (shown to the user; no hidden decisions)
        pf.derived = [
            ("harness", harness.rawValue),
            ("identity", identity),
            ("role", role.rawValue),
            ("transport", (harness == .codex ? .ding : transport).rawValue),
            ("permission-mode", permissionMode.rawValue),
            ("permanent", permanent ? "yes" : "no"),
            ("persona", resolvedPersonaPath() ?? "(none)"),
            ("network", networkRoot ?? "(default)"),
            ("directory", workingDir ?? "(current)"),
        ]
        return pf
    }

    // MARK: st launch orchestration

    /// The exact `st launch` argv this intent derives to. convoy reimplements none of the
    /// file-writing — st launch is the single source of write-truth.
    public func stLaunchArgs(dryRun: Bool = false) -> [String] {
        var args = ["launch", harness.rawValue, "--identity", identity]

        // Permission mode — DERIVED from role, threaded into argv + generated pty.toml by st.
        // (Codex ignores it, but passing it is harmless and keeps the call uniform.)
        args += ["--permission-mode", permissionMode.rawValue]

        if transport == .ding { args.append("--ding") }
        if permanent { args.append("--permanent") }
        if let persona = resolvedPersonaPath() { args += ["--persona", persona] }
        if dryRun { args.append("--dry-run") }
        return args
    }

    /// Environment overlay pinning the target network for the `st launch` call.
    public func launchEnv() -> [String: String]? {
        guard let networkRoot else { return nil }
        var env = ProcessInfo.processInfo.environment
        env["ST_ROOT"] = networkRoot
        env["PTY_ROOT"] = networkRoot + "/pty"
        return env
    }

    /// Run `st launch … --dry-run` and return its output — the final wiring check before commit.
    @discardableResult
    public func dryRun() throws -> Shell.Result {
        try Shell.run("st", stLaunchArgs(dryRun: true), cwd: cwdURL, env: launchEnv())
    }

    /// Launch for real. Callers MUST run `preflight(bus:)` and confirm `.ok` first.
    @discardableResult
    public func launch() throws -> Shell.Result {
        try Shell.run("st", stLaunchArgs(dryRun: false), cwd: cwdURL, env: launchEnv(), check: false)
    }
}
