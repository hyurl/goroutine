import { fork, ChildProcess } from "child_process";
import { Adapter } from "../headers";
import getPort = require("get-port");
import sequid from "sequid";

const uids = sequid();

async function patchDebugArgv(argv: string[]) {
    for (let i = 0; i < argv.length; ++i) {
        if (argv[i].startsWith("--inspect-brk")) {
            argv[i] = "--inspect-brk=" + await getPort();
            break;
        } else if (argv[i].startsWith("--inspect")) {
            argv[i] = "--inspect=" + await getPort();
            break;
        } else if (argv[i].startsWith("--debug")) {
            argv[i] = "--debug=" + await getPort();
            break;
        }
    }

    return argv;
}

export default <Adapter>{
    async fork(filename: string, options?: {
        execArgv?: string[];
        workerData?: any;
    }) {
        let { execArgv = [], workerData } = options;
        let argv = [
            ...process.argv.slice(2),
            "--go-worker=true",
            `--worker-id=${uids.next().value}`
        ];

        if (workerData) {
            argv.push(`--worker-data=${JSON.stringify(workerData)}`);
        }

        return fork(filename, argv, {
            execArgv: [
                ...(await patchDebugArgv(process.execArgv)),
                ...execArgv
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