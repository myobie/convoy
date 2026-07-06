import Foundation
import ConvoyKit
import Combine

/// Polls the smalltalk bus (`st agents --json --enrich`, via ConvoyKit) on a timer and publishes
/// the members for the menubar dashboard. Read-only for v1 — actions (restart/unstick a parked
/// agent) are a follow-on.
@MainActor
final class NetworkModel: ObservableObject {
    @Published var agents: [Agent] = []
    @Published var lastError: String?
    @Published var lastRefresh: Date?
    @Published var hasLoaded = false

    private let bus = Bus()
    private var timer: Timer?
    private let interval: TimeInterval = 5

    /// Which network this dashboard watches — the `ST_ROOT` basename, or "default network".
    var networkLabel: String {
        guard let root = ProcessInfo.processInfo.environment["ST_ROOT"], !root.isEmpty else {
            return "default network"
        }
        return (root as NSString).lastPathComponent
    }

    var totalCount: Int { agents.count }

    /// The bus answered at least once and isn't currently erroring.
    var busReachable: Bool { hasLoaded && lastError == nil }

    /// Agents that count as parked: live presence but no activity for a while (stale heartbeat).
    /// Coarse heuristic for the at-a-glance flag; the durable watchdog refines this later.
    var parked: [Agent] {
        let now = Date().timeIntervalSince1970 * 1000
        let staleMs: Double = 15 * 60 * 1000 // 15 min
        return agents.filter { a in
            guard a.status.isLive, let last = a.lastActivity else { return false }
            return now - last > staleMs
        }
    }

    var liveCount: Int { agents.filter { $0.status.isLive }.count }

    func start() {
        refresh()
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        // Shell out off the main thread; publish back on main.
        Task.detached {
            do {
                let fetched = try Bus().agents(enrich: true)
                await MainActor.run {
                    self.agents = fetched.sorted { lhs, rhs in
                        (lhs.status.isLive ? 0 : 1, lhs.identity) < (rhs.status.isLive ? 0 : 1, rhs.identity)
                    }
                    self.lastError = nil
                    self.lastRefresh = Date()
                    self.hasLoaded = true
                }
            } catch {
                await MainActor.run {
                    self.lastError = "\(error)"
                    self.hasLoaded = true
                }
            }
        }
    }
}
