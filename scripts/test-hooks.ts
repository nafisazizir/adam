import { registerHooks } from "node:module";

// Authored code imports `.js` specifiers that only exist as `.ts` until eve builds them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.endsWith(".js")) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
