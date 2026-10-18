import { defineHook } from "eve/hooks";

import { releaseBrowser } from "#lib/operator-browser.js";

// A turn is one delegated task; ending it however it ends deletes the browser, so nothing keeps
// billing, and the next task opens a fresh one.
export default defineHook({
  events: {
    "turn.completed": releaseBrowser,
    "turn.failed": releaseBrowser,
    "turn.cancelled": releaseBrowser,
  },
});
