/**
 * 注册 electron stub 的 resolve hook（smokeRunner 经 --import 注入到 tsx 进程）。
 * 见同目录 loader.mjs / stub.mjs。
 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
