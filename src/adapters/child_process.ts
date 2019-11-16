import { fork, ChildProcess } from "child_process";
import { Adapter } from "../headers";
import getPort = require("get-port");

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
    async fork(filename: string) {
        return fork(filename, ["--is-go-worker"], {
            execArgv: await patchDebugArgv(process.execArgv)
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