// Metro defines `__DEV__` in every React Native bundle; Vitest does not. Without it, any test whose
// import chain reaches `expo` fails to load: `expo/build/async-require/setup` reads `__DEV__` on import
// (gils-studio/t3code#14). Tests that care about dev behaviour still stub it themselves
// (`vi.stubGlobal("__DEV__", true)`).
const globals = globalThis as { __DEV__?: boolean };
globals.__DEV__ ??= false;
