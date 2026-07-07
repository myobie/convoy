import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy ls` — list the convoy's members at a glance.
struct Ls: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "List the convoy's members (identity, status, inbox, last seen)."
    )

    @OptionGroup var net: NetworkOptions

    @Flag(name: .long, help: "Only show live members (available/busy/away/dnd).")
    var liveOnly = false

    @Flag(name: .long, help: "Emit the member list as JSON (convoy's enriched schema; respects --live-only).")
    var json = false

    func run() throws {
        let agents = try net.bus.agents(enrich: true)
        let shown = liveOnly ? agents.filter { $0.status.isLive } : agents

        if json {
            let data = try JSONEncoder().encode(shown)
            print(String(decoding: data, as: UTF8.self))
            return
        }

        guard !shown.isEmpty else {
            Out.line("No members\(liveOnly ? " live" : "") on this network.")
            return
        }

        let nameW = max(8, shown.map { $0.identity.count }.max() ?? 8)
        let statusW = max(6, shown.map { $0.status.rawValue.count }.max() ?? 6)
        Out.line("\(pad("IDENTITY", nameW))  \(pad("STATUS", statusW))  INBOX  LAST SEEN")
        for a in shown.sorted(by: { ($0.status.isLive ? 0 : 1, $0.identity) < ($1.status.isLive ? 0 : 1, $1.identity) }) {
            let inbox = a.inbox.map(String.init) ?? "-"
            Out.line("\(pad(a.identity, nameW))  \(pad(a.status.rawValue, statusW))  \(pad(inbox, 5))  \(ago(a.lastActivity))")
        }

        let live = shown.filter { $0.status.isLive }.count
        Out.line()
        Out.line("\(shown.count) member\(shown.count == 1 ? "" : "s"), \(live) live.")
    }

    private func pad(_ s: String, _ w: Int) -> String {
        s.count >= w ? s : s + String(repeating: " ", count: w - s.count)
    }

    /// Coarse "time since" from a fractional-ms epoch. No wall-clock dependency beyond `Date()`.
    private func ago(_ ms: Double?) -> String {
        guard let ms else { return "never" }
        let seconds = Date().timeIntervalSince1970 - ms / 1000.0
        if seconds < 0 { return "just now" }
        if seconds < 60 { return "\(Int(seconds))s ago" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h ago" }
        return "\(Int(seconds / 86400))d ago"
    }
}
