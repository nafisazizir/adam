import { resolve } from "node:path";

import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

const clip = resolve("evals/media/red-clip.mp4");

export default defineEval({
  description: "A video the user sends is watched: the model sees its frames and hears what is said.",
  tags: ["media"],
  async test(t) {
    const session = await t.session();
    const turn = await session.sendFile("what colour is this and what's the dog called", clip, "video/mp4");
    t.succeeded();
    t.calledTool("watch_video");
    t.check(turn.message ?? "", matches(z.string().regex(/red/iu, "does not name the colour")));
    t.check(turn.message ?? "", matches(z.string().regex(/biscuit/iu, "does not name the dog")));
  },
});
