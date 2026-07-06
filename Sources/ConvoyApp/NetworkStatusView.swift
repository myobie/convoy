import SwiftUI
import ConvoyKit

/// The menubar popover: convoys + CoS + agents at a glance, parked flags, and the keep-awake
/// toggle. Read-only status for v1 (IDEA.md: actions come later).
struct NetworkStatusView: View {
    @ObservedObject var model: NetworkModel
    @ObservedObject var keepAwake: KeepAwake
    @ObservedObject var host: HostController

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header

            Divider()

            if let err = model.lastError {
                Label(err, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .lineLimit(3)
            }

            if model.agents.isEmpty {
                Text("No members on this network yet.\nAdd one with `convoy add <role> --identity <id>`.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(model.agents) { agent in
                            AgentRow(agent: agent, parked: model.parked.contains { $0.identity == agent.identity })
                        }
                    }
                }
                .frame(maxHeight: 320)
            }

            Divider()
            footer
        }
        .padding(12)
        .frame(width: 300)
    }

    private var header: some View {
        HStack {
            Image(systemName: "point.3.connected.trianglepath.dotted")
            Text("Convoy").font(.headline)
            Spacer()
            Text("\(model.liveCount) live")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.parked.isEmpty {
                Label("\(model.parked.count) parked", systemImage: "moon.zzz")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            hostSection

            Toggle(isOn: Binding(get: { keepAwake.enabled },
                                 set: { _ in keepAwake.toggle() })) {
                Label("Keep Mac awake", systemImage: "bolt.fill")
            }
            .toggleStyle(.switch)
            .font(.caption)

            HStack {
                Button("Refresh") { model.refresh() }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
            .font(.caption)
        }
    }

    /// Host the configured network under the app (the TCC anchor). Hosting also keeps the Mac
    /// awake — a hosted network shouldn't be paused by sleep.
    @ViewBuilder
    private var hostSection: some View {
        if host.canHost {
            Toggle(isOn: Binding(get: { host.isHosting },
                                 set: { on in
                                     host.toggle()
                                     if on { keepAwake.enable() }
                                 })) {
                Label(host.isHosting ? "Hosting network" : "Host network",
                      systemImage: "externaldrive.connected.to.line.below")
            }
            .toggleStyle(.switch)
            .font(.caption)
        } else {
            Label("No hosted network (set CONVOY_HOST_DIR)", systemImage: "externaldrive.badge.questionmark")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        if let err = host.lastError {
            Text(err).font(.caption2).foregroundStyle(.orange).lineLimit(2)
        }
    }
}

private struct AgentRow: View {
    let agent: Agent
    let parked: Bool

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(agent.label)
                .font(.system(.body, design: .rounded))
                .lineLimit(1)
            Spacer()
            if parked {
                Image(systemName: "moon.zzz").foregroundStyle(.orange).font(.caption2)
            }
            if let inbox = agent.inbox, inbox > 0 {
                Text("\(inbox)")
                    .font(.caption2)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(.secondary.opacity(0.2)))
            }
            Text(agent.status.rawValue)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var color: Color {
        if parked { return .orange }
        switch agent.status {
        case .available: return .green
        case .busy: return .blue
        case .away, .dnd: return .yellow
        case .offline, .unknown: return .gray
        }
    }
}
