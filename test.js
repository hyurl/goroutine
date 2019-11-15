const { go } = require(".");

go.register(sum);
function sum(a, b) {
    return a + b;
}

if (go.isMainThread) {
    (async () => {
        let res = await go(sum, 12, 13);

        console.log(res);
        await go.terminate();
    })();
}