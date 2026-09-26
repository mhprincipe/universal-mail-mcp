// Saves a new version of a secret through Secret Manager's REST API, as the
// server's own Google identity: on Cloud Run the metadata server hands it a
// token. Afterwards only the newest KEEP versions stay: Google's free tier
// covers six active versions, so two secrets at two each never cost anything.

const KEEP = 2;

// A refusal carries Google's status, never Google's words.
class SecretRefused extends Error {
  constructor(readonly step: string, readonly status: number) { super(`Secret Manager refused ${step} (${status})`); }
}

export function createSecretWriter(options: { secret: string; fetchImpl?: typeof fetch; metadata?: string; api?: string; timeoutMs?: number }): (json: string) => Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const metadata = options.metadata ?? 'http://metadata.google.internal';
  const api = options.api ?? 'https://secretmanager.googleapis.com';
  const timeoutMs = options.timeoutMs ?? 10_000;
  let project: string | undefined;

  const call = async (step: string, url: string, init: RequestInit = {}) => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new SecretRefused(step, response.status);
    return response;
  };
  const fromMetadata = (path: string) => call('metadata', `${metadata}/computeMetadata/v1/${path}`, { headers: { 'Metadata-Flavor': 'Google' } });

  return async json => {
    project ??= (await (await fromMetadata('project/project-id')).text()).trim();
    const { access_token: token } = await (await fromMetadata('instance/service-accounts/default/token')).json() as { access_token: string };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const secret = `${api}/v1/projects/${project}/secrets/${options.secret}`;

    await call('addVersion', `${secret}:addVersion`, {
      method: 'POST', headers, body: JSON.stringify({ payload: { data: Buffer.from(json, 'utf8').toString('base64') } })
    });
    // Newest first; everything after the newest KEEP is destroyed.
    const listed = await (await call('list', `${secret}/versions?filter=state:ENABLED`, { headers })).json() as { versions?: Array<{ name: string }> };
    const numbers = (listed.versions ?? []).map(v => Number(v.name.split('/').at(-1))).filter(Number.isInteger).sort((a, b) => b - a);
    for (const old of numbers.slice(KEEP)) await call('destroy', `${secret}/versions/${old}:destroy`, { method: 'POST', headers, body: '{}' });
  };
}
