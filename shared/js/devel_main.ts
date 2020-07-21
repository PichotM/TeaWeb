import * as loader from "tc-loader";
import {Stage} from "tc-loader";

import * as ipc from "./ipc/BrowserIPC";
import * as i18n from "./i18n/localize";

import "./proto";

import {spawnVideoPopout} from "tc-shared/video-viewer/Controller";

console.error("Hello World from devel main");
loader.register_task(Stage.JAVASCRIPT_INITIALIZING, {
    name: "setup",
    priority: 10,
    function: async () => {
        await i18n.initialize();
        ipc.setup();
    }
});

loader.register_task(Stage.LOADED, {
    name: "invoke",
    priority: 10,
    function: async () => {
        console.error("Spawning video popup");
        //spawnVideoPopout();

        Notification.requestPermission().then(permission => {
            if(permission === "denied")
                return;

            const notification = new Notification("Hello World", {
                body: "This is a simple test notification - " + Math.random(),
                renotify: true,
                tag: "xx"
            });
        })
    }
});