/* global describe, it, before, after */
require("source-map-support/register");
const { go, isMainThread, threadId, workerData } = require(".");
const fs = require("fs");
const assert = require("assert");
const FRON = require("fron");
const util = require("util");

go.use(module);

go.register(FRON.parseToken);

go.register(sum);
/**
 * @param {number} a 
 * @param {number} b
 */
function sum(a, b) {
    return a + b;
}

go.register(exists);
/**
 * @param {string} file
 * @returns {Promise<boolean>} 
 */
function exists(file) {
    return new Promise(resolve => {
        fs.exists(file, resolve);
    });
}

let err = new Error("Something went wrong");

let throwError = go.register(() => {
    throw err;
});
let getThreadId = go.register(() => threadId);
let getWorkerData = go.register(() => workerData);
let transMap = go.register((map) => {
    return map || new Map([["foo", "Hello"], ["bar", "World"]]);
});
let transDate = go.register((date) => {
    return date || new Date();
});
let transRegExp = go.register((re) => {
    return re || /[a-zA-Z0-9]/;
});
let transBuffer = go.register((buf) => {
    return buf || Uint8Array.from(Buffer.from("Hello, World"));
});
let transferCircular = go.register(() => {
    let obj = { foo: "Hello, World" };
    obj.bar = obj;

    return obj;
});

exports.lazyFunc = function lazyFunc() {
    return "Lazy load function";
};

if (isMainThread) {
    describe("Goroutine", () => {
        before(async () => {
            await go.start({
                filename: __filename,
                workerData: { foo: "hello", bar: "world", err },
            });
        });

        it("main threadId should be 0", async () => {
            assert.strictEqual(threadId, 0);
        });

        it("worker threadId should be 1", async () => {
            let id = await go(getThreadId);
            assert.strictEqual(id, 1);
        });

        it("workerData in main thread should be null", async () => {
            assert.strictEqual(workerData, null);
        });

        it("should pass workerData as expected", async () => {
            let data = await go(getWorkerData);
            assert.strictEqual(data.foo, "hello");
            assert.strictEqual(data.bar, "world");
            assert.strictEqual(util.format(data.err), util.format(err));
        });

        it("should call a registered function", async () => {
            let result = await go(sum, 12, 13);
            assert.strictEqual(result, 25);
        });

        it("should call a registered async function", async () => {
            let result = await go(exists, "./package.json");
            assert.strictEqual(result, true);
        });

        it("should call an unregistered function", async () => {
            let result = await go((a, b) => a * b, 10, 10);
            assert.strictEqual(result, 100);
        });

        it("should call an unregistered async function", async () => {
            let result = await go((a, b) => Promise.resolve(a * b), 10, 10);
            assert.strictEqual(result, 100);
        });

        it("should parse FRON token in the worker thread", async () => {
            let token = await go(FRON.parseToken, `
            {
                name: "foo test",
                foo: {
                    circular: $
                },
                bar: { hello: "world" }
            }
            `);
            let data = FRON.composeToken(token);

            assert.deepStrictEqual(data, data["foo"]["circular"]);
        });

        it("should throw error", async () => {
            try {
                await go(throwError);
            } catch (e) {
                assert.strictEqual(util.format(e), util.format(e));
            }
        });

        it("should throw malformed registry error", async () => {
            let greeting = go.register(() => "Hello, World!");

            try {
                await go(greeting);
            } catch (err) {
                assert.strictEqual(
                    err.message,
                    "Goroutine registry malformed, function call cannot be performed"
                );
            }
        });

        it("should transfer a map", async () => {
            let map = new Map([
                ["foo", "Hello"],
                ["bar", "World"]
            ]);
            let result = await go(transMap);
            assert.deepStrictEqual(result, map);
        });

        it("should transfer a date", async () => {
            let date = new Date();
            let result = await go(transDate, date);
            // assert(result instanceof Date);
            assert.deepStrictEqual(result, date);
        });

        it("should transfer a regular expression", async () => {
            let re = /[a-zA-Z0-9]/;
            let result = await go(transRegExp, re);
            assert.deepStrictEqual(result, re);
        });

        it("should transfer a buffer", async () => {
            let buf = Uint8Array.from(Buffer.from("Hello, World"));
            let result = await go(transBuffer, buf);
            assert.deepStrictEqual(result, buf);
        });

        it("should delete circular properties", async () => {
            let result = await go(transferCircular);
            assert.deepStrictEqual(result, { foo: "Hello, World" });
        });

        it("should transfer NaN and Infinity", async () => {
            let result = await go(() => ([NaN, Infinity, -Infinity]));
            assert(isNaN(result[0]));
            assert.strictEqual(result[1], Infinity);
            assert.strictEqual(result[2], -Infinity);
        });

        it("should automatically register a function from the exports", async () => {
            let result = await go(exports.lazyFunc);
            assert.strictEqual(result, "Lazy load function");
        });

        it("should call function when Goroutine is not open", async () => {
            await go.terminate();

            let result = await go((a, b) => Promise.resolve(a * b), 10, 10);
            assert.strictEqual(result, 100);
        });
    });
}