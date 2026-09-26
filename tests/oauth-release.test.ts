import { expect, it, vi } from 'vitest';
import { releaseOAuth } from '../scripts/oauth-release.js';
it('does not deploy when the local verification fails', async () => {
  const deploy = vi.fn(); const check = vi.fn();
  await expect(releaseOAuth(() => { throw new Error('tests failed'); }, deploy, check)).rejects.toThrow('tests failed');
  expect(deploy).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
});
it('does not report verification after a failed deployment', async () => {
  const check = vi.fn();
  await expect(releaseOAuth(() => {}, () => { throw new Error('build failed'); }, check)).rejects.toThrow('build failed');
  expect(check).not.toHaveBeenCalled();
});
it('requires local green, deployment and post-deployment green in that order', async () => {
  const order: string[] = [];
  await releaseOAuth(() => { order.push('local'); }, () => { order.push('deploy'); }, async () => { order.push('remote'); });
  expect(order).toEqual(['local', 'deploy', 'remote']);
});
it('propagates post-deployment failure without automatically retrying deployment', async () => {
  const deploy = vi.fn();
  await expect(releaseOAuth(() => {}, deploy, async () => { throw new Error('remote failed'); })).rejects.toThrow('remote failed');
  expect(deploy).toHaveBeenCalledOnce();
});
