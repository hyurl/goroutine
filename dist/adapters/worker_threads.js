"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const worker_threads_1 = require("worker_threads");
exports.default = {
    isMainThread: worker_threads_1.isMainThread,
    fork(filename) {
        return new worker_threads_1.Worker(filename);
    },
    terminate(worker) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            yield worker.terminate();
        });
    },
    send(msg) {
        if (worker_threads_1.parentPort)
            worker_threads_1.parentPort.postMessage(msg);
    }
};
//# sourceMappingURL=worker_threads.js.map