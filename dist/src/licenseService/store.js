// The license service's records (design §13.3): one document per record,
// found by id, in a few collections: licenses (by code), subscriptions (the
// merchant's id → code), installs (an install id → code), transactions (a
// receipt → subscription), events (seen webhook ids). No mail, no passwords.
export function createMemoryStore() {
    const docs = new Map();
    return {
        async get(collection, id) { const json = docs.get(`${collection}/${id}`); return json === undefined ? undefined : JSON.parse(json); },
        async put(collection, id, record) { docs.set(`${collection}/${id}`, JSON.stringify(record)); }
    };
}
// A refusal carries Google's status, never Google's words.
class FirestoreRefused extends Error {
    step;
    status;
    constructor(step, status) {
        super(`Firestore refused ${step} (${status})`);
        this.step = step;
        this.status = status;
    }
}
// Firestore through its REST API, as the service's own Google identity (the
// metadata server hands it a token), the way the server saves its secrets.
// The record is one JSON string field, so nothing depends on typed values.
export function createFirestoreStore(options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const metadata = options.metadata ?? 'http://metadata.google.internal';
    const api = options.api ?? 'https://firestore.googleapis.com';
    const timeoutMs = options.timeoutMs ?? 10_000;
    let project;
    const call = async (step, url, init = {}) => {
        const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        return response;
    };
    const fromMetadata = async (path) => {
        const response = await call('metadata', `${metadata}/computeMetadata/v1/${path}`, { headers: { 'Metadata-Flavor': 'Google' } });
        if (!response.ok)
            throw new FirestoreRefused('metadata', response.status);
        return response;
    };
    const document = async (collection, id) => {
        project ??= (await (await fromMetadata('project/project-id')).text()).trim();
        const { access_token: token } = await (await fromMetadata('instance/service-accounts/default/token')).json();
        return {
            url: `${api}/v1/projects/${project}/databases/(default)/documents/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        };
    };
    return {
        async get(collection, id) {
            const { url, headers } = await document(collection, id);
            const response = await call('get', url, { headers });
            if (response.status === 404)
                return undefined;
            if (!response.ok)
                throw new FirestoreRefused('get', response.status);
            const body = await response.json();
            const json = body.fields?.json?.stringValue;
            return json === undefined ? undefined : JSON.parse(json);
        },
        async put(collection, id, record) {
            const { url, headers } = await document(collection, id);
            const response = await call('put', url, { method: 'PATCH', headers, body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(record) } } }) });
            if (!response.ok)
                throw new FirestoreRefused('put', response.status);
        }
    };
}
//# sourceMappingURL=store.js.map