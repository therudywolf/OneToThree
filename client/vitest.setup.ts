// Registers @testing-library/jest-dom matchers (toBeDisabled, toBeVisible, …)
// for component tests. Side-effect-only; harmless for the node-environment unit
// tests since the matchers are only invoked from jsdom component tests.
import '@testing-library/jest-dom/vitest'
