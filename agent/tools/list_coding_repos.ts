import { defineTool } from "eve/tools";
import { z } from "zod";

import { codingProviderNames } from "#lib/coding-agent.js";
import { listCodingRepos } from "#lib/coding-agents.js";
import { env } from "#lib/env.js";

export default defineTool({
  description:
    "List the GitHub repos the coding agent can work in, as owner/name, with a description. " +
    "Use it when the user asks what it can work on; starting a session does not need it.",
  inputSchema: z.object({
    filter: z
      .string()
      .min(1)
      .optional()
      .describe("Part of the repo name to match. Omit it to list them all."),
    limit: z.number().int().min(1).max(100).default(50).describe("How many repos to return."),
    provider: z
      .enum(codingProviderNames)
      .optional()
      .describe("Which provider's repos to list. Omit it for the configured default."),
  }),
  async execute({ filter, limit, provider }) {
    return { yours: env.selfRepo ?? null, repos: await listCodingRepos(filter, limit, provider) };
  },
});
