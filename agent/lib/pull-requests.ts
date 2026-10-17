import { z } from "zod";

const pullRequestPathPattern = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/u;

function pullRequestParts(url: string): { repo: string; number: string } | null {
  const withScheme = /^https?:\/\//iu.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  if (!URL.canParse(withScheme)) return null;
  const parsed = new URL(withScheme);
  const match = pullRequestPathPattern.exec(parsed.pathname);
  if (!/^(www\.)?github\.com$/iu.test(parsed.hostname) || !match) return null;
  return { repo: `${match[1]}/${match[2]}`.toLowerCase(), number: match[3] };
}

export function pullRequestName(url: string): string {
  const parts = pullRequestParts(url);
  return parts ? `${parts.repo}#${parts.number}` : url;
}

export function samePullRequest(a: string, b: string): boolean {
  const left = pullRequestParts(a);
  const right = pullRequestParts(b);
  return left !== null && right !== null && left.repo === right.repo && left.number === right.number;
}

export const mergeMethodSchema = z.enum(["squash", "merge", "rebase"]);

export type MergeMethod = z.infer<typeof mergeMethodSchema>;

export function mergeRequest(url: string, method: MergeMethod): string {
  return [
    `The owner has reviewed ${url} and approved merging it.`,
    `Merge it now with a ${method} merge, exactly as it is: do not push any more commits first.`,
    "If GitHub will not merge it, for example because of failing required checks, conflicts or branch protection, do not work around it. Reply with one short message saying why.",
    "Once it is merged, reply with one short message saying so.",
  ].join("\n");
}
