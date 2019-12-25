import { Worker, parentPort } from "worker_threads";
import { Adapter } from "../headers";
import { clone } from "@hyurl/structured-clone";

const nativeErrorCloneSupport = parseFloat(process.versions.v8) >= 7.7;

export default <Adapter>{
    async fork(filename, {
        execArgv = process.execArgv,
        workerData,
        ...extra
    }) {
        return new Promise<Worker>((resolve, reject) => {
            let worker = new Worker(filename, {
                execArgv,
                workerData: {
                    // HACK, pass `process.argv` to the worker thread.
                    argv: process.argv.slice(2),
                    workerData: clone(workerData, nativeErrorCloneSupport)
                },
                ...extra
            });
            worker.once("message", () => resolve(worker))
                .once("error", reject);
        });
    },
    async terminate(worker: Worker) {
        await worker.terminate();
    },
    send(msg: any) {
        if (parentPort)
            parentPort.postMessage(msg);
    }
};