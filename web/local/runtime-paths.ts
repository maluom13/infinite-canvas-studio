import { join } from "node:path";

/**
 * 本机路径的唯一来源。
 *
 * 默认值保持原来的 D 盘布局，所以当前这台机器不需要改任何东西、行为完全不变；
 * 换一台机器时由启动脚本设置这几个环境变量覆盖，也不用改代码。
 *
 * - CANVAS_DATA_ROOT   画布数据目录（账号、日志、临时任务）
 * - CODEX_HOME         Codex 的 home
 * - CANVAS_PROJECT_ROOT 程序目录
 * - MUSE_INSTALL_CONFIG MuseCanvas 的 install.json
 * - CANVAS_TEMP        临时目录
 */
export const DATA_ROOT = process.env.CANVAS_DATA_ROOT || "D:/CodexData/.codex/infinite-canvas";
export const CODEX_HOME = process.env.CODEX_HOME || "D:/CodexData/.codex";
export const PROJECT_ROOT = process.env.CANVAS_PROJECT_ROOT || "D:/CodexOutputs/infinite-canvas";
export const TEMP_ROOT = process.env.CANVAS_TEMP || join(CODEX_HOME, "temp", "infinite-canvas");
export const MUSE_INSTALL_CONFIG = process.env.MUSE_INSTALL_CONFIG || "D:/CodexOutputs/MuseCanvasData/install.json";

/** 用户可编辑的配置文件位置：用来覆盖程序位置、端口、MuseCanvas 安装路径。 */
export const CANVAS_CONFIG_PATH = process.env.CANVAS_CONFIG || join(PROJECT_ROOT, "canvas.config.json");

/** 发布器、豆包、深度图等子目录都在数据目录下，统一走这里拼。 */
export const dataPath = (...segments: string[]) => join(DATA_ROOT, ...segments);
export const tempPath = (...segments: string[]) => join(TEMP_ROOT, ...segments);
export const projectPath = (...segments: string[]) => join(PROJECT_ROOT, ...segments);

/**
 * 外部工具默认按命令名交给系统 PATH 解析，不写死安装路径。
 * 装在不同位置时用 CANVAS_FFMPEG / CANVAS_FFPROBE / CANVAS_PYTHON 指定。
 */
export const FFMPEG = process.env.CANVAS_FFMPEG || "ffmpeg";
export const FFPROBE = process.env.CANVAS_FFPROBE || "ffprobe";
export const PYTHON = process.env.CANVAS_PYTHON || "python";
