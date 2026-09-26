import { classify } from '../errors.js';
import { profiles } from '../providers.js';
import type { MailService } from '../yahoo/mailService.js';
import { CheckFailure, type Stage } from './runner.js';

// The stages the server runs on itself (design §7.1): its version, its sign-in,
// then for each account: signing in to read and to send, the read tools on real
// mail (nothing is changed or marked read), and whether its Sent mode is settled.

export type CheckableService = Pick<MailService, 'verifyConnectivity' | 'listFolders' | 'searchEmail' | 'getEmail' | 'getThread'
  | 'createFolder' | 'saveCheckMessage' | 'markRead' | 'markUnread' | 'flagEmail' | 'trashEmail'>;

// Where the live check keeps its test message. What it leaves behind: this
// folder, and the test message in Trash (the owner chose this, 2026-09-26).
export const CHECK_FOLDER = 'Universal Mail check';

// Each change is made with the same code the tools use, then looked for by
// the message's ID: a change the server says it made but didn't is caught.
async function liveWrites(service: CheckableService, provider: string) {
  let step = 'folder';
  const find = async (mailbox: string, messageId: string) =>
    ((await service.searchEmail({ mailbox, messageId, limit: 5 })).data as Array<{ uid: number; read: boolean; flagged: boolean }>)[0];
  const expect = (ok: boolean) => { if (!ok) throw new Error(`${step} did not take effect`); };
  try {
    await service.createFolder(CHECK_FOLDER);
    step = 'save';
    const { messageId } = (await service.saveCheckMessage(CHECK_FOLDER)).data!;
    step = 'find';
    const message = await find(CHECK_FOLDER, messageId);
    expect(Boolean(message));
    const uid = message!.uid;
    step = 'read';
    await service.markRead(CHECK_FOLDER, uid);
    expect((await find(CHECK_FOLDER, messageId))?.read === true);
    step = 'unread';
    await service.markUnread(CHECK_FOLDER, uid);
    expect((await find(CHECK_FOLDER, messageId))?.read === false);
    step = 'flag';
    await service.flagEmail(CHECK_FOLDER, uid, true);
    expect((await find(CHECK_FOLDER, messageId))?.flagged === true);
    step = 'unflag';
    await service.flagEmail(CHECK_FOLDER, uid, false);
    expect((await find(CHECK_FOLDER, messageId))?.flagged === false);
    step = 'trash';
    let destination: string;
    try { destination = String((await service.trashEmail(CHECK_FOLDER, uid)).data?.destination); }
    catch (error) {
      // No safe move here (moving is off for this account): the test message stays in its folder.
      if (classify(error).code === 'SAFE_MOVE_UNAVAILABLE') return;
      throw error;
    }
    expect(!(await find(CHECK_FOLDER, messageId)) && Boolean(await find(destination, messageId)));
  } catch (error) {
    // The step is logged (a plain label); the provider's words never are.
    throw error instanceof CheckFailure ? error : new CheckFailure('MAIL-WRITE-FAILED', { provider }, step);
  }
}
export type CheckAccount = { name: string; imapHost: string; sentCopyMode: 'unverified' | 'yahoo' | 'append'; service: CheckableService };

// The provider, from its reading server: that's all the state records.
export const providerOf = (imapHost: string) => profiles.find(p => p.imap.host === imapHost.toLowerCase())?.id ?? 'other';

// A sign-in failure as a check code; anything else stays unexpected. The
// detail (for the server's log) is the engine's code, never the server's words.
function signInFailure(error: unknown, provider: string): unknown {
  const code = (error as { code?: unknown })?.code;
  if (code === 'SMTP_ENCRYPTION_UNAVAILABLE' || code === 'ETLS') return new CheckFailure('MAIL-INSECURE', { provider }, String(code));
  const classified = classify(error).code;
  if (classified === 'AUTH_FAILED') return new CheckFailure('MAIL-APP-PASSWORD-REJECTED', { provider }, classified);
  if (classified === 'TRANSIENT_NETWORK') return new CheckFailure('MAIL-UNREACHABLE', { provider }, classified);
  return error;
}

// The service's read methods throw on failure (they never return a failed envelope).
async function readTools(service: CheckableService) {
  await service.listFolders();
  const [newest] = (await service.searchEmail({ mailbox: 'INBOX', limit: 1 })).data as Array<{ mailbox: string; uid: number }>;
  if (!newest) return;
  await service.getEmail(newest.mailbox, newest.uid);
  await service.getThread(newest.mailbox, newest.uid);
}

export function serverStages(options: { expectedVersion: string; runningVersion: string; signinRoundTrip(): Promise<boolean>; accounts: CheckAccount[] }): Stage[] {
  const stages: Stage[] = [
    {
      name: 'server',
      run: async () => {
        if (options.runningVersion !== options.expectedVersion) throw new CheckFailure('SERVER-VERSION-MISMATCH', {}, `running ${options.runningVersion}`);
      }
    },
    {
      name: 'signin', after: ['server'],
      run: async () => {
        let verified = false;
        try { verified = await options.signinRoundTrip(); } catch (error) { throw new CheckFailure('SIGNIN-TEST-FAILED', {}, (error as Error)?.name); }
        if (!verified) throw new CheckFailure('SIGNIN-TEST-FAILED');
      }
    }
  ];
  for (const account of options.accounts) {
    const provider = providerOf(account.imapHost);
    stages.push(
      {
        name: `account:${account.name}`, after: ['server'],
        run: async () => { try { await account.service.verifyConnectivity(); } catch (error) { throw signInFailure(error, provider); } }
      },
      {
        name: `tools:${account.name}`, after: [`account:${account.name}`],
        run: async () => {
          try { await readTools(account.service); } catch (error) { throw new CheckFailure('MAIL-TOOL-FAILED', { provider }, classify(error).code); }
        }
      },
      {
        name: `live:${account.name}`, after: [`tools:${account.name}`],
        run: () => liveWrites(account.service, provider)
      },
      {
        name: `sent:${account.name}`, after: [`account:${account.name}`],
        run: async () => { if (account.sentCopyMode === 'unverified') throw new CheckFailure('SENT-MODE-UNKNOWN', { provider }); }
      }
    );
  }
  return stages;
}
