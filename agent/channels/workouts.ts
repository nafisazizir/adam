import { timingSafeEqual } from "node:crypto";

import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";

import { env, workoutsAnalyzePath, workoutsHevyPath, workoutsNudgePath, workoutsStravaPath } from "#lib/env.js";
import { homeDelivery } from "#lib/delivery.js";
import { readHomeTarget } from "#lib/home-target.js";
import {
  alreadyAnalysedMarker,
  analysisMessage,
  debriefMessage,
  skippedStravaSportTypes,
  workoutAddress,
  workoutAuth,
  workoutAuthenticator,
  workoutRefSchema,
} from "#lib/workouts.js";
import { callRizMcpTool } from "#lib/riz-mcp.js";
import { publishCallback, verifyCallbackSignature } from "#lib/qstash.js";

const stravaEventSchema = z.object({
  object_type: z.string(),
  object_id: z.number(),
  aspect_type: z.string(),
  owner_id: z.number(),
  subscription_id: z.number(),
  event_time: z.number().optional(),
  updates: z.record(z.string(), z.unknown()).optional(),
});

const hevyEventSchema = z.object({ workoutId: z.string() });
const nudgeSchema = workoutRefSchema.extend({ debrief: z.string().min(1) });

function authMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;

  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

async function hasValidCallbackSignature(
  signature: string,
  body: string,
  url: string,
): Promise<boolean> {
  try {
    return await verifyCallbackSignature({ signature, body, url });
  } catch {
    return false;
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export default defineChannel({
  routes: [
    GET(workoutsStravaPath, async (request) => {
      const url = new URL(request.url);
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
        console.log("[workouts] Strava subscription verified");
        return Response.json({ "hub.challenge": challenge });
      }

      console.warn("[workouts] Strava verification rejected");
      return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    }),
    POST(workoutsStravaPath, async (request) => {
      const parsed = stravaEventSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        console.warn("[workouts] rejected malformed Strava payload");
        return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
      }

      const event = parsed.data;
      if (
        !env.STRAVA_WEBHOOK_SUBSCRIPTION_ID ||
        String(event.subscription_id) !== env.STRAVA_WEBHOOK_SUBSCRIPTION_ID
      ) {
        console.warn(
          `[workouts] ignoring Strava event from subscription ${event.subscription_id}`,
        );
        return Response.json({ ok: true, ignored: "subscription_mismatch" });
      }

      if (event.object_type !== "activity" || event.aspect_type !== "create") {
        return Response.json({
          ok: true,
          ignored: `${event.object_type}/${event.aspect_type}`,
        });
      }

      const ref = { source: "strava" as const, id: String(event.object_id) };
      try {
        await publishCallback({
          url: env.workoutsAnalyzeUrl,
          body: ref,
          deduplicationId: `${ref.source}-${ref.id}`,
        });
      } catch (error) {
        console.error(`[workouts] failed to queue Strava activity ${ref.id}`, error);
        return Response.json({ ok: false, error: "publish_failed" }, { status: 500 });
      }

      console.log(`[workouts] accepted Strava activity ${ref.id}`);
      return Response.json({ ok: true, id: ref.id });
    }),
    POST(workoutsHevyPath, async (request) => {
      if (!authMatches(request.headers.get("authorization"), env.HEVY_WEBHOOK_SECRET)) {
        console.warn("[workouts] rejected Hevy webhook with bad authorization");
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }

      const parsed = hevyEventSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        console.warn("[workouts] rejected malformed Hevy payload");
        return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
      }

      const ref = { source: "hevy" as const, id: parsed.data.workoutId };
      try {
        await publishCallback({
          url: env.workoutsAnalyzeUrl,
          body: ref,
          deduplicationId: `${ref.source}-${ref.id}`,
        });
      } catch (error) {
        console.error(`[workouts] failed to queue Hevy workout ${ref.id}`, error);
        return Response.json({ ok: false, error: "publish_failed" }, { status: 500 });
      }

      console.log(`[workouts] accepted Hevy workout ${ref.id}`);
      return Response.json({ ok: true, id: ref.id });
    }),
    POST(workoutsAnalyzePath, async (request, { from, resolveSession }) => {
      const body = await request.text();
      if (
        !(await hasValidCallbackSignature(
          request.headers.get("upstash-signature") ?? "",
          body,
          env.workoutsAnalyzeUrl,
        ))
      ) {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }

      const parsed = workoutRefSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        console.warn("[workouts] rejected malformed analyze callback");
        return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
      }

      const ref = parsed.data;
      const address = workoutAddress(ref);
      if (await resolveSession(address)) {
        console.log(`[workouts] skipping already analysed workout ${address}`);
        return Response.json({ ok: true, ignored: "already_analysed" });
      }

      const home = await readHomeTarget();
      if (!home) {
        console.warn(`[workouts] skipping ${address}; no home owner is stored to act as`);
        return Response.json({ ok: true, ignored: "no_home_target" });
      }

      try {
        if (ref.source === "strava") {
          const result = await callRizMcpTool("strava_get_activity", {
            id: Number(ref.id),
          });
          const activity =
            typeof result === "object" && result !== null
              ? (result as { sport_type?: unknown; type?: unknown })
              : {};
          const sportType = activity.sport_type ?? activity.type;

          if (typeof sportType === "string" && skippedStravaSportTypes.has(sportType)) {
            console.log(
              `[workouts] skipping Strava activity ${ref.id} (sport_type=${sportType})`,
            );
            return Response.json({ ok: true, ignored: "skipped_sport_type" });
          }
        }

        await from(address).send(analysisMessage(ref), { auth: workoutAuth(ref, home.owner) });
      } catch (error) {
        console.error(`[workouts] failed to analyse workout ${address}`, error);
        return Response.json({ ok: false, error: "analysis_failed" }, { status: 500 });
      }

      console.log(`[workouts] started analysis for ${address}`);
      return Response.json({ ok: true, address });
    }),
    POST(workoutsNudgePath, async (request, { to }) => {
      const body = await request.text();
      if (
        !(await hasValidCallbackSignature(
          request.headers.get("upstash-signature") ?? "",
          body,
          env.workoutsNudgeUrl,
        ))
      ) {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }

      const parsed = nudgeSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        console.warn("[workouts] rejected malformed nudge callback");
        return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
      }

      const { source, id, debrief } = parsed.data;
      const ref = { source, id };
      const home = await homeDelivery();
      if (!home) {
        console.warn("[workouts] skipping debrief; no home delivery target is stored");
        return Response.json({ ok: true, ignored: "no_home_target" });
      }
      const { channel, target, owner } = home;

      try {
        await channel.deliver({
          to,
          message: debriefMessage(debrief),
          target,
          auth: workoutAuth(ref, owner),
          turnPolicy: "queue",
        });
      } catch (error) {
        console.error(`[workouts] failed to deliver debrief for ${workoutAddress(ref)}`, error);
        return Response.json({ ok: false, error: "delivery_failed" }, { status: 500 });
      }

      console.log(`[workouts] delivered debrief for ${workoutAddress(ref)}`);
      return Response.json({ ok: true });
    }),
  ],
  events: {
    async "message.completed"(event, _channel, ctx) {
      if (
        event.finishReason === "tool-calls" ||
        !event.message?.trim() ||
        event.message.trim().startsWith(alreadyAnalysedMarker)
      ) {
        return;
      }

      const initiator = ctx.session.auth.initiator;
      if (!initiator || initiator.authenticator !== workoutAuthenticator) return;

      const parsed = workoutRefSchema.safeParse({
        source: initiator.attributes.source,
        id: initiator.attributes.id,
      });
      if (!parsed.success) {
        console.warn("[workouts] completed workout session has invalid initiator attributes");
        return;
      }

      const ref = parsed.data;
      try {
        await publishCallback({
          url: env.workoutsNudgeUrl,
          body: { ...ref, debrief: event.message },
          deduplicationId: `nudge-${ref.source}-${ref.id}`,
        });
      } catch (error) {
        console.error(`[workouts] failed to queue debrief for ${workoutAddress(ref)}`, error);
        throw error;
      }
    },
  },
});
