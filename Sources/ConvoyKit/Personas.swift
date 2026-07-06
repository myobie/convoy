import Foundation

/// The base personas convoy installs (the public `myobie/personas` repo). Setup shouldn't be a
/// footgun: if the repo isn't present, convoy clones it rather than failing to resolve a role's
/// persona. Single source of truth for where personas live and how to obtain them.
public enum Personas {
    /// The public repo cloned to `dir()`. Public → a plain `git clone` needs no auth.
    public static let repoURL = "https://github.com/myobie/personas.git"

    /// Where role-base personas live: `$CONVOY_PERSONAS_DIR`, else the conventional repo path.
    public static func dir() -> String {
        if let dir = ProcessInfo.processInfo.environment["CONVOY_PERSONAS_DIR"], !dir.isEmpty {
            return dir
        }
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        return home + "/src/github.com/myobie/personas"
    }

    /// The base persona file for a role, if present on disk.
    public static func baseFile(for role: Role) -> String? {
        let candidate = dir() + "/" + role.personaBaseFilename
        return FileManager.default.fileExists(atPath: candidate) ? candidate : nil
    }

    /// Installed = the directory exists and carries the role bases (chief-of-staff.md as sentinel).
    public static func isInstalled() -> Bool {
        FileManager.default.fileExists(atPath: dir() + "/chief-of-staff.md")
    }

    /// The outcome of an `ensureInstalled` call, so callers can message the user precisely.
    public enum EnsureResult: Sendable {
        case alreadyPresent
        case cloned(String)
    }

    /// Ensure the personas repo is present, cloning it if missing. Idempotent. Throws (fail loud)
    /// if the target exists but isn't a personas checkout, or the clone fails.
    @discardableResult
    public static func ensureInstalled(log: (String) -> Void = { _ in }) throws -> EnsureResult {
        if isInstalled() { return .alreadyPresent }

        let target = dir()
        let fm = FileManager.default
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: target, isDirectory: &isDir) {
            // Present but not a personas checkout (no chief-of-staff.md). Don't clobber — fail loud.
            let contents = (try? fm.contentsOfDirectory(atPath: target)) ?? []
            if !contents.isEmpty {
                throw ConvoyError(
                    "\(target) exists but has no personas — remove it or set CONVOY_PERSONAS_DIR to a personas checkout")
            }
        } else {
            // Make sure the parent exists so git can create the target.
            let parent = (target as NSString).deletingLastPathComponent
            try fm.createDirectory(atPath: parent, withIntermediateDirectories: true)
        }

        log("cloning personas → \(target)")
        let result = try Shell.run("git", ["clone", "--depth", "1", repoURL, target], check: false)
        guard result.ok else {
            throw ConvoyError("failed to clone personas (\(repoURL)): "
                + result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return .cloned(target)
    }
}
