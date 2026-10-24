// 框架按 package.json 的 `main` 导入本文件，并读取具名导出 id/label/defaults/create
// 作为 WorldDefinition（不是默认导出）。
import { IMPORT_WORLD } from './world.ts';

export const id = IMPORT_WORLD.id;
export const label = IMPORT_WORLD.label;
export const defaults = IMPORT_WORLD.defaults;
export const create = IMPORT_WORLD.create;

export { IMPORT_WORLD } from './world.ts';
export default IMPORT_WORLD;
export { IMPORT_DEFAULTS, IMPORT_CONFIG_GROUP, type ImportConfig } from './config.ts';
export { ImportWorld } from './world.ts';
