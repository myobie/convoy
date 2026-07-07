import Foundation

/// The single-owner guard for a hosted network — `<root>/convoy.pid`. One convoy (CLI `convoy up`
/// OR the menubar app) may host a network at a time; two hosts double-spawn every agent. Both the
/// CLI and the app go through THIS type so the check + the warning are identical (symmetric).
public struct HostLock {
    /// The network root (ST_ROOT). The lock file is `<root>/convoy.pid`.
    public let root: String

    public init(root: String) { self.root = root }

    public var pidPath: String { root + "/convoy.pid" }

    /// The pid of a *live* convoy already hosting this network, or `nil` (no lock, stale lock, or us).
    public func liveOwner() -> Int32? {
        guard let raw = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid != getpid()
        else { return nil }
        // `kill(pid, 0)` sends no signal — it just probes whether the process exists.
        return kill(pid, 0) == 0 ? pid : nil
    }

    /// True if a lock file exists but its owner is dead (a crashed host left it behind).
    public func hasStaleLock() -> Bool {
        FileManager.default.fileExists(atPath: pidPath) && liveOwner() == nil
    }

    /// Write our pid as the owner. Call only after `liveOwner() == nil`. Creates `root` if missing.
    public func acquire() throws {
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        try String(getpid()).write(toFile: pidPath, atomically: true, encoding: .utf8)
    }

    /// Remove the lock — but only if it is still ours (never clobber a live successor's lock).
    public func release() {
        if let raw = try? String(contentsOfFile: pidPath, encoding: .utf8),
           Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)) == getpid() {
            try? FileManager.default.removeItem(atPath: pidPath)
        }
    }

    /// The one clear, actionable warning shown by BOTH the CLI and the app when another host owns
    /// this network. Explains WHAT is wrong, WHY it matters, and HOW to fix it.
    public func busyWarning(owner pid: Int32) -> String {
        """
        another convoy is already hosting this network (pid \(pid)) — refusing to start.
        Two hosts on one network double-spawn every agent. Stop the other host first.
        If it is already gone, clear the stale lock:  rm \(pidPath)
        """
    }
}
