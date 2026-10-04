import { defineAgent } from "eve";

export default defineAgent({
  description:
    "The user's personal performance coach, with their Strava, Garmin and Hevy data and their Notion training plan. Use for post-workout analyses (it writes the full analysis to Notion and returns a short debrief) and for deeper training questions: how a session went, weekly reviews, progression checks, recovery or overtraining.",
  model: "openai/gpt-6.1-sol",
});
