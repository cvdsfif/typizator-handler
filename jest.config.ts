module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",

    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest'
    },
    verbose: true,
    collectCoverage: true,
    collectCoverageFrom: ['!tests/*', '!**/dist/**/*', '!tests/**/*'],
    coverageReporters: ['json-summary', 'text'],

};