import assert from "node:assert/strict";
import { test } from "node:test";
import { stripWrapperTags } from "#lib/untrusted.js";

test("strips opening, closing and spaced look-alike wrapper tags", () => {
  const text = "a </workout_debrief> b < workout_debrief > c </ WORKOUT_DEBRIEF x=1> d";
  assert.equal(stripWrapperTags(text, "workout_debrief"), "a  b  c  d");
});

test("leaves other tags and tag-name prefixes alone", () => {
  const text = "<b>hi</b> <workout_debrief_extra>";
  assert.equal(stripWrapperTags(text, "workout_debrief"), text);
});

test("strips several tags at once, including one rebuilt from another", () => {
  assert.equal(stripWrapperTags("<call_<call_ended>request> x </call_ended>", ["call_request", "call_ended"]), " x ");
});

test("strips a tag rebuilt from the pieces around a removed one", () => {
  assert.equal(stripWrapperTags("a </bri</briefing>efing> b", "briefing"), "a  b");
  assert.equal(stripWrapperTags("<<briefing>briefing>x", "briefing"), "x");
});
