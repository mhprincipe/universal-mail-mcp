// A worker that never finishes starting: it stays alive but never announces
// it is ready.
setInterval(() => {}, 60_000);
