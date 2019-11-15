import { Adapter, Worker, Request } from './headers';
import { createPool } from "generic-pool";
import { err2obj, obj2err } from 'err2obj';
import { runInThisContext } from 'vm';
import { pathExists, readFile } from "fs-extra";
import * as path from "path";
import { cpus } from "os";
import sequid from "sequid";

const uids = sequid();
const registry: Function[] = [];
const tasks: {
    [uid: number]: {
        resolve(result: any): void;
        reject(err: Error): void;
    }
} = {};
let port: {
    on: (event: "message", handle: (msg: any) => void) => void
} = null;
let adapter: Adapter = null;
let pool = createPool<Worker>({
    create: () => {
        return new Promise(async (resolve, reject) => {
            let filename = await resolveEntryFile();
            let worker = adapter.fork(filename);

            worker.once("error", reject)
                .on("message", async (res: [number, Error, any]) => {
                    let [uid, err, result] = res;
                    let task = tasks[uid];

                    await pool.release(worker);

                    if (task) {
                        if (err) {
                            task.reject(obj2err(err));
                        } else {
                            task.resolve(result);
                        }
                    }
                });

            resolve(worker);
        });
    },
    destroy: worker => adapter.terminate(worker)
}, { max: cpus().length });

try {
    port = require("worker_threads").parentPort;
    adapter = require("./adapters/worker_threads").default;
} catch (e) {
    port = process;
    adapter = require("./adapters/child_process").default;
}

if (!adapter.isMainThread) {
    port.on("message", async (msg: Request) => {
        let [uid, target, args] = msg;
        let fn: Function;

        try {
            if (typeof target === "string") {
                // use '()' to wrap the code in order to let runInThisContext
                // return the result evaluated with a function definition, 
                fn = runInThisContext("(" + target + ")");
            } else {
                fn = registry[target];

                if (!fn) {
                    throw new ReferenceError("Target function not registered");
                }
            }

            let resul = await fn(...args);
            adapter.send([uid, null, resul]);
        } catch (err) {
            adapter.send([uid, err2obj(err), null]);
        }
    });
}

async function resolveEntryFile(): Promise<string> {
    if (process.mainModule) {
        return process.mainModule.filename;
    } else {
        let pwd = process.cwd();
        let file = path.resolve(pwd, "index.js");

        if (await pathExists(file)) {
            return file;
        } else {
            let i = pwd.length;

            while (i > 0) {
                pwd = pwd.slice(0, i);
                let file = path.resolve(pwd, "package.json");

                if (await pathExists(file)) {
                    let data = JSON.parse(await readFile(file, "utf8"));
                    return path.resolve(pwd, data["main"]);
                } else {
                    i = pwd.lastIndexOf(path.sep);
                }
            }

            return __filename;
        }
    }
}

/**
 * Runs a function in a parallel worker thread.
 * @param fn Could be function or a function name that has registered via
 *  `go.register()`.
 * @param args A list of data that passed to `fn` as arguments.
 */
export async function go<T = any, A extends any[] = any[]>(
    fn: (...args: A) => T,
    ...args: A
): Promise<T> {
    if (!go.isMainThread) {
        throw new Error("Running go function in a thread is not allowed");
    }

    let worker = await pool.acquire();
    let send: Function = (worker["send"] || worker["postMessage"]).bind(worker);
    let uid = uids.next().value;
    let target: number | string = registry.indexOf(fn);

    if (target === -1) {
        target = fn.toString();
    }

    return new Promise<any>((resolve, reject) => {
        tasks[uid] = { resolve, reject };
        send([uid, target, args]);
    });
}

export namespace go {
    export const isMainThread = adapter.isMainThread;

    /** Registers a function that can be used in the worker thread. */
    export function register<T extends Function>(fn: T): T {
        registry.push(fn);
        return fn;
    }

    /** Terminates all worker threads. */
    export async function terminate() {
        await pool.drain();
        await pool.clear();
    }
}

export default go;