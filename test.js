/* global describe, it, before, after */
require("source-map-support/register");
const { go, isMainThread } = require(".");
const fs = require("fs");
const assert = require("assert");

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

if (isMainThread) {
    describe("Goroutine", () => {
        before(() => {
            return go.start({
                filename: __filename,
                workers: 1,
                // adapter: "child_process"
            });
        });

        after(() => {
            return go.terminate();
        });

        let greeting = go.register(() => "Hello, World!");

        it("should call a registered function", () => {
            return go(sum, 12, 13).then(result => {
                assert.strictEqual(result, 25);
            });
        });

        it("should call a registered async function", () => {
            return go(exists, "./package.json").then(result => {
                assert.strictEqual(result, true);
            });
        });

        it("should call an unregistered function", () => {
            return go((a, b) => a * b, 10, 10).then(result => {
                assert.strictEqual(result, 100);
            });
        });

        it("should call an unregistered async function", () => {
            return go((a, b) => Promise.resolve(a * b), 10, 10).then(result => {
                assert.strictEqual(result, 100);
            });
        });

        it("should throw error", () => {
            return go(throwError).catch(err => {
                assert.strictEqual(err.message, "Something went wrong");
            });
        });

        it("should throw malform registry error", () => {
            return go(greeting).catch(err => {
                assert.strictEqual(
                    err.message,
                    "Goroutine registry malformed, function call cannot be performed"
                );
            });
        });
    });
}