// Setup stops with a registry message: its code, and the values it shows.
export class Stop extends Error {
    code;
    values;
    constructor(code, values = {}) {
        super(code);
        this.code = code;
        this.values = values;
    }
}
//# sourceMappingURL=stop.js.map