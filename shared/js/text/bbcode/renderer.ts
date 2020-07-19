import TextRenderer from "vendor/xbbcode/renderer/text";
import ReactRenderer from "vendor/xbbcode/renderer/react";
import HTMLRenderer from "vendor/xbbcode/renderer/html";

import "./emoji";
import "./highlight";

export const rendererText = new TextRenderer();
export const rendererReact = new ReactRenderer();
export const rendererHTML = new HTMLRenderer(rendererReact);