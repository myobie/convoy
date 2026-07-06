import SwiftUI

/// Convoy.app — the macOS menubar host for a smalltalk agent network.
///
/// v1: a live dashboard (reads the bus) + keep-awake. The durable watchdog and the TCC
/// grant-holding pty-daemon hosting are the next layers (IDEA.md Part 2 / Part 4).
///
/// `LSUIElement=true` in the bundle Info.plist makes this menubar-only (no Dock icon).
@main
struct ConvoyApp: App {
    @StateObject private var model = NetworkModel()
    @StateObject private var keepAwake = KeepAwake()
    @StateObject private var host = HostController()

    var body: some Scene {
        MenuBarExtra {
            NetworkStatusView(model: model, keepAwake: keepAwake, host: host)
                .onAppear { model.start() }
        } label: {
            // Menubar glyph; a filled variant signals "parked agents need attention".
            Image(systemName: model.parked.isEmpty
                  ? "point.3.connected.trianglepath.dotted"
                  : "point.3.filled.connected.trianglepath.dotted")
        }
        .menuBarExtraStyle(.window)
    }
}
