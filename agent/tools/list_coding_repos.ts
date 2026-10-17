import { defineTool } from "eve/tools";
import { z } from "zod";

import { listCodingRepos } from "#lib/devin.js";
import { env } from "#lib/env.js";

export default defineTool({
  description:
    "List the GitHub repos the coding agent can work in, as owner/name, with a description. " +
    "Use it to find the repo the user means when they name one loosely.",
  inputSchema: z.object({
    filter: z
      .string()
      .min(1)
      .optional()
      .describe("Part of the repo name to match. Omit it to list them all."),
    limit: z.number().int().min(1).max(100).default(50).describe("How many repos to return."),
  }),
  async execute({ filter, limit }) {
    return { yours: env.selfRepo ?? null, repos: await listCodingRepos(filter, limit) };
  },
});
