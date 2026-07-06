import XCTest
@testable import ConvoyKit
import Foundation

final class PersonasTests: XCTestCase {

    /// Run `body` with `CONVOY_PERSONAS_DIR` pointed at a fresh temp dir, then clean up.
    private func withTempPersonasDir(_ body: (String) throws -> Void) throws {
        let tmp = NSTemporaryDirectory() + "convoy-personas-test-" + UUID().uuidString
        setenv("CONVOY_PERSONAS_DIR", tmp, 1)
        defer {
            unsetenv("CONVOY_PERSONAS_DIR")
            try? FileManager.default.removeItem(atPath: tmp)
        }
        try body(tmp)
    }

    func testDirRespectsEnvOverride() throws {
        try withTempPersonasDir { tmp in
            XCTAssertEqual(Personas.dir(), tmp)
        }
    }

    func testNotInstalledWhenEmpty() throws {
        try withTempPersonasDir { _ in
            XCTAssertFalse(Personas.isInstalled())
            XCTAssertNil(Personas.baseFile(for: .worker))
        }
    }

    func testInstalledAndResolvesBaseFiles() throws {
        try withTempPersonasDir { tmp in
            try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
            for role in Role.allCases {
                try "persona".write(toFile: tmp + "/" + role.personaBaseFilename, atomically: true, encoding: .utf8)
            }
            XCTAssertTrue(Personas.isInstalled()) // chief-of-staff.md sentinel present
            XCTAssertEqual(Personas.baseFile(for: .worker), tmp + "/worker.md")
            XCTAssertEqual(Personas.baseFile(for: .chiefOfStaff), tmp + "/chief-of-staff.md")
        }
    }

    func testEnsureThrowsOnNonPersonasDir() throws {
        try withTempPersonasDir { tmp in
            try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
            // A non-empty dir that isn't a personas checkout must fail loud, never clobber.
            try "junk".write(toFile: tmp + "/unrelated.txt", atomically: true, encoding: .utf8)
            XCTAssertThrowsError(try Personas.ensureInstalled())
        }
    }
}
