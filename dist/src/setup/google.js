// What setup needs from Google Cloud, as one small interface. The flow is
// written against this; a gcloud adapter implements it for real, and tests use
// an in-memory fake. Reads never change anything (design §4.1).
// Google says "done" slightly before a change takes effect (design §4.2):
// thrown when a dependent step finds it isn't ready yet.
// Google refused, for a reason with a plain answer (billing, quota, a company policy).
export class GoogleRefusal extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export class NotReadyYet extends Error {
    what;
    constructor(what) {
        super(`${what} not ready yet`);
        this.what = what;
    }
}
//# sourceMappingURL=google.js.map