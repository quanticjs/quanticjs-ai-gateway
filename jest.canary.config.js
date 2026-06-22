/**
 * Out-of-band contract canaries (run on demand / scheduled — NEVER in `npm test` / PR CI).
 * They hit REAL external dependencies and assert response SHAPE only. Each canary self-skips
 * when its target env is absent, so this config is safe to run anywhere.
 * @type {import('jest').Config}
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.canary\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 120_000,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^jwks-rsa$': '<rootDir>/src/__mocks__/jwks-rsa.js',
  },
};
