// Every sign-in refusal: one log line with a reason code and the app it
// concerns, never a token, code or claim value (SIG-80); and a count per app,
// for your page (SIG-81). An app is named only when that is known: from a
// verified token, or the client_id a request itself sent. Never from an
// unverified token.
export type Refusals = {
  record(reason: string, app?: string): void;
  counts(): Record<string, Record<string, number>>;
};

export function createRefusals(): Refusals {
  const counts = new Map<string, Record<string, number>>();
  return {
    record(reason, app = 'unknown') {
      const name = app.slice(0, 200);
      console.log(JSON.stringify({ event: 'signin_refused', reason, app: name }));
      const forApp = counts.get(name) ?? {};
      forApp[reason] = (forApp[reason] ?? 0) + 1;
      counts.set(name, forApp);
    },
    counts: () => Object.fromEntries(counts)
  };
}
