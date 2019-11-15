"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const child_process_1 = require("child_process");
exports.default = {
    isMainThread: !process.argv.includes("--isWorkerThread"),
    fork(filename) {
        return child_process_1.fork(filename, ["--isWorkerThread"]);
    },
    terminate(worker) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            worker.kill();
        });
    },
    send(msg) {
        if (process.send)
            process.send(msg);
    }
};
//# sourceMappingURL=child_process.js.map