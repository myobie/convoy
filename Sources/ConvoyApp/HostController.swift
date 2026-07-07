import Foundation
import ConvoyKit
import Combine

/// Hosts a network's pty sessions **under the app** — the TCC crux (IDEA.md Part 4).
///
/// `pty up <dir>` spawns the session daemon(s); because the app runs it via `Process` (which does
/// NOT disclaim responsibility), the app becomes the daemons' *responsible process*, and that
/// responsible-pid is cached at spawn time and survives the daemon re-parenting to launchd
/// (empirically confirmed for user-content grants; FDA/Calendar pending a final probe). So agents
/// hosted this way inherit the app's grants — the reason the menubar app exists.
///
/// Degrades gracefully: if grants don't inherit, this still usefully brings the network up/down
/// from the menubar, and the dashboard + keep-awake work regardless.
@MainActor
final class HostController: ObservableObject {
    @Published private(set) var isHosting = false
    @Published var hostedDir: String?
    @Published var lastError: String?

    private let defaultsKey = "convoy.hostedDir"

    /// The network root whose single-owner lock this app shares with `convoy up` (CLI). Derived from
    /// CONVOY_HOST_NETWORK, else ST_ROOT, else st's default — so the CLI and the app guard the SAME
    /// `<root>/convoy.pid` and can never both host one network (which would double-spawn every agent).
    private var networkRoot: String {
        let env = ProcessInfo.processInfo.environment
        if let r = env["CONVOY_HOST_NETWORK"], !r.isEmpty { return r }
        if let r = env["ST_ROOT"], !r.isEmpty { return r }
        return (env["HOME"] ?? NSHomeDirectory()) + "/.local/state/smalltalk"
    }
    private var hostLock: HostLock { HostLock(root: networkRoot) }

    init() {
        if let env = ProcessInfo.processInfo.environment["CONVOY_HOST_DIR"], !env.isEmpty {
            hostedDir = env
        } else {
            hostedDir = UserDefaults.standard.string(forKey: defaultsKey)
        }
    }

    /// Whether a directory is configured to host (has a pty.toml to bring up).
    var canHost: Bool {
        guard let dir = hostedDir, !dir.isEmpty else { return false }
        return FileManager.default.fileExists(atPath: dir + "/pty.toml")
    }

    func setHostedDir(_ path: String?) {
        hostedDir = path
        UserDefaults.standard.set(path, forKey: defaultsKey)
    }

    /// Bring the hosted network up under this app (`pty up <dir>`).
    func start() {
        guard let dir = hostedDir, !dir.isEmpty else {
            lastError = "No hosted directory set — set CONVOY_HOST_DIR to a folder with a pty.toml."
            return
        }
        // Symmetric single-owner guard with `convoy up` (CLI): if another convoy already hosts this
        // network, refuse with the SAME clear warning rather than double-spawn every agent.
        if let owner = hostLock.liveOwner() {
            lastError = hostLock.busyWarning(owner: owner)
            return
        }
        try? hostLock.acquire()
        // NOTE: `pty up`/`pty down` were removed from pty (§3.4-B cutover) — these calls now fail
        // (graceful: lastError is surfaced). This whole app is moving to the `convoy-macos` repo and
        // being redesigned to run `convoy up <network>` as its child (the §6.1 "app = Mac always-on
        // host" model), which replaces this pty up/down hosting. Non-reboot-critical (kitty hosts the
        // reboot); tracked with the TS-port / convoy-macos split.
        Task.detached {
            let result = try? Shell.run("pty", ["up", dir], check: false)
            await MainActor.run {
                if let result, result.ok {
                    self.isHosting = true
                    self.lastError = nil
                } else {
                    self.hostLock.release() // didn't actually host → drop the lock
                    self.lastError = result?.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                        ?? "pty up failed"
                }
            }
        }
    }

    /// Take the hosted network down (`pty down <dir>`).
    func stop() {
        guard let dir = hostedDir, !dir.isEmpty else { return }
        Task.detached {
            _ = try? Shell.run("pty", ["down", dir], check: false)
            await MainActor.run {
                self.hostLock.release()
                self.isHosting = false
            }
        }
    }

    func toggle() { isHosting ? stop() : start() }
}
