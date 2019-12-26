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

## How Does It Work?

You may think when calling the `go()` function, it will send the function string
to the worker thread and regenerate the function (most implementations on NPM
actually do this, which is very bad), well, you're WRONG. Doing so will lose the
context of where the function is defined, and the above example will never work.
But it does work.

**So how does it actually work?** You may have noticed that, in the above
example, before calling `markdown2html` function, I used `go.register()` on
that function. This is the trick, simple, but it gets things done. When calling
`go.register()`, it actually put the function in a internal array of registry.
And since this registry is shared between the main thread and the worker thread,
when calling `go(markdown2html)`, the main thread only sends the index of the
function to the worker thread, and let itself to find the function from the
registry, then call the function with additional arguments.

## API

There are very few functions of this module, many of them you've seen from the
above example. But it would be more polite to list out all the details.

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
declare async function go<R, A extends any[] = any[]>(
    fn: (...args: A) => R,
    ...args: A
): Promise<R extends Promise<infer U> ? U : R>;

namespace go {
    /** Registers a function that can be used in the worker thread. */
    function register<T extends Function>(fn: T): T;

    /**
     * Automatically registers all functions exported by a module. (lazy-load)
     */
    export function use(module: NodeJS.Module): void;
    export function use(exports: any): void;

    /** Starts the goroutine and forks necessary workers. */
    function start(options?: {
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
    }): Promise<void>;

    /** Terminates all worker threads. */
    function terminate(): Promise<void>;
}
```

## Limitations

Apparently there are some limitations in this module, since neither
`worker_threads` nor `child_process` in Node.js shares address space between the
main thread and the workers.

So when using this module, the following rules should be particularly aware.

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
    5. ArrayBufferView (typed arrays, `DataView` and `*Buffer`)
    6. Array
    7. Object
    8. Map
    9. Set
    10. Error (native errors, AssertionError, and any error type on the global object)

    (NOTE: `Buffer` may be transferred to Uint8Array when using native HTML
    structured clone algorithm)

3. Worker threads are only meant to run CPU intensive code, they will not do any
    help for I/O intensive work. Being said so, it is still danger to block the
    worker thread for too long, this module doesn't have the ability to detect
    if a thread is hanged and fork more threads, all tasks are delivered to the
    threads using the round-robin method.

## A Little Tips

Currently, VS Code doesn't have the ability to debug worker threads, if
debugging is necessary in development, try switching the adapter to
`child_process`, and only use `worker_threads` when deploying, but be aware the
different serialization algorithms between them.

If however you're using WebStorm, congratulations, that it does support worker
threads debugging, please
[check this article](https://blog.jetbrains.com/webstorm/2018/10/webstorm-2018-3-eap-6/)
for more details.

If using `child_process` adapter, this module also prevents debugging port
conflicts by choosing another available port when detected under debug mode,
which is a very common headache when it comes to debug multi-processing Node.js
project.

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

There are there styles to call the `go.use()`:

1. `go.use(this)` More often used, and straight forward.
2. `go.use(exports)` or `go.use(module.exports)` Same as above, less often used.
3. `go.use(module)` Most of the time this style effects the same as the above
    ones, however, it supports the export style of `module.exports = () => {}`,
    which is not supported by the above styles.