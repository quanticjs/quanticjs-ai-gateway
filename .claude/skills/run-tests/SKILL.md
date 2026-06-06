# Run Tests

## Commands

```bash
# All tests
npm test

# Specific file
npx jest --testPathPattern=<pattern>

# Watch mode
npx jest --watch

# Build check
npm run build
```

## Test Order
1. Build (`npm run build`)
2. Unit tests (`npm test`)

## Rules
- Fix test failures before moving on
- Every new handler needs a spec file
