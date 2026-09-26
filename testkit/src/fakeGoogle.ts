import { NotReadyYet, type Billing, type GoogleCloud } from '../../src/setup/google.js';

export type Call = { name: string; write: boolean };
export class Interrupted extends Error { constructor() { super('interrupted (tab closed)'); } }

export type FakeGoogleOptions = {
  account?: string;
  billing?: Billing;
  blocksPublicServices?: boolean;
  canCreateProject?: boolean;
  // Services report ready this long after being turned on.
  servicesReadyAfterMs?: number;
  // The server identity's permissions reach the server this many attempts late.
  permissionLateAttempts?: number;
  trustedImages?: string[];
  // Google refuses this change (billing closed, quota, a company policy).
  refuse?: Partial<Record<keyof GoogleCloud, Error>>;
  clock?: { now(): number };
  // A version 1 deployment in Cloud Shell's current project (design §10).
  v1?: { project: string; email: string; password: string; sentCopyMode: 'unverified' | 'yahoo' | 'append' };
};

// Google Cloud, in memory. Records every call; refuses a duplicate create as
// the real one would; can be told to stop after the Nth change (the tab closed).
export function createFakeGoogle(options: FakeGoogleOptions = {}) {
  const clock = options.clock ?? { now: () => 0 };
  const calls: Call[] = [];
  const state = {
    project: undefined as string | undefined,
    billingLinked: false,
    servicesEnabledAt: undefined as number | undefined,
    budget: undefined as number | undefined,
    secrets: new Map<string, string[]>(),
    // loadedState/loadedCredentials: the versions the server read when it
    // (last) started. Like Cloud Run, a running server doesn't see later versions.
    server: undefined as { url: string; image: string; settings: Record<string, string>; loadedState?: string; loadedCredentials?: string } | undefined,
    starts: 0,
    // Removed with "Remove Universal Mail".
    deleted: false,
    labelled: [] as string[]
  };
  // Version 1's own secrets live in its project from the start.
  if (options.v1) {
    state.secrets.set('yahoo-email', [options.v1.email]);
    state.secrets.set('yahoo-app-password', [options.v1.password]);
    state.billingLinked = true;
  }
  const loaded = () => ({ loadedState: state.secrets.get('universal-mail-state')?.at(-1), loadedCredentials: state.secrets.get('universal-mail-credentials')?.at(-1) });
  let interruptAt: number | undefined;
  let permissionLate = options.permissionLateAttempts ?? 0;
  const writes = () => calls.filter(c => c.write).length;

  const read = <T>(name: string, value: T) => { calls.push({ name, write: false }); return Promise.resolve(value); };
  const write = async <T>(name: string, act: () => T): Promise<T> => {
    if (interruptAt !== undefined && writes() >= interruptAt) throw new Interrupted();
    // A refused change is attempted but changes nothing.
    const refusal = options.refuse?.[name as keyof GoogleCloud];
    if (refusal) { calls.push({ name, write: false }); throw refusal; }
    calls.push({ name, write: true });
    return act();
  };

  const google: GoogleCloud = {
    signedInAccount: () => read('signedInAccount', options.account ?? 'you@gmail.com'),
    billing: () => read('billing', options.billing ?? { state: 'active', trial: false, accountId: 'billing-1' }),
    blocksPublicServices: () => read('blocksPublicServices', options.blocksPublicServices ?? false),
    canCreateProject: () => read('canCreateProject', options.canCreateProject ?? true),
    findProject: () => read('findProject', state.project && (!options.v1 || state.labelled.includes(state.project)) ? state.project : undefined),
    currentProject: () => read('currentProject', options.v1?.project),
    v1Service: project => read('v1Service', options.v1 && project === options.v1.project ? { sentCopyMode: options.v1.sentCopyMode } : undefined),
    billingLinked: () => read('billingLinked', state.billingLinked),
    servicesReady: () => read('servicesReady', state.servicesEnabledAt !== undefined && clock.now() >= state.servicesEnabledAt + (options.servicesReadyAfterMs ?? 0)),
    budgetExists: () => read('budgetExists', state.budget !== undefined),
    secretExists: (_p, name) => read('secretExists', state.secrets.has(name)),
    readSecret: (_p, name) => read('readSecret', state.secrets.get(name)?.at(-1)),
    serverUrl: () => read('serverUrl', state.server?.url),
    imageTrusted: image => read('imageTrusted', (options.trustedImages ?? []).includes(image)),

    createProject: () => write('createProject', () => {
      if (state.project) throw new Error('DUPLICATE: a second project');
      return (state.project = 'universal-mail-4f2a');
    }),
    linkBilling: () => write('linkBilling', () => { state.billingLinked = true; }),
    labelProject: project => write('labelProject', () => { state.project = project; state.labelled.push(project); }),
    enableServices: () => write('enableServices', () => { state.servicesEnabledAt ??= clock.now(); }),
    createBudget: (_p, _b, dollars) => write('createBudget', () => {
      if (state.budget !== undefined) throw new Error('DUPLICATE: a second budget');
      state.budget = dollars;
    }),
    putSecret: (_p, name, value) => write('putSecret', () => { state.secrets.set(name, [...(state.secrets.get(name) ?? []), value]); }),
    startServer: (_p, image, settings) => write('startServer', () => {
      if (permissionLate > 0) { permissionLate--; throw new NotReadyYet('permission'); }
      state.starts++;
      const url = 'https://universal-mail-4f2a-uc.a.run.app';
      state.server = { url, image, settings: { ...settings, PUBLIC_URL: url }, ...loaded() };
      return state.server.url;
    }),
    restartServer: () => write('restartServer', () => {
      if (!state.server) throw new Error('restart: no server is running');
      state.starts++;
      state.server = { ...state.server, ...loaded() };
    }),
    serverImage: () => read('serverImage', state.server?.image),
    deleteBudget: () => write('deleteBudget', () => { state.budget = undefined; }),
    deleteProject: () => write('deleteProject', () => {
      state.deleted = true;
      state.project = undefined;
      state.server = undefined;
      state.secrets.clear();
      state.billingLinked = false;
      state.servicesEnabledAt = undefined;
    })
  };

  return {
    google, state, calls,
    changes: () => calls.filter(c => c.write).map(c => c.name),
    // Stop (as if the tab closed) once n changes have been made; undefined to run freely.
    interruptAfterChanges: (n: number | undefined) => { interruptAt = n; }
  };
}
