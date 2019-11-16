# Go-routine

**Runs a function in a parallel worker thread.**

*Inspired by Goroutine in GO programming language and the Swoole implementation*
*in PHP programming language.*

*Backward capability is supported via `child_process` module, even for Node.js*
*v6.0, goroutine will work well.*

## Install

```sh
npm i go-routine
```

## Example

```ts
import go from "go-routine"; // or const go = require("go-routine").default
import * as marked from "marked"; // a module to transfer Markdown to HTML

go.register(markdown2html);
function markdown2html(md: string) {
    return marked(md, { /* config */ });
}

go.start();

if (go.isMainThread) {
    (async () => {
        let html = await go(markdown2html, "<a markdown document>");
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

There are very few functions of this module, all you've seen from the above
example. But it would be more polite to list out all the details.

```ts
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
    /**
     * Checks if the current thread is the main thread.
     * NOTE: this variable is only available after calling `go.start()`.
     */
    var isMainThread: boolean;

    /** Registers a function that can be used in the worker thread. */
    function register<T extends Function>(fn: T): T;

    /**
     * Starts the goroutine and forks necessary workers.
     * This function happens immediately, once ideal, the variable
     * `go.isMainThread` will be available.
     */
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
        adapter: "worker_threads" | "child_process";
    }): void;

    /** Terminates all worker threads. */
    function terminate(): Promise<void>;
}
```

## Limitations

Apparently there are some limits in this module, since neither `worker_threads`
nor `child_process` in Node.js shares address space between the main thread and
the workers.

So when using this module, the following rules should be particularly aware.

1. `go.register()` must be called at where both the main thread and worker
    threads can access. For instance, this example will not work, never do this:

```ts

if (go.isMainThread) {
    go.register(someFunction); // will not work
}

// or

if (!go.isMainThread) {
    go.register(someFunction); // will not work
}
```

Should always register for both main thread and worker threads.

```ts
go.register(someFunction); // will work

if (go.isMainThread) {
    // ...
}
```

2. `go.start()` should, as well, be called in both main thread and worker
    threads. BUT `go()` function should only be called in the main thread.
    Calling `go.terminate()` in the worker thread will have no effect.

3. The data passed to the function or returned by the function must be
    serializable. If the `worker_threads` adapter is used (by default), then the
    [HTML structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)
    will be used to clone data. If `child_process` adapter is used, then JSON is
    used to serialize data. Those properties that cannot be serialized will be
    lost during transmission.

4. Worker threads are only meant to run CPU intensive code, they will not do any
    help for I/O intensive work. Being said so, it is still danger to block the
    worker thread for too long, this module doesn't have the ability to detect
    if a thread is hanged and fork more threads, all tasks are delivered to the
    threads using the round-robin method.