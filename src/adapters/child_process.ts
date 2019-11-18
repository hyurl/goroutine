import { fork, ChildProcess } from "child_process";
import { Adapter } from "../headers";
import getPort = require("get-port");
import parseArgv = require("minimist");
import sequid from "sequid";

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
    async fork(filename: string, options: {
        execArgv?: string[];
        workerData?: any;
        stdin?: boolean;
        stdout?: boolean;
        stderr?: boolean;
    }) {
        let {
            execArgv = process.execArgv,
            workerData,
            stdin,
            stdout,
            stderr
        } = options;
        let argv = [
            ...process.argv.slice(2),
            "--go-worker=true",
            `--worker-id=${uids.next().value}`
        ];
        let debugArgv = await getDebugFlag();

        if (workerData) {
            argv.push(`--worker-data=${JSON.stringify(workerData)}`);
        }

        if (debugArgv) {
            execArgv.push(debugArgv);
        }

        return fork(filename, argv, {
            execArgv,
            stdio: [
                stdin ? "pipe" : "inherit",
                stdout ? "pipe" : "inherit",
                stderr ? "pipe" : "inherit",
                "ipc"
            ]
        });
    },
    async terminate(worker: ChildProcess) {
        worker.kill();
    },
    send(msg: any) {
        if (process.send)
            process.send(msg);
    }
}