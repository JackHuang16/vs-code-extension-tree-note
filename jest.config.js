/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/src/**/*.test.ts"],
  moduleNameMapper: {
    "^vscode$": "<rootDir>/src/test/mocks/vscode.ts",
  },
  verbose: true,
};
