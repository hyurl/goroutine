import { fork, ChildProcess } from "child_process";
import { Adapter } from "../headers";

export default <Adapter>{
    isMainThread: !process.argv.includes("--isWorkerThread"),
    fork(filename: string) {
        return fork(filename, [...process.argv.slice(2), "--isWorkerThread"]);
    },
    async terminate(worker: ChildProcess) {
        worker.kill();
    },
    send(msg: any) {
        if (process.send)
            process.send(msg);
    }
}