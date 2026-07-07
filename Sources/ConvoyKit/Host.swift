import Foundation

/// One session as convoy's host sees it, decoded from `pty list --json`. The registry already
/// carries everything the reconcile loop needs — `tags` (incl. `strategy`, `ptyfile`,
/// `ptyfile.session`), `exitedAt`, `command`, `cwd`, `status` — so a single list call per tick
/// feeds the classifier.
public struct SupervisedSession: Sendable {
    public let name: String            // pty id (what `pty tag`/`pty kill` take)
    public let cwd: String?
    public let command: String         // the leaf command (fingerprint input)
    public let status: String?
    public let exitedAt: Date?         // when the gone leaf exited (nil if running/unknown)
    public let tags: [String: String]

    public init(name: String, cwd: String?, command: String, status: String?, exitedAt: Date?, tags: [String: String]) {
        self.name = name
        self.cwd = cwd
        self.command = command
        self.status = status
        self.exitedAt = exitedAt
        self.tags = tags
    }

    /// Alive statuses. Anything else (exited / crashed / vanished) is "gone" and eligible for the
    /// classifier. Conservative: a transient `starting` is NOT respawned.
    static let aliveStatuses: Set<String> = ["running", "starting"]

    public var strategy: StrategyTags { StrategyTags.parse(from: tags) }
    public var isPermanent: Bool { tags["strategy"] == "permanent" }
    public var isGone: Bool { !SupervisedSession.aliveStatuses.contains(status ?? "") }

    /// The directory holding this session's `pty.toml` (from the `ptyfile` tag), used to respawn it.
    public var ptyfileDir: String? {
        tags["ptyfile"].map { ($0 as NSString).deletingLastPathComponent }
    }
    /// The session key inside that `pty.toml` (e.g. `claude`, `phoenix`).
    public var ptyfileSession: String? { tags["ptyfile.session"] }

    /// The STABLE logical identity of this session across respawns — the `(ptyfile, ptyfile.session)`
    /// tag pair (per pty PR #45's decoupling). The pty `name` (id) can change across a respawn; this
    /// does not, so convoy keys its classifier state on this, not on `name`.
    public var logicalKey: String {
        if let f = tags["ptyfile"], let s = ptyfileSession { return f + "::" + s }
        return name
    }

    /// A human-readable STABLE logical id for events/logs — `<agent-dir>/<session-key>` derived from
    /// the persistent `ptyfile`/`ptyfile.session` tags (e.g. `convoy/claude`). Unlike the pty `name`
    /// (id, which churns) or a display label, this survives respawns and `pty kill`, so a consumer
    /// (the capstone eval's respawn gate) can bind to it. Falls back to the pty id if the tags are absent.
    public var logicalId: String {
        guard let session = ptyfileSession else { return name }
        let dir = (ptyfileDir ?? cwd).map { ($0 as NSString).lastPathComponent } ?? ""
        return dir.isEmpty ? session : dir + "/" + session
    }

    /// The current declared-command fingerprint. INTEGRATION NOTE: the registry exposes `command`
    /// as one joined string, so convoy hashes it as `command` with empty args. It is self-consistent
    /// across ticks (all that divergence-detection needs); the exact command/args split binds to
    /// `pty.toml` parsing (`readPtyFile`) at the reboot cutover.
    public var commandHash: String { FlappingCap.commandFingerprint(command: command, args: []) }
}

/// Drives the `pty` CLI to host a network's sessions — list / tag / spawn / kill. convoy is Swift,
/// so it drives pty through its CLI (not the TS `@myobie/pty/client`); the CLI surface
/// (`pty list --json`, `pty tag`, `pty up`, `pty kill`) covers the whole reconcile loop.
public struct PtyHost {
    /// The network root (ST_ROOT). `PTY_ROOT` is `<root>/pty`. `nil` = pty's default registry.
    public let root: String?

    public init(root: String?) { self.root = root }

    private func env() -> [String: String]? {
        guard let root else { return nil }
        var e = ProcessInfo.processInfo.environment
        e["PTY_ROOT"] = root + "/pty"
        return e
    }

    private struct Registry: Decodable {
        let name: String
        let status: String?
        let command: String?
        let cwd: String?
        let exitedAt: String?
        let tags: [String: String]?
    }

    /// Every session in the network's pty registry, decoded for supervision.
    public func sessions() -> [SupervisedSession] {
        guard let r = try? Shell.run("pty", ["list", "--json"], env: env(), check: false), r.ok else { return [] }
        let regs = (try? JSONDecoder().decode([Registry].self, from: Data(r.stdout.utf8))) ?? []
        return regs.map {
            SupervisedSession(
                name: $0.name,
                cwd: $0.cwd,
                command: $0.command ?? "",
                status: $0.status,
                exitedAt: $0.exitedAt.flatMap { StrategyTags.isoDate($0) },
                tags: $0.tags ?? [:]
            )
        }
    }

    /// The permanent sessions convoy supervises on this network.
    public func permanentSessions() -> [SupervisedSession] {
        sessions().filter { $0.isPermanent }
    }

    /// Write `strategy.*` bookkeeping tags (spec §5.3: persist BEFORE respawn).
    @discardableResult
    public func setTags(_ name: String, _ kv: [String: String]) -> Bool {
        guard !kv.isEmpty else { return true }
        let pairs = kv.map { "\($0.key)=\($0.value)" }
        return (try? Shell.run("pty", ["tag", name] + pairs, env: env(), check: false))?.ok ?? false
    }

    @discardableResult
    public func removeTag(_ name: String, _ key: String) -> Bool {
        (try? Shell.run("pty", ["tag", name, "--rm", key], env: env(), check: false))?.ok ?? false
    }

    /// Respawn a gone session IN PLACE by its id — re-runs its command keeping the same session
    /// (stable identity). INTEGRATION SEAM: today `pty restart -y <name>`; post-cutover (pty's
    /// daemon removed) it becomes a foreground `spawnDaemon()`-equivalent child-spawn so the
    /// `convoy up` process is the TCC anchor by construction. convoy's caller is identical either
    /// way — only the pty verb binds at the reboot.
    @discardableResult
    public func respawn(_ name: String) -> Bool {
        (try? Shell.run("pty", ["restart", "-y", name], env: env(), check: false))?.ok ?? false
    }

    // (Removed `bringUp` — it wrapped `pty up`, which the pty §3.4-B cutover deleted. It was unused:
    //  convoy up reconciles EXISTING registered sessions via `respawn` (pty restart); sessions are
    //  created by `convoy add` → st launch → pty run, not by convoy up.)

    @discardableResult
    public func kill(_ name: String) -> Bool {
        (try? Shell.run("pty", ["kill", name], env: env(), check: false))?.ok ?? false
    }
}
