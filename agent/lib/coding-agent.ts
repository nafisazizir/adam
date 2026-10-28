export const codingProviderNames = ["devin", "cursor"] as const;

export type CodingProviderName = (typeof codingProviderNames)[number];

export interface CodingPullRequest {
  readonly url: string;
  readonly state: string | null;
}

export interface CodingBranch {
  readonly repo: string;
  readonly branch: string;
}

export interface CodingSession {
  readonly id: string;
  readonly provider: CodingProviderName;
  readonly url: string;
  readonly title: string | null;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly archived: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly pullRequests: readonly CodingPullRequest[];
  readonly branches: readonly CodingBranch[];
}

export interface CodingRepo {
  readonly name: string;
  readonly description: string | null;
  readonly language: string | null;
}

export interface CodingSessionMessage {
  readonly id: string;
  readonly from: "agent" | "user";
  readonly text: string;
  readonly at: Date;
}

export interface CreateCodingSession {
  readonly prompt: string;
  readonly title: string;
  readonly repos: readonly string[];
  readonly idempotencyKey: string;
}

// One vendor's HTTP failure. A 4xx other than timeout or rate limit will not start working on retry,
// so the watch stops instead of spending its failure budget on it.
export class CodingAgentError extends Error {
  readonly status: number;
  readonly provider: CodingProviderName;

  constructor(provider: CodingProviderName, message: string, status: number) {
    super(message);
    this.name = "CodingAgentError";
    this.provider = provider;
    this.status = status;
  }

  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface CodingAgentProvider {
  readonly name: CodingProviderName;
  createSession(input: CreateCodingSession): Promise<CodingSession>;
  getSession(id: string): Promise<CodingSession>;
  listSessions(limit: number): Promise<CodingSession[]>;
  listRepos(filter: string | undefined, limit: number): Promise<CodingRepo[]>;
  listMessages(id: string): Promise<CodingSessionMessage[]>;
  sendMessage(id: string, message: string): Promise<CodingSession>;
  stopSession(id: string): Promise<CodingSession>;
}
