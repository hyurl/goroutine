import * as path from "path";
import { cpus } from 'os';
import { runInThisContext } from 'vm';
import { pathExists, readFile } from 'fs-extra';
import sequid from "sequid";
import hash = require("string-hash");
import { Adapter, Worker } from './headers';
import { ChildProcess } from 'child_process';
import { Worker as ThreadWorker } from "worker_threads";
import ChildProcessAdapter from "./adapters/child_process";
import parseArgv = require("minimist");
import { clone, declone } from "@hyurl/structured-clone";


const nativeErrorCloneSupport = parseFloat(process.versions.v8) >= 7.7;
const pool: Worker[] = [];
const registry: Function[] = [];
const uids = sequid(-1, true);
const tasks = new Map<number, {
    resolve(result: any): void;
    reject(err: Error): void;
}>();

let WorkerThreadsAdapter: Adapter = null;
let adapter: Adapter = null;
let port: {
    on: (event: "message", handle: (msg: any) => void) => void
} = null;
let isWorkerThreadsAdapter: boolean = false;
let argv = parseArgv(process.argv.slice(2));
let isWorker: boolean = argv["go-worker"] === "true";
let workerId: number = Number(argv["worker-id"] || 0);
let _workerData: any = argv["worker-data"] || null;
let noWorkerWarningEmitted = false;


if (isWorker) {
    // If `isWorker` is set in the first place, it indicates that using
    // `child_process` adapter, and the current process is a worker process. 
    port = process;
    adapter = ChildProcessAdapter;

    if (_workerData !== null) {
        _workerData = JSON.parse(declone(_workerData));
    }
} else {
    try { // Try to load `worker_threads` module and adapter.
        let worker_threads = require("worker_threads");

        isWorker = !worker_threads.isMainThread;
        workerId = worker_threads.threadId;
        WorkerThreadsAdapter = require("./adapters/worker_threads").default;

        if (isWorker) {
            port = worker_threads.parentPort;
            adapter = WorkerThreadsAdapter;
            isWorkerThreadsAdapter = true;

            // HACK, pass `process.argv` to the worker thread.
            process.argv.push(...worker_threads.workerData.argv);
            _workerData = worker_threads.workerData.workerData;
        }
    } catch (e) { }
}

// Must use `let` to define this variable, since it may be changed when starting
// the goroutine.
let useNativeClone = isWorkerThreadsAdapter && nativeErrorCloneSupport;

/**
 * Whether the current the thread is the main thread.
 */
export const isMainThread = !isWorker;
/**
 * An integer represents the current thread id, in the main thread, it will
 * always be `0`.
 */
export const threadId = workerId;
/**
 * An arbitrary JavaScript value passed to the worker, in the main thread, it
 * will always be `null`.
 */
export const workerData = _workerData || null;


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

async function forkWorker(
    adapter: Adapter,
    ...args: Parameters<Adapter["fork"]>
) {
    let [filename, options] = args;
    let worker = await adapter.fork(filename, options);

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
        let task = tasks.get(uid);

        // If the task exists, resolve or reject it, and delete it from the
        // stack.
        if (task) {
            tasks.delete(uid);

            if (err) {
                if (useNativeClone) {
                    task.reject(err);
                } else {
                    task.reject(declone(err));
                }
            } else {
                if (useNativeClone) {
                    task.resolve(result);
                } else {
                    task.resolve(declone(result));
                }
            }
        }
    }).once("exit", (code, signal) => {
        // Remove the worker from the pool once exited.
        let index = pool.indexOf(worker);
        pool.splice(index, 1);

        // If the worker exited unexpected, fork a new worker to replace
        // the old one.
        if (
            !(code === null && signal === "SIGTERM") &&
            !(code === 1 && signal === undefined)
        ) {
            forkWorker(adapter, filename, options);
        }
    });
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

    if (pool.length === 0) {
        if (!noWorkerWarningEmitted) {
            noWorkerWarningEmitted = true;
            process.emitWarning(
                "Goroutine is not working, " +
                "function call will be handled in the main thread"
            );
        }

        return fn.apply(void 0, args);
    }

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
            clone(args, useNativeClone)
        ];

        // Add the task.
        tasks.set(uid, { resolve, reject });

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
        /**
         * List of node CLI options passed to the worker. By default, options
         * will be inherited from the parent thread.
         */
        execArgv?: string[];
        /** An arbitrary JavaScript value passed to the worker. */
        workerData?: any;
        /**
         * If this is set to `true`, then `worker.stdin` will provide a writable
         * stream whose contents will appear as `process.stdin` inside the
         * Worker. By default, no data is provided.
         */
        stdin?: boolean;
        /**
         * If this is set to `true`, then `worker.stdout` will not automatically
         * be piped through to `process.stdout` in the parent.
         */
        stdout?: boolean;
        /**
         * If this is set to `true`, then `worker.stderr` will not automatically
         * be piped through to `process.stderr` in the parent.
         */
        stderr?: boolean;
    }) {
        ensureCallInMainThread("go.start");

        let {
            filename = void 0,
            adapter: _adapter = void 0,
            workers = cpus().length,
            execArgv = [],
            workerData = null,
            stdin = false,
            stdout = false,
            stderr = false
        } = options || {};

        if (workers < 1) {
            throw new RangeError("'workers' option must not be smaller than 1");
        }

        // If `adapter` options is specified `child_process` when start up,
        // then always use `ChildProcessAdapter`, otherwise automatically
        // choose the ideal one from `WorkerThreadsAdapter` and
        // `ChildProcessAdapter`.
        if (_adapter === "child_process" || WorkerThreadsAdapter === null) {
            adapter = ChildProcessAdapter;
        } else {
            adapter = WorkerThreadsAdapter;
            isWorkerThreadsAdapter = true;
            useNativeClone = isWorkerThreadsAdapter && nativeErrorCloneSupport;
        }

        filename = await resolveEntryFile(filename);
        await Promise.all(
            new Array(workers).fill(forkWorker(adapter, filename, {
                execArgv,
                workerData: clone(workerData, isWorkerThreadsAdapter),
                stdin,
                stdout,
                stderr
            }))
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

        let [uid, target, signature, args] = msg;
        let fn: Function;

        try {
            if (!useNativeClone) {
                args = declone(args);
            }

            if (typeof target === "string") {
                // If the target is sent a string, that means an
                // unregistered function has been passed to the worker
                // thread, should try to recreate the function and use
                // it to handle the task.
                // Use `()` to wrap the code in order to let
                // `runInThisContext` return the result evaluated with a
                // function definition.
                fn = runInThisContext("(" + target + ")");
            } else {
                fn = registry[target];

                // There is a slight chance that the main thread and
                // worker thread doesn't share the same copy of registry.
                // If detected, throw an error to prevent running the
                // malformed function.
                if (!fn || signature !== hash(String(fn))) {
                    throw new Error(
                        "Goroutine registry malformed, function call " +
                        "cannot be performed"
                    );
                }
            }

            let result = await fn(...args);

            result = clone(result, useNativeClone);
            adapter.send([uid, null, result]);
        } catch (err) {
            // Use err2obj to convert the error so that it can be
            // serialized and sent through the channel.
            adapter.send([uid, clone(err, useNativeClone), null]);
        }
    });
}