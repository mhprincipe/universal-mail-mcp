import { createAccounts } from './accounts.js';
import type { AppConfig } from './config.js';
import { MailError, classify, success, type ToolEnvelope } from './errors.js';
import type { SearchInput } from './mail/imap.js';
import { MailService } from './mail/mailService.js';
import { providerName } from './providers.js';
import type { MessageSummary } from './types.js';
import type { AccountGrant, Action } from './signin/grants.js';

// One service — and so one connection gateway and one folder cache — per
// account. A shared cache would hand one account another account's folders.
export function createAccountServices(accounts: Array<{ name: string; config: AppConfig; reliableHeaderSearch?: boolean }>): Map<string, MailService> {
  return new Map(accounts.map(({ name, config, reliableHeaderSearch }) =>
    [name, new MailService(config, { unreliableHeaderSearch: !reliableHeaderSearch })]));
}

// What one caller may reach: the accounts it was granted, and per account the
// actions it may take.
export type MailAccess = {
  names: string[];
  // The named account's service (or the only one), if this caller may take `action` there.
  service(account: string | undefined, action: Action): MailService;
  // Search one named account, or every account this caller may read.
  search(input: SearchInput, account?: string): Promise<ToolEnvelope<MessageSummary[]>>;
  // The name with its provider, for the tools' descriptions (ENG-29).
  label?(name: string): string;
};
// close: logs out every account's kept connection (ENG-18), when the mail
// access is replaced (an account changed on your page).
export type MailRouter = MailAccess & { forGrant(grant: AccountGrant): MailAccess; close(): Promise<void> };

const verbs: Record<Action, string> = { read: 'read mail in', organize: 'organize mail in', send: 'send mail from' };

// onAuthFailure: the provider refused an account's saved password (the
// "something broke" email and your page's "Fix it" come from this).
// readOnly: the sentence to refuse organizing and sending with while the
// subscription has lapsed (design §13.2); nothing while it hasn't.
export type RouterHooks = { onAuthFailure?(account: string): void | Promise<void>; readOnly?(): string | undefined };

// Every call to an account's service: a refused password is reported, then
// the error goes on exactly as it was.
function watched(name: string, service: MailService, hooks: RouterHooks): MailService {
  if (!hooks.onAuthFailure) return service;
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.catch(async (error: unknown) => {
          if (classify(error).code === 'AUTH_FAILED') await Promise.resolve(hooks.onAuthFailure!(name)).catch(() => undefined);
          throw error;
        });
      };
    }
  });
}

export function createMailRouter(accounts: Array<{ name: string; config: AppConfig; reliableHeaderSearch?: boolean; sending?: boolean }>, hooks: RouterHooks = {}): MailRouter {
  const sendingOff = new Set(accounts.filter(a => a.sending === false).map(a => a.name));
  const plain = createAccountServices(accounts);
  const services = new Map([...plain].map(([name, service]) => [name, watched(name, service, hooks)]));
  const directory = createAccounts(accounts.map(a => {
    const provider = providerName(a.config.MAIL_ADDRESS, a.config.IMAP_HOST);
    return { name: a.name, address: a.config.MAIL_ADDRESS, ...(provider ? { provider } : {}) };
  }));
  const multi = createMultiMail(services);

  const access = (grant: AccountGrant): MailAccess => {
    // An account the grant doesn't mention doesn't exist, as far as this caller knows.
    const names = accounts.map(a => a.name).filter(name => grant[name]?.length);
    const readable = names.filter(name => grant[name]!.includes('read'));
    const service = (account: string | undefined, action: Action) => {
      const name = directory.resolve(account, names).name;
      if (!grant[name]!.includes(action)) {
        throw new MailError('MAIL-NOT-PERMITTED', `This app isn't allowed to ${verbs[action]} ${name}. You can change that on your Universal Mail page.`);
      }
      // A lapsed subscription: reading goes on; the paid work is paused (asked
      // each time, so renewing takes effect at once).
      if (action !== 'read') {
        const paused = hooks.readOnly?.();
        if (paused) throw new MailError('SUBSCRIPTION-READ-ONLY', paused);
      }
      // Turned off on your page: whatever an app was granted.
      if (action === 'send' && sendingOff.has(name)) {
        throw new MailError('MAIL-SENDING-OFF', `Sending is turned off for ${name}. It can be turned on on your Universal Mail page.`);
      }
      return services.get(name)!;
    };
    return {
      names,
      label: directory.label,
      service,
      search: (input, account) => {
        if (account !== undefined) return service(account, 'read').searchEmail(input);
        if (readable.length === 1) return services.get(readable[0]!)!.searchEmail(input);
        return multi.search(input, readable);
      }
    };
  };

  // Without sign-in grants (bearer and v1 modes), the caller may do everything.
  const everything = Object.fromEntries(accounts.map(a => [a.name, ['read', 'organize', 'send'] as Action[]]));
  return {
    ...access(everything), forGrant: access,
    close: async () => { await Promise.all([...plain.values()].map(service => service.imap.close())); }
  };
}

export type AccountService = Pick<MailService, 'searchEmail' | 'moveEmail'>;
export type TaggedSummary = MessageSummary & { account: string };

export function createMultiMail(services: Map<string, AccountService>) {
  return {
    // Every reachable account is searched independently, so one broken
    // account costs a warning, never the whole search.
    async search(input: SearchInput, reachable: string[]): Promise<ToolEnvelope<TaggedSummary[]>> {
      const settled = await Promise.allSettled(reachable.map(async account => {
        const result = await services.get(account)!.searchEmail(input);
        return { rows: (result.data ?? []).map(summary => ({ ...summary, account })), warnings: (result.warnings ?? []).map(w => `${account}: ${w}`) };
      }));
      const found: TaggedSummary[] = [];
      const warnings: string[] = [];
      settled.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') { found.push(...outcome.value.rows); warnings.push(...outcome.value.warnings); }
        else warnings.push(`Couldn't search ${reachable[index]}: ${classify(outcome.reason).message}`);
      });
      // Newest first across every account; messages without a date go last.
      found.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      return success(found, 'Success', 'OK', warnings);
    },

    // Accounts are separate mail servers; a move across them would be a copy
    // then a delete, which breaks the no-guessing rules. Refuse it outright,
    // rather than let the destination account be dropped and the message land
    // in a same-named folder of the source account.
    async move(request: { account: string; mailbox: string; uid: number; destination: string; destinationAccount?: string }) {
      if (request.destinationAccount !== undefined && request.destinationAccount !== request.account) {
        throw new MailError('MAIL-CROSS-ACCOUNT', `Mail can't be moved between accounts. Moves stay within ${request.account}; nothing was changed.`);
      }
      return services.get(request.account)!.moveEmail(request.mailbox, request.uid, request.destination);
    }
  };
}
