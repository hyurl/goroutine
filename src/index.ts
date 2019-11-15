/**
 * @author Ayon Lee
 * @email ayonlys@gmail.com
 * @create date 2019-11-14 10:00:00
 * @modify date 2019-11-14 14:10:23
 * @desc [description]
 */
import { createPool, Pool } from "generic-pool";
import { BiMap } from "advanced-collections";
import { runInThisContext } from "vm";
import { err2obj, obj2err } from "err2obj";
import { cpus } from "os";
import {
    isMainThread as _isMainThread,
    Worker,
    parentPort,
    MessageChannel,
    MessagePort
} from "worker_threads";

type CallMessage = {
    target: string;
    shouldEval: boolean;
    args: any[];
    port: MessagePort
};

/**
 * Runs a function in a parallel worker thread.
 * @param fn Could be function or a function name that has registered via
 *  `go.register()`.
 * @param args A list of data that passed to `fn` as arguments.
 */
export async function go<T = any, A extends any[] = any[]>(
    fn: string | ((...args: A) => T),
    ...args: A
): Promise<T> {
    if (!go.pool) {
        throw new ReferenceError("Goroutine is not yet ready");
    }

    let worker = await go.pool.acquire();
    let channel = new MessageChannel;
    let target: string = null;
    let shouldEval = false;
    let result = new Promise<T>((resolve, reject) => {
        channel.port1.once("message", async (msg: [Error, any]) => {
            let [err, result] = msg;

            await go.pool.release(worker);

            if (err) {
                reject(obj2err(err));
            } else {
                resolve(result);
            }
        });
    });

    if (typeof fn === "function") {
        if (go.functions.hasValue(fn)) {
            target = go.functions.getKey(fn);
        } else {
            target = fn.toString();
            shouldEval = true;
        }
    } else {
        target = fn;
        shouldEval = !go.functions.has(fn);
    }

    worker.postMessage(<CallMessage>{
        target,
        shouldEval,
        args,
        port: channel.port2
    }, [channel.port2]);

    return result;
}

export namespace go {
    /** @inner DON'T manipulate this object, use `go.register()` instead. */
    export const functions = new BiMap<string, Function>();
    /** Only used when intending to clear the pool. */
    export const pool: Pool<Worker> = null;
    export const isMainThread = _isMainThread;

    /**
     * Starts the goroutine with an entry script (`filename`), which should load
     * the same resources as the main thread does. If omitted, the `maxWorkers`
     * will be determined by the CPU cores.
     */
    export function start(filename: string, maxWorkers = cpus().length) {
        if (isMainThread) {
            Object.assign(go, {
                pool: createPool({
                    create: () => Promise.resolve(new Worker(filename)),
                    destroy: async (worker) => {
                        await worker.terminate();
                    }
                }, { max: maxWorkers })
            });
        } else {
            process.emitWarning(
                "Calling go.start() in a worker thread has no effect"
            );
        }
    }

    /** Registers a function with a unique id to the thread pool. */
    export function register(id: string, fn: Function): void;
    /** Registers a function and uses the function name as id. */
    export function register(fn: Function): void;
    export function register(id: string | Function, fn?: Function) {
        if (typeof id === "function") {
            fn = id;
            id = fn.name;
        }

        functions.set(id, fn);
    }
}

if (!go.isMainThread) {
    parentPort.on("message", async (msg: CallMessage) => {
        let { target, shouldEval, args, port } = msg;
        let fn: Function;

        try {
            if (shouldEval) {
                // use '()' to wrap the code in order to let runInThisContext
                // return the result evaluated with a function definition, 
                fn = runInThisContext("(" + target + ")");
            } else {
                fn = go.functions.get(target);

                if (!fn) {
                    throw new ReferenceError(
                        `${target} is not a function, try register it with go.register()`
                    );
                }
            }

            let resul = await fn(...args);
            port.postMessage([null, resul]);
        } catch (err) {
            port.postMessage([err2obj(err), null]);
        }
    });
}