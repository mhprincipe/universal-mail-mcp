import { createApp } from './app.js';
const port = Number(process.env.PORT ?? 8080);
const app = createApp();
app.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'server_started', port }));
});
// Cloud Run stops an idle server with SIGTERM (and allows it ten seconds):
// the activity log's last few minutes are saved first (ACT-05).
process.once('SIGTERM', () => {
    const signin = app.signin;
    void Promise.resolve(signin?.activity?.flush())
        .then(() => signin?.saved?.())
        .catch(() => undefined)
        .finally(() => process.exit(0));
});
//# sourceMappingURL=index.js.map