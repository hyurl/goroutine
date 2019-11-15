"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const generic_pool_1 = require("generic-pool");
const err2obj_1 = require("err2obj");
const vm_1 = require("vm");
const fs_extra_1 = require("fs-extra");
const path = require("path");
const os_1 = require("os");
const sequid_1 = require("sequid");
const uids = sequid_1.default();
const registry = [];
const tasks = {};
let port = null;
let adapter = null;
let pool = generic_pool_1.createPool({
    create: () => {
        return new Promise((resolve, reject) => tslib_1.__awaiter(void 0, void 0, void 0, function* () {
            let filename = yield resolveEntryFile();
            let worker = adapter.fork(filename);
            worker.once("error", reject)
                .on("message", (res) => tslib_1.__awaiter(void 0, void 0, void 0, function* () {
                let [uid, err, result] = res;
                let task = tasks[uid];
                yield pool.release(worker);
                if (task) {
                    if (err) {
                        task.reject(err2obj_1.obj2err(err));
                    }
                    else {
                        task.resolve(result);
                    }
                }
            }));
            resolve(worker);
        }));
    },
    destroy: worker => adapter.terminate(worker)
}, { max: os_1.cpus().length });
try {
    port = require("worker_threads").parentPort;
    adapter = require("./adapters/worker_threads").default;
}
catch (e) {
    port = process;
    adapter = require("./adapters/child_process").default;
}
if (!adapter.isMainThread) {
    port.on("message", (msg) => tslib_1.__awaiter(void 0, void 0, void 0, function* () {
        let [uid, target, args] = msg;
        let fn;
        try {
            if (typeof target === "string") {
                fn = vm_1.runInThisContext("(" + target + ")");
            }
            else {
                fn = registry[target];
                if (!fn) {
                    throw new ReferenceError("Target function not registered");
                }
            }
            let resul = yield fn(...args);
            adapter.send([uid, null, resul]);
        }
        catch (err) {
            adapter.send([uid, err2obj_1.err2obj(err), null]);
        }
    }));
}
function resolveEntryFile() {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        if (process.mainModule) {
            return process.mainModule.filename;
        }
        else {
            let pwd = process.cwd();
            let file = path.resolve(pwd, "index.js");
            if (yield fs_extra_1.pathExists(file)) {
                return file;
            }
            else {
                let i = pwd.length;
                while (i > 0) {
                    pwd = pwd.slice(0, i);
                    let file = path.resolve(pwd, "package.json");
                    if (yield fs_extra_1.pathExists(file)) {
                        let data = JSON.parse(yield fs_extra_1.readFile(file, "utf8"));
                        return path.resolve(pwd, data["main"]);
                    }
                    else {
                        i = pwd.lastIndexOf(path.sep);
                    }
                }
                return __filename;
            }
        }
    });
}
function go(fn, ...args) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        if (!go.isMainThread) {
            throw new Error("Running go function in a thread is not allowed");
        }
        let worker = yield pool.acquire();
        let send = (worker["send"] || worker["postMessage"]).bind(worker);
        let uid = uids.next().value;
        let target = registry.indexOf(fn);
        if (target === -1) {
            target = fn.toString();
        }
        return new Promise((resolve, reject) => {
            tasks[uid] = { resolve, reject };
            send([uid, target, args]);
        });
    });
}
exports.go = go;
(function (go) {
    go.isMainThread = adapter.isMainThread;
    function register(fn) {
        registry.push(fn);
        return fn;
    }
    go.register = register;
    function terminate() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            yield pool.drain();
            yield pool.clear();
        });
    }
    go.terminate = terminate;
})(go = exports.go || (exports.go = {}));
exports.default = go;
//# sourceMappingURL=index.js.map