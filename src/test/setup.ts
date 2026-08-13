import "@testing-library/jest-dom";

// This setup file runs for EVERY spec, including server ones that opt into the
// node environment (`// @vitest-environment node`) because they need Node's own
// fetch/AbortSignal. There is no window there, and stubbing matchMedia
// unguarded would crash collection before a single test ran.
if (typeof window !== "undefined") {
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
}
