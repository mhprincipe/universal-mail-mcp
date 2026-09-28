import { createLicenseApp } from './app.js';
import { createFirestoreStore } from './store.js';

// `node dist/src/licenseService/index.js`: the license service on Cloud Run
// (design §13.3). Its settings come from the environment, the secrets from
// Secret Manager through Cloud Run (scripts/license-setup.sh sets them).
const required = (name: string) => {
  const value = process.env[name];
  if (!value) { console.log(JSON.stringify({ event: 'settings_invalid', setting: name, problem: `${name} is missing` })); process.exit(1); }
  return value;
};
const app = createLicenseApp({
  store: createFirestoreStore(),
  signingKey: JSON.parse(required('LICENSE_SIGNING_KEY')),
  serviceUrl: required('LICENSE_SERVICE_URL'),
  clock: Date,
  paddleWebhookSecret: required('PADDLE_WEBHOOK_SECRET'),
  checkout: { clientToken: required('PADDLE_CLIENT_TOKEN'), monthlyPriceId: required('PADDLE_PRICE_MONTHLY'), yearlyPriceId: required('PADDLE_PRICE_YEARLY') }
});
const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => { console.log(JSON.stringify({ event: 'license_service_started', port })); });
