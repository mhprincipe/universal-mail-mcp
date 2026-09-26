import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';
import { createCanary } from '../../testkit/src/canary.js';

export const issuer = 'https://mail.example';

export type Signin = { base: string; key: string; close(): Promise<void> };

// The app in built-in sign-in mode, on a random local port. The key is a
// canary, so a test can prove it never leaks.
export async function startSignin(env: NodeJS.ProcessEnv = {}): Promise<Signin> {
  const key = createCanary('path-key');
  const server: Server = createApp({
    AUTH_MODE: 'builtin', SIGNIN_ISSUER: issuer, SIGNIN_KEY: key, SIGNIN_ADDRESS: 'owner@example.invalid',
    YAHOO_EMAIL: 'owner@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1',
    ...env
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    key,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}
