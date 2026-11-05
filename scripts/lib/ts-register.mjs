/** `node --experimental-transform-types --import ./lib/ts-register.mjs`: lets a script import cli/src/*.ts. */
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
