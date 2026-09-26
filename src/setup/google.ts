// What setup needs from Google Cloud, as one small interface. The flow is
// written against this; a gcloud adapter implements it for real, and tests use
// an in-memory fake. Reads never change anything (design §4.1).

export type Billing = { state: 'missing' | 'suspended' | 'active'; trial: boolean; accountId?: string };

export type GoogleCloud = {
  // ── Reads ──
  signedInAccount(): Promise<string | undefined>;
  billing(): Promise<Billing>;
  blocksPublicServices(): Promise<boolean>;
  canCreateProject(): Promise<boolean>;
  findProject(): Promise<string | undefined>;
  billingLinked(project: string): Promise<boolean>;
  servicesReady(project: string): Promise<boolean>;
  budgetExists(project: string, billingAccount: string): Promise<boolean>;
  secretExists(project: string, name: string): Promise<boolean>;
  readSecret(project: string, name: string): Promise<string | undefined>;
  serverUrl(project: string): Promise<string | undefined>;
  // Version 1 (design §10): Cloud Shell's current project, and v1's service there.
  currentProject(): Promise<string | undefined>;
  v1Service(project: string): Promise<{ sentCopyMode: 'unverified' | 'yahoo' | 'append' } | undefined>;
  // The image the running server was started from (for Update's rollback).
  serverImage(project: string): Promise<string | undefined>;
  imageTrusted(image: string): Promise<boolean>;

  // ── Writes (step 3 onwards) ──
  createProject(): Promise<string>;
  linkBilling(project: string, billingAccount: string): Promise<void>;
  // Marks a project (version 1's) as Universal Mail's, so later runs find it.
  labelProject(project: string): Promise<void>;
  enableServices(project: string): Promise<void>;
  createBudget(project: string, billingAccount: string, dollars: number): Promise<void>;
  putSecret(project: string, name: string, value: string): Promise<void>;
  // Starts the server, then sets PUBLIC_URL to its own address (known only once it runs).
  startServer(project: string, image: string, settings: Record<string, string>): Promise<string>;
  // A new revision of the running server (it reads its settings when it
  // starts): one marker setting changes, so Cloud Run always makes one.
  restartServer(project: string, now: number): Promise<void>;
  // Remove Universal Mail: its $1 alarm, then the project and everything in it.
  deleteBudget(project: string, billingAccount: string): Promise<void>;
  deleteProject(project: string): Promise<void>;
};

// Google says "done" slightly before a change takes effect (design §4.2):
// thrown when a dependent step finds it isn't ready yet.
// Google refused, for a reason with a plain answer (billing, quota, a company policy).
export class GoogleRefusal extends Error {
  constructor(readonly code: 'SETUP-PROJECT-QUOTA' | 'SETUP-BILLING-SUSPENDED' | 'SETUP-BILLING-MISSING' | 'SETUP-ORG-POLICY') { super(code); }
}

export class NotReadyYet extends Error {
  constructor(readonly what: 'service' | 'permission') { super(`${what} not ready yet`); }
}
