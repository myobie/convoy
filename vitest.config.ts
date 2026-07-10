import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // The bundled doctor fixtures (src/doctor/fixtures/**) ship their OWN node:test suites — they are the
    // code-under-test for the dev-task check, not convoy's own tests. Keep vitest from scanning them, else a
    // fixture's node:test file trips "No test suite found" under vitest's runner.
    exclude: [...configDefaults.exclude, "src/doctor/fixtures/**"],
  },
});
