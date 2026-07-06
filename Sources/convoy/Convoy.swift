import ArgumentParser
import ConvoyKit
import Foundation

/// convoy — the single front door to a smalltalk agent network.
///
/// It orchestrates the existing tools (smalltalk = bus, pty = sessions); it reimplements
/// neither. Everything you can misconfigure by hand, convoy derives correct-by-construction.
@main
struct Convoy: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "convoy",
        abstract: "Stand up and run your crew of agents.",
        discussion: """
        convoy ties smalltalk (the bus) and pty (the sessions) together: it launches agents with
        correct-by-construction wiring, lists the network, and checks that it will actually work
        here. Agents you add can't be misconfigured — permission mode, ENV, tags, transport, and
        hooks are all derived from high-level intent and validated before launch.
        """,
        version: "0.1.0",
        subcommands: [Ls.self, Doctor.self, Init.self, Add.self, Remove.self, Cos.self, App.self],
        defaultSubcommand: Ls.self
    )
}

/// Options shared by commands that operate against a specific network.
struct NetworkOptions: ParsableArguments {
    @Option(name: .long, help: "Network root (ST_ROOT). Defaults to st's default network.")
    var network: String?

    var bus: Bus { Bus(root: network) }
}

/// Small shared print helpers so CLI output reads consistently.
enum Out {
    static func err(_ s: String) { FileHandle.standardError.write(Data(("convoy: " + s + "\n").utf8)) }
    static func line(_ s: String = "") { print(s) }
    static func bullet(_ ok: Bool?, _ s: String) {
        let mark = ok == nil ? "•" : (ok! ? "✓" : "✗")
        print("  \(mark) \(s)")
    }
}
