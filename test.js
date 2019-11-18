/* global describe, it, before, after */
require("source-map-support/register");
const { go, isMainThread, threadId } = require(".");
const fs = require("fs");
const assert = require("assert");
const FRON = require("fron");

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

let throwError = go.register(() => {
    throw new Error("Something went wrong");
});
let getThreadId = go.register(() => threadId);

if (isMainThread) {
    describe("Goroutine", () => {
        before(async () => {
            await go.start({
                filename: __filename,
                workers: 1,
                // adapter: "child_process"
            });
        });

        after(async () => {
            await go.terminate();
        });

        let greeting = go.register(() => "Hello, World!");

        it("main threadId should be 0", async () => {
            assert.strictEqual(threadId, 0);
        });

        it("worker threadId should be 1", async () => {
            let id = await go(getThreadId);
            assert.strictEqual(id, 1);
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
            } catch (err) {
                assert.strictEqual(err.message, "Something went wrong");
            }
        });

        it("should throw malform registry error", async () => {
            try {
                await go(greeting);
            } catch (err) {
                assert.strictEqual(
                    err.message,
                    "Goroutine registry malformed, function call cannot be performed"
                );
            }
        });
    });
}