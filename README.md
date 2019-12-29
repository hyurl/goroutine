# Goroutine

**Runs a function in a parallel worker thread.**

*Inspired by Goroutine in GO programming language and the Swoole implementation*
*in PHP programming language.*

*Backward capability is supported via `child_process` module, any Node.js higher*
*than v8.3, goroutine will work well.*

## Install

```sh
npm i @hyurl/goroutine
```

## Example

```ts
import go, { isMainThread, threadId } from "@hyurl/goroutine";
import * as marked from "marked"; // A module to transfer Markdown to HTML

go.register(markdown2html);
function markdown2html(md: string) {
    return marked(md, { /* config */ });
}

console.log(threadId); // If is the main thread, will always be 0

if (isMainThread) {
    (async () => {
        await go.start();

        let html = await go(markdown2html, "a markdown document...");
        // ...

        await go.terminate()
    })();
}
```

## How It Works?

You may think when calling the `go()` function, it will send the function string
to the worker thread and regenerate the function (most implementations on NPM
actually do this, which is very bad), well, you're WRONG. Doing so will lose the
context of where the function is defined, and the above example will never work.
But it does work.

**So how does it actually work?** You may have noticed, that in the above
example, before calling `markdown2html` function, I used `go.register()` on
that function. This is the trick, simple and straight. When calling
`go.register()`, it actually put the function in a internal registry. And since
this registry is shared between the main thread and the worker thread, when
calling `go(markdown2html)`, the main thread will send the index of the
function to the worker thread, which will then find the function from the
registry, and call the function with cloned arguments.

## API

There are very few functions of this module, many of them you've seen from the
above example.

```ts
/**
 * Whether the current the thread is the main thread.
 */
const isMainThread: boolean;
/**
 * An integer represents the current thread id, in the main thread, it will
 * always be `0`.
 */
const threadId: number;
/**
 * An arbitrary JavaScript value passed to the worker, in the main thread, it
 * will always be `null`.
 */
const workerData: any;

/**
 * Runs a function in a parallel worker thread.
 * @param fn If the function is registered via `go.register()`, then it can be
 *  called safely with the scope context. Otherwise, it will be sent to the
 *  worker thread as a plain string and regenerated, which will lose the context.
 * @param args A list of data passed to `fn` as arguments.
 */
function go<R, A extends any[] = any[]>(
    fn: (...args: A) => R,
    ...args: A
): Promise<R extends Promise<infer U> ? U : R>;

namespace go {
    /** Registers a function that can be used in the worker thread. */
    function register<T extends Function>(fn: T): T;

    /**
     * Automatically registers all functions exported by a module. (lazy-load)
     */
    function use(module: NodeJS.Module): void;
    function use(exports: any): void;

    /** Starts the goroutine and forks necessary workers. */
    function start(options?: GoroutineOptions): Promise<void>;

    /** Terminates all worker threads. */
    function terminate(): Promise<void>;

    /** Returns the number of workers in the pool. */
    function workers(): Promise<number>;
}

interface GoroutineOptions {
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
```

## Limitations

Apparently there are some limitations in this module, since neither
`worker_threads` nor `child_process` in Node.js shares address space between the
main thread and the workers.

So when using this module, the following rules must be particularly aware.

1. `go.register()` must be called at where both the main thread and worker
    threads can access. For instance, this example will not work, never do this:

```ts

if (isMainThread) {
    go.register(someFunction); // will not work
}

// or

if (!isMainThread) {
    go.register(someFunction); // will not work
}
```

Should always register for both main thread and worker threads.

```ts
go.register(someFunction); // will work

if (isMainThread) {
    // ...
}
```

2. The data passed to the function or returned by the function must be
    serializable. Since v1.1, this package guarantees the structured clone
    algorithm is used for data transmission, regardless of what adapter is used.
    Currently, these types are guaranteed to be supported:
    1. All primitive types (except for `symbol`)
    2. Date
    3. RegExp
    4. ArrayBuffer
    5. ArrayBufferView (typed arrays, `DataView` and `Buffer`<sup>[1](#note-1)</sup>)
    6. Array
    7. Object
    8. Map
    9. Set
    10. Error<sup>[2](#note-2)</sup> (native errors, AssertionError, and any error type on the global
        object)

    <p><small id="note-1">
    1. <code>Buffer</code> may be transferred to Uint8Array when using native
    HTML structured clone algorithm.
    </small></p>

    <p><small id="note-2">
    2. Only native errors are guaranteed to be supported by native HTML
    structured clone algorithm, other error types are only supported by the
    custom clone algorithm.
    </small></p>

3. Worker threads are only meant to run CPU intensive code, they will not do
    much help for I/O intensive work. Being said so, it is still dangerous to
    block the worker thread pool for too long.

## A Little Tips

Currently, VS Code doesn't have the ability to debug worker threads, if
debugging is necessary in development, try switching the adapter to
`child_process`, and only use `worker_threads` when deploying.

If however you're using WebStorm, congratulations, that it does support worker
threads debugging, please
[check this article](https://blog.jetbrains.com/webstorm/2018/10/webstorm-2018-3-eap-6/)
for more details.

If using `child_process` adapter, this module also prevents debugging port
conflicts out of box by choosing another available port when detected under
debug mode, which is a very common headache when it comes to debug
multi-processing Node.js project.

Before v1.3, this module delivers tasks to the threads using the round-robin
method and doesn't have the ability to detect if a thread is blocked. This
behavior has been changed since v1.3, now this module will deliver the task to 
the most recent responsive thread and can detect and know if the workers are
blocked, and will try to fork more workers until the pool is full (reach limit
set by `workers` option).

## About `go.use()`

This function is added since v1.2, it will automatically registers all functions
exported by a module in a lazy-load way, that means you can use it in the head 
of the module and don't have to wait the definitions of its functions.

```ts
// some module
import go from "@hyurl/goroutine";
// By using this line of code, all function exported by this module will be
// automatically registered to goroutine after program starts up.
go.use(this);

export function someFunction() {
    // ...
}

export default function () {
    // ...
}
```

There are three styles to call the `go.use()`:

1. `go.use(this)`: More often used, and straight forward.
2. `go.use(exports)` or `go.use(module.exports)`: Same as above, less often used.
3. `go.use(module)`: Most of the time this style effects the same as the above
    ones, however, it supports the export style of `module.exports = () => {}`,
    which is not supported by the above styles.

## About Load Balance

When calling `go()` function, it delivers the function call to one of the worker
thread to balance the load. Before v1.3, this module only support constant
worker numbers, so it uses a straight-forward `round-robin` method, that is, it
delivers one task to a worker, and the next task to another worker, goes around
in a circle.

Since v1.3, this module has the ability to detect health and auto-scale workers,
so it switch the load balancing method to `least-time`, that is, it delivers the
task to the most recent responsive worker. The worker holds a internal timer to
constantly notify the main thread whether it's responsive or not, so the main
thread can order the workers according to their last tick times.

But supporting only one of these methods has drawbacks. So, since v1.4, this
module now supports both two load balancing methods, and switching them smartly.

If the `workers` option is set to a specific number, all workers are forked at
once, then `round-robin` method will be used by default, so the tasks can be
delivered to them in average. However if an array of minimum and maximum number
of workers is set, the workers will be auto-scaled when necessary, in this case,
`least-time` method is used by default.

You can force the goroutine to use a specific method, but there is an exception
of setting `round-robin` when the `workers` is set an array, the configured
method will only be activated after the pool size reaches the maximum number of
workers. Because before then, goroutine doesn't know whether it should should
not scale a new worker if not using the `least-time` method and order the
workers by their tick times.