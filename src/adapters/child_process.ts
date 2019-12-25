import { fork, ChildProcess } from "child_process";
import { Adapter } from "../headers";
import getPort = require("get-port");
import parseArgv = require("minimist");
import sequid from "sequid";
import { clone } from "@hyurl/structured-clone";

const uids = sequid();
const argv = parseArgv(process.execArgv);
const debugFlag = ["inspect-brk", "inspect", "debug"].find(flag => !!argv[flag]);

async function getDebugFlag() {
    if (debugFlag) {
        // Fix debug port conflict with parent process.
        return `--${debugFlag}=${await getPort()}`;
    }
}

export default <Adapter>{
    async fork(filename, {
        execArgv = process.execArgv,
        workerData,
        stdin,
        stdout,
        stderr
    }) {
        let debugArgv = await getDebugFlag();
        let argv = [
            ...process.argv.slice(2),
            "--go-worker=true",
            `--worker-id=${uids.next().value}`
        ];

        if (debugArgv) {
            execArgv.push(debugArgv);
        }

        if (workerData) {
            argv.push(`--worker-data=${JSON.stringify(clone(workerData))}`);
        }

        return new Promise((resolve, reject) => {
            let worker = fork(filename, argv, {
                execArgv,
                stdio: [
                    stdin ? "pipe" : "inherit",
                    stdout ? "pipe" : "inherit",
                    stderr ? "pipe" : "inherit",
                    "ipc"
                ]
            });
            worker.once("message", () => resolve(worker))
                .once("error", reject);
        });
    },
    async terminate(worker: ChildProcess) {
        await new Promise(resolve => {
            worker.once("exit", () => resolve());
            worker.kill();
        });
    },
    send(msg: any) {
        if (process.send)
            process.send(msg);
    }
}