import * as path from "path";
import { cpus } from 'os';
import { runInThisContext } from 'vm';
import { pathExists, readFile } from 'fs-extra';
import { err2obj, obj2err } from 'err2obj';
import sequid from "sequid";
import hash = require("string-hash");
import decircularize = require("decircularize");
import { Adapter, Worker } from './headers';
import { ChildProcess } from 'child_process';
import { Worker as ThreadWorker } from "worker_threads";
import ChildProcessAdapter from "./adapters/child_process";


const pool: Worker[] = [];
const registry: Function[] = [];
const uids = sequid(-1, true);
const tasks: {
    [uid: number]: {
        resolve(result: any): void;
        reject(err: Error): void;
    }
} = {};

let WorkerThreadsAdapter: Adapter = null;
let adapter: Adapter = null;
let port: {
    on: (event: "message", handle: (msg: any) => void) => void
} = null;
let isGoWorker: boolean = process.argv.includes("--is-go-worker");
let isWorkerThreadsAdapter: boolean;


if (isGoWorker) {
    // If `isGoWorker` is set in the first place, it indicates that using
    // `child_process` adapter, and the current process is a worker process. 
    port = process;
    adapter = ChildProcessAdapter;
} else {
    try { // Try to load `worker_threads` module and adapter.
        let worker_threads = require("worker_threads");

        isGoWorker = !worker_threads.isMainThread;
        WorkerThreadsAdapter = require("./adapters/worker_threads").default;

        if (isGoWorker) {
            port = worker_threads.parentPort;
            adapter = WorkerThreadsAdapter;
            isWorkerThreadsAdapter = true;
        }
    } catch (e) { }
}


export const isMainThread = !isGoWorker;


async function resolveEntryFile(filename?: string): Promise<string> {
    if (filename) {
        return path.resolve(process.cwd(), filename);
    } else if (process.mainModule) {
        // If the program is run with an entry file (`process.mainModule`), then
        // use the mainModule's filename as the entry file, this will guarantee
        // that the worker thread loads the same resources as the main thread
        // does.
        return process.mainModule.filename;
    } else {
        // However, if the mainModule doesn't exist, AKA. the program runs in a
        // REPL, then firstly try to resolve with the`index.js` file under the
        // present working directory, if that file exists.Otherwise, try to
        // resolve according to the closest`package.json` file.
        let pwd = process.cwd();
        let file = path.resolve(pwd, "index.js");

        if (await pathExists(file)) {
            return file;
        } else {
            let i = pwd.length;

            // Find the closest package.json file.
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

            // If all the previous attempts failed, then throw an error and
            // probably terminate the program.
            throw new Error("Cannot resolve worker entry file for goroutine");
        }
    }
}

async function forkWorker(adapter: Adapter, filename: string) {
    let worker = await adapter.fork(filename);

    pool.push(worker);
    worker.on("message", async (res: [number, Error, any]) => {
        // Check signature
        if (!Array.isArray(res) ||
            res.length !== 3 ||
            typeof res[0] !== "number" ||
            typeof res[1] !== "object") {
            return;
        }

        let [uid, err, result] = res;
        let task = tasks[uid];

        // If the task exists, resolve or reject it, and delete it from the
        // stack.
        if (task) {
            delete tasks[uid];

            if (err) {
                task.reject(obj2err(err));
            } else {
                task.resolve(result);
            }
        }
    }).once("exit", (code, signal) => {
        // Remove the worker from the pool once exited.
        let index = pool.indexOf(worker);
        pool.splice(index, 1);

        // If the worker exited unexpected, fork a new worker to replace
        // the old one.
        if (((code === null && signal === "SIGTERM") ||
            (code === 1 && signal === undefined)) === false) {
            forkWorker(adapter, filename);
        }
    });
}

/**
 * NOTE: This function now only supports primitives and simple objects.
 */
function serializable(data: any) {
    let type = typeof data;

    if (data === undefined || data === null ||
        type === "function" || type === "symbol" ||
        (type === "bigint" && !isWorkerThreadsAdapter)) {
        return void 0;
    } else if (type === "object") {
        if (data instanceof Map) {
            let map = new Map();

            for (let [key, value] of data) {
                key = serializable(key);

                // Skip the items that the key resolves to void.
                if (key !== undefined) {
                    map.set(key, serializable(value));
                }
            }

            return map;
        } else if (data instanceof Set) {
            let set = new Set();

            for (let value of data) {
                set.add(serializable(value));
            }

            return set;
        } else if (Array.isArray(data)) {
            let arr = [];

            for (let i = 0; i < data.length; ++i) {
                arr.push(serializable(data[i]));
            }

            return arr;
        } else {
            for (let key in data) {
                // Only care about own properties.
                if (data.hasOwnProperty(key)) {
                    let value = serializable(data[key]);

                    // If the value resolved to void, simply delete the property.
                    if (value === undefined) {
                        delete data[key];
                    }
                }
            }

            return data;
        }
    } else {
        return data;
    }
}

function ensureCallInMainThread(name: string) {
    if (!isMainThread) {
        throw new Error(`Calling ${name}() in the worker thread is not allowed`);
    }
}


/**
 * Runs a function in a parallel worker thread.
 * @param fn If the function is registered via `go.register()`, then it can be
 *  called safely with the scope context. Otherwise, it will be sent to the
 *  worker thread as a plain string and regenerated, which will lose the context.
 * @param args A list of data passed to `fn` as arguments.
 */
export async function go<R, A extends any[] = any[]>(
    fn: (...args: A) => R,
    ...args: A
): Promise<R extends Promise<infer U> ? U : R> {
    ensureCallInMainThread("go");

    let uid = uids.next().value;
    let worker = pool[uid % pool.length];
    let target: number | string = registry.indexOf(fn);

    // If the registry doesn't contain the function, transfer it as plain text,
    // so the worker can recreate it to a function and try to perform the task.
    if (target === -1) {
        target = fn.toString();
    }

    return new Promise<any>((resolve, reject) => {
        let msg = [
            uid,
            target,
            hash(String(fn)),
            // Ensure the arguments are serializable and doesn't have
            // circular references.
            serializable(decircularize(args))
        ];

        // Add the task.
        tasks[uid] = { resolve, reject };

        // Transfer the task message to the worker.
        if (isWorkerThreadsAdapter) {
            (<ThreadWorker>worker).postMessage(msg);
        } else {
            (<ChildProcess>worker).send(msg);
        }
    });
}

export namespace go {
    /** Registers a function that can be used in the worker thread. */
    export function register<T extends Function>(fn: T): T {
        registry.push(fn);
        return fn;
    }

    /** Starts the goroutine and forks necessary workers. */
    export async function start(options?: {
        /**
         * The entry script file of the worker threads, by default, it will be
         * automatically resolved.
         */
        filename?: string;
        /**
         * The number of workers needed to be forked, by default, use
         * `os.cpus().length`.
         */
        workers?: number;
        /**
         * By default, use `worker_threads` in the supported Node.js version and
         * fallback to `child_process` if not supported.
         */
        adapter?: "worker_threads" | "child_process";
    }) {
        ensureCallInMainThread("go.start");

        let {
            filename = void 0,
            adapter: _adapter = void 0,
            workers = cpus().length,
        } = options || {};

        if (workers < 1) {
            throw new RangeError("'workers' option must not be smaller than 1");
        }

        // If `adapter` options is specified `child_process` when start up,
        // then always use `ChildProcessAdapter`, otherwise automatically
        // choose the ideal one from `WorkerThreadsAdapter` and
        // `ChildProcessAdapter`.
        if (_adapter === "child_process") {
            adapter = ChildProcessAdapter;
        } else if (WorkerThreadsAdapter) {
            adapter = WorkerThreadsAdapter;
            isWorkerThreadsAdapter = true;
        } else {
            adapter = ChildProcessAdapter;
        }

        filename = await resolveEntryFile(filename);
        await Promise.all(
            new Array(workers).fill(forkWorker(adapter, filename))
        );
    }

    /** Terminates all worker threads. */
    export async function terminate() {
        ensureCallInMainThread("go.terminate");
        await Promise.all(pool.map(adapter.terminate));
    }
}


export default go;


if (!isMainThread) {
    // In the worker thread, listens message from the main thread, if
    // the message signature matches the task request, execute the task.
    type CallMessage = [number, number | string, number, any[]];
    port.on("message", async (msg: CallMessage) => {
        // Check signature
        if (!Array.isArray(msg) ||
            typeof msg[0] !== "number" ||
            typeof msg[2] !== "number" ||
            !Array.isArray(msg[3])) {
            return;
        }

        let [uid, target, id, args] = msg;
        let fn: Function;

        try {
            if (typeof target === "string") {
                // If the target is sent a string, that means an
                // unregistered function has been passed to the worker
                // thread, should try to recreate the function and use
                // it to handle the task.
                // Use `()` to wrap the code in order to let
                // `runInThisContext` return the result evaluated with a
                // function definition, 
                fn = runInThisContext("(" + target + ")");
            } else {
                fn = registry[target];

                // There is a slight chance that the main thread and
                // worker thread doesn't share the same copy of registry.
                // If detected, throw an error to prevent running the
                // malformed function.
                if (!fn || id !== hash(String(fn))) {
                    throw new Error(
                        "Goroutine registry malformed, function call " +
                        "cannot be performed"
                    );
                }
            }

            let result = await fn(...args);

            // Ensure the result is serializable and doesn't have
            // circular references.
            result = serializable(decircularize(result));

            adapter.send([uid, null, result]);
        } catch (err) {
            // Use err2obj to convert the error so that it can be
            // serialized and sent through the channel.
            // Since err2obj already calls decircularize() internally, here only
            // need to call serializable() on it.
            adapter.send([uid, serializable(err2obj(err)), null]);
        }
    });
}