import { defineHook } from "eve/hooks";

import { releaseBrowser } from "#lib/operator-browser.js";

// A turn is one delegated task, so its end deletes the browser and the next task opens a fresh
// one. A session that fails outright emits no turn event; Kernel's idle timeout covers that.
export default defineHook({
  events: {
    "turn.completed": releaseBrowser,
    "turn.failed": releaseBrowser,
    "turn.cancelled": releaseBrowser,
  },
});
