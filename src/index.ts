import * as path from "path";
import { cpus } from 'os';
import { runInThisContext } from 'vm';
import { pathExists, readFile } from 'fs-extra';
import sequid from "sequid";
import hash = require("string-hash");
import { Adapter, Worker, GoroutineOptions } from './headers';
import { ChildProcess } from 'child_process';
import { Worker as ThreadWorker } from "worker_threads";
import ChildProcessAdapter from "./adapters/child_process";
import parseArgv = require("minimist");
import { compose, decompose, deserialize } from "@hyurl/structured-clone";
import orderBy = require("lodash/orderBy");
import define from "@hyurl/utils/define";

export { GoroutineOptions };

type CallRequest = [number, number | string, number, any[]];
type CallResponse = [number, Error, any];

const Module: new () => NodeJS.Module = Object.getPrototypeOf(module).constructor;
const nativeErrorCloneSupport = parseFloat(process.versions.v8) >= 7.7;
const lastTick = Symbol("lastTick");
const pool: Worker[] = [];
const registry: ((...args: any[]) => any)[] = [];
const includes: (NodeJS.Module | object)[] = [];
const uids = sequid(-1, true);
const tasks = new Map<number, {
    resolve(result: any): void;
    reject(err: Error): void;
}>();

let WorkerThreadsAdapter: Adapter = null;
let adapter: Adapter = null;
let entryFile: string = void 0;
let workerOptions: Parameters<Adapter["fork"]>[1] = null;
let maxWorkers: number = 1;
let loadBalanceMethod: "round-robin" | "least-time";
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
        _workerData = deserialize(_workerData);
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
            _workerData = decompose(worker_threads.workerData.workerData);
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
    ensureFunctionArg("go", fn);

    if (!isGoroutineRunning()) {
        return fn.apply(void 0, args);
    }

    let uid = uids.next().value;
    let target: number | string = registry.indexOf(fn);
    let worker: Worker;

    if (loadBalanceMethod === "least-time" || pool.length < maxWorkers) {
        // Choose the most recent responsive worker.
        worker = orderBy(pool, lastTick, "desc")[0];
    } else {
        worker = pool[uid % pool.length];
    }

    // If the registry doesn't contain the function, transfer it as plain text,
    // so the worker can recreate it to a function and try to perform the task.
    if (target === -1) {
        target = fn.toString();
    }

    // If the last tick time has not been refreshed for a second, that means
    // the worker is blocked and can no longer processing any other incoming
    // tasks. And if the pool is not full, we can fork a new worker to process
    // the task.
    if (!worker || (
        pool.length < maxWorkers && Date.now() - worker[lastTick] >= 1000
    )) {
        worker = await forkWorker(adapter, entryFile, workerOptions);
    }

    return new Promise<any>((resolve, reject) => {
        let msg: CallRequest = [
            uid,
            target,
            hash(String(fn)),
            compose(args, useNativeClone)
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
    export function register<T extends (...args: any[]) => any>(fn: T): T {
        ensureFunctionArg("register", fn);
        let index = registry.indexOf(fn);
        index === -1 && registry.push(fn);
        return fn;
    }

    /**
     * Automatically registers all functions exported by a module. (lazy-load)
     */
    export function use(module: NodeJS.Module): void;
    export function use(exports: any): void;
    export function use(module: any) {
        if (module instanceof Module) {
            let index = includes.indexOf(module);
            index === -1 && includes.push(module);
        } else if (module && typeof module === "object") {
            let index = includes.indexOf(module);
            index === -1 && includes.push(module);
        } else {
            throw new TypeError(
                "Argument for go.use() must be a Node.js module or its exports");
        }
    }

    /** Starts the goroutine and forks necessary workers. */
    export async function start(options?: GoroutineOptions) {
        ensureCallInMainThread("go.start");

        let {
            filename = void 0,
            adapter: _adapter = void 0,
            workers = cpus().length,
            method = void 0,
            execArgv = [],
            workerData = null,
            stdin = false,
            stdout = false,
            stderr = false
        } = options || {};
        let dynamicWorkers = Array.isArray(workers);
        let minWorkers = dynamicWorkers ? workers[0] : workers;

        if (minWorkers < 1) {
            throw new RangeError("Worker numbers must not be smaller than 1");
        }

        maxWorkers = dynamicWorkers ? workers[1] : workers;
        entryFile = await resolveEntryFile(filename);

        if (method) {
            loadBalanceMethod = method;
        } else {
            loadBalanceMethod = dynamicWorkers ? "least-time" : "round-robin";
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

        // Cache the configurations.
        workerOptions = {
            execArgv,
            workerData: compose(workerData, isWorkerThreadsAdapter),
            stdin,
            stdout,
            stderr
        };

        await Promise.all(new Array(minWorkers).fill(void 0).map(
            () => forkWorker(adapter, entryFile, workerOptions)
        ));
    }

    /** Terminates all worker threads. */
    export async function terminate() {
        ensureCallInMainThread("go.terminate");
        await Promise.all(pool.map(adapter.terminate));
    }

    /** Returns the number of workers in the pool. */
    export async function workers(): Promise<number> {
        if (isMainThread) {
            return pool.length;
        } else {
            return new Promise<number>((resolve, reject) => {
                let uid = uids.next().value;
                let fn = () => pool.length;
                let msg: CallRequest = [
                    uid,
                    String(fn),
                    hash(String(fn)),
                    []
                ];

                // Add the task.
                tasks.set(uid, { resolve, reject });
                adapter.send(msg);
            });
        }
    }
}

async function resolveEntryFile(filename?: string): Promise<string> {
    if (filename) {
        return path.resolve(process.cwd(), filename);
    } else if (require.main) {
        // If the program is run with an entry file (`require.main`), then
        // use the main-module's filename as the entry file, this will guarantee
        // that the worker thread loads the same resources as the main thread
        // does.
        return require.main.filename;
    } else {
        // However, if the mainModule doesn't exist, AKA. the program runs in a
        // REPL, then firstly try to resolve with the `index.js` file under the
        // current working directory, if that file exists.Otherwise, try to
        // resolve according to the closest `package.json` file.
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

async function handleCallResponse(msg: CallResponse) {
    let [uid, err, result] = msg;
    let task = tasks.get(uid);

    // If the task exists, resolve or reject it, and delete it from the
    // stack.
    if (task) {
        tasks.delete(uid);
        err ? task.reject(decompose(err)) : task.resolve(decompose(result));
    }
}

async function handleCallRequest(msg: CallRequest, worker?: Worker) {
    let [uid, target, signature, args] = msg;
    let fn: Function;
    let response: CallResponse;

    try {
        if (typeof target === "string") {
            // If the target is sent a string, that means an
            // unregistered function has been passed to the worker
            // thread, should try to recreate the function and use
            // it to handle the task.
            // Use `()` to wrap the code in order to let
            // `runInThisContext` return the result evaluated with a
            // function definition.
            if (isMainThread) {
                fn = eval("(" + target + ")");
            } else {
                fn = runInThisContext("(" + target + ")");
            }
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

        args = decompose(args);
        response = [uid, null, compose(await fn(...args), useNativeClone)];
    } catch (err) {
        response = [uid, compose(err, useNativeClone), null];
    }

    if (isMainThread && worker) {
        if (isWorkerThreadsAdapter) {
            (<ThreadWorker>worker).postMessage(response);
        } else {
            (<ChildProcess>worker).send(response);
        }
    } else {
        adapter.send(response);
    }
}

async function forkWorker(
    adapter: Adapter,
    ...args: Parameters<Adapter["fork"]>
) {
    let [filename, options] = args;
    let worker = await adapter.fork(filename, options);

    pool.push(worker);
    worker[lastTick] = Date.now();
    worker.on("message", async (msg: any) => {
        if (msg === "TICK") {
            worker[lastTick] = Date.now();
        } else if (isCallResponse(msg)) {
            await handleCallResponse(msg);
        } else if (isCallRequest(msg)) {
            await handleCallRequest(msg, worker);
        }
    }).once("exit", async (code, signal) => {
        // Remove the worker from the pool once exited.
        let index = pool.indexOf(worker);
        pool.splice(index, 1);

        // If the worker exited unexpectedly, fork a new worker to replace
        // the old one.
        if (!isNormalExit(adapter, code, signal)) {
            await forkWorker(adapter, filename, options);
        }
    });

    return worker;
}

function isNormalExit(adapter: Adapter, code: number, signal?: NodeJS.Signals) {
    return (adapter.name === "child_process" && signal === "SIGTERM")
        || (adapter.name === "worker_threads" && code === 1);
}

function isCallRequest(msg: any) {
    return Array.isArray(msg)
        && msg.length === 4
        && typeof msg[0] === "number" // uid
        && typeof msg[2] === "number" // hash signature of the function
        && Array.isArray(msg[3]); // arguments
}

function isCallResponse(msg: any) {
    return Array.isArray(msg)
        && msg.length === 3
        && typeof msg[0] === "number" // uid
        && typeof msg[1] === "object"; // error or null
}

function isFunction(fn: any) {
    return typeof fn === "function" && String(fn).slice(0, 6) !== "class ";
}

function ensureFunctionArg(name: string, fn: any) {
    if (!isFunction(fn)) {
        let type: string = typeof fn;
        type === "function" && (type = "class");
        throw new TypeError(`${name}() requires a function, ${type} is given`);
    }
}

function ensureCallInMainThread(name: string) {
    if (!isMainThread) {
        throw new Error(`Calling ${name}() in the worker thread is not allowed`);
    }
}

function isGoroutineRunning() {
    if (pool.length === 0) {
        if (isMainThread && !noWorkerWarningEmitted) {
            noWorkerWarningEmitted = true;
            process.emitWarning(
                "Goroutine is not running, " +
                "function call will be handled in the main thread"
            );
        }

        return false;
    } else {
        return true;
    }
}


// Resolve lazy-load functions.
setImmediate(() => {
    for (let module of includes) {
        let exports: any;

        if (module instanceof Module) {
            exports = module.exports;
        } else if (typeof module === "object") {
            exports = module;
        }

        if (typeof exports === "object") {
            for (let x in exports) {
                if (Object.prototype.hasOwnProperty.call(exports, x) &&
                    isFunction(exports[x])) {
                    go.register(exports[x]);
                }
            }
        } else if (isFunction(exports)) { // style `module.exports = () => {}`
            go.register(exports);
        }
    }
});

if (!isMainThread) {
    port.on("message", async (msg: any) => {
        if (isCallRequest(msg)) {
            await handleCallRequest(msg);
        } else if (isCallResponse(msg)) {
            await handleCallResponse(msg);
        }
    });

    // Notify the main thread the worker is ready.
    setImmediate(() => adapter.send("READY"));

    // Continuously notify the main thread that the worker is responsive.
    // If the worker is however blocked, it will failed to send the notification
    // message, so the main thread can detect and know that the worker is not
    // idle and may fork new workers if needed.
    setInterval(() => {
        adapter.send("TICK");
    }, 100);
}


export default go;

define(global, "go", go);