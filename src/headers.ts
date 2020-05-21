import { ChildProcess } from "child_process";
import { Worker as ThreadWorker, WorkerOptions } from "worker_threads";

export type Worker = ChildProcess | ThreadWorker;

export interface Adapter {
    name: "worker_threads" | "child_process";
    fork(filename: string, options: Omit<WorkerOptions, "eval">): Promise<Worker>;
    terminate(worker: Worker): Promise<void>;
    send(msg: any): void;
}

export interface GoroutineOptions {
    /**
     * The entry script file of the worker threads, by default, it will be
     * automatically resolved.
     */
    filename?: string;
    /**
     * The number of workers needed to be forked, by default, use
     * `os.cpus().length`. If an array is provided, it sets the minimum and
     * maximum number of workers, and goroutine will automatically scale
     * when necessary.
     */
    workers?: number | [number, number];
    /**
     * The load balancing method of how to choose the worker when calling `go()`.
     * If `workers` is set to a specific number, then `round-robin`
     * will be used by default; if an array of minimum and maximum number of
     * workers is set, `least-time` will be used by default.
     * However, even set `round-robin`, when the `workers` is set an array, the
     * configured method will not be activated util the pool size reaches the
     * maximum number of workers.
     */
    method?: "round-robin" | "least-time";
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
};

declare global {
    function go<R, A extends any[] = any[]>(
        fn: (...args: A) => R,
        ...args: A
    ): Promise<R extends Promise<infer U> ? U : R>;

    namespace go {
        function register<T extends Function>(fn: T): T;
        function use(module: NodeJS.Module): void;
        function use(exports: any): void;
        function start(options?: GoroutineOptions): Promise<void>;
        function terminate(): Promise<void>;
        function workers(): Promise<number>;
    }
}