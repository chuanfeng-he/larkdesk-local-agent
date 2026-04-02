import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export interface AppEnv {
  port: number;
  host: string;
  logLevel: string;
  configDir: string;
  screenshotDir: string;
  taskArtifactDir: string;
  databaseUrl: string;
  feishu: {
    webhookUrl?: string;
    appId?: string;
    appSecret?: string;
    verificationToken?: string;
    useLongConnection: boolean;
    defaultChatId?: string;
  };
  scheduler: {
    enabled: boolean;
    stateFile: string;
    hotTopics: {
      enabled: boolean;
      times: string[];
    };
    weather: {
      enabled: boolean;
      location: string;
      latitude: number;
      longitude: number;
      checkIntervalMinutes: number;
      alertWindowHours: number;
    };
    gold: {
      enabled: boolean;
      checkIntervalMinutes: number;
      thresholdCny: number;
      routinePushIntervalHours: number;
    };
  };
  config: {
    hotReload: boolean;
  };
  codex: {
    enabled: boolean;
    mode: "artifacts_only" | "cli";
    command: string;
    args: string[];
  };
  geminiRunner: {
    enabled: boolean;
    command: string;
    args: string[];
  };
  localAccess: {
    workspaceRoot: string;
    codex: {
      mode: "disabled" | "stdin";
      command: string;
      args: string[];
    };
    gemini: {
      mode: "disabled" | "stdin";
      command: string;
      args: string[];
    };
  };
}

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.string().default("info"),
  CONFIG_DIR: z.string().default("./config"),
  SCREENSHOT_DIR: z.string().default("./data/screenshots"),
  TASK_ARTIFACT_DIR: z.string().default("./data/task-artifacts"),
  LOCAL_ACCESS_WORKSPACE_ROOT: z.string().default("."),
  LOCAL_ACCESS_CODEX_MODE: z.enum(["disabled", "stdin"]).default("disabled"),
  LOCAL_ACCESS_CODEX_COMMAND: z.string().default("codex"),
  LOCAL_ACCESS_CODEX_ARGS: z.string().default(""),
  LOCAL_ACCESS_GEMINI_MODE: z.enum(["disabled", "stdin"]).default("disabled"),
  LOCAL_ACCESS_GEMINI_COMMAND: z.string().default("gemini"),
  LOCAL_ACCESS_GEMINI_ARGS: z.string().default(""),
  DATABASE_URL: z.string().default("file:../../../data/office-agent.db"),
  FEISHU_WEBHOOK_URL: z.string().optional(),
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  FEISHU_VERIFICATION_TOKEN: z.string().optional(),
  FEISHU_USE_LONG_CONNECTION: z.string().default("false"),
  FEISHU_DEFAULT_CHAT_ID: z.string().optional(),
  SCHEDULER_ENABLED: z.string().default("true"),
  SCHEDULER_STATE_FILE: z.string().default("./data/scheduler-state.json"),
  SCHEDULER_HOT_TOPICS_ENABLED: z.string().default("true"),
  SCHEDULER_HOT_TOPICS_TIMES: z.string().default("00:00,04:00,08:00,12:00,16:00,20:00"),
  WEATHER_ALERT_ENABLED: z.string().default("true"),
  WEATHER_ALERT_LOCATION: z.string().default("合肥"),
  WEATHER_ALERT_LATITUDE: z.coerce.number().default(31.8206),
  WEATHER_ALERT_LONGITUDE: z.coerce.number().default(117.2272),
  WEATHER_ALERT_CHECK_INTERVAL_MINUTES: z.coerce.number().default(30),
  WEATHER_ALERT_WINDOW_HOURS: z.coerce.number().default(6),
  GOLD_ALERT_ENABLED: z.string().default("true"),
  GOLD_ALERT_CHECK_INTERVAL_MINUTES: z.coerce.number().default(120),
  GOLD_ALERT_THRESHOLD_CNY: z.coerce.number().default(15),
  GOLD_ALERT_ROUTINE_PUSH_INTERVAL_HOURS: z.coerce.number().default(6),
  CONFIG_HOT_RELOAD: z.string().default("true"),
  CODEX_RUNNER_ENABLED: z.string().default("false"),
  CODEX_RUNNER_MODE: z.enum(["artifacts_only", "cli"]).default("artifacts_only"),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_ARGS: z.string().default(""),
  GEMINI_RUNNER_ENABLED: z.string().default("false"),
  GEMINI_COMMAND: z.string().default("gemini"),
  GEMINI_ARGS: z.string().default(""),
});

export function loadEnv(cwd = process.cwd()): AppEnv {
  const projectRoot = resolveProjectRoot(cwd);

  loadDotenv({
    path: resolve(projectRoot, ".env"),
    override: false,
  });

  const parsed = envSchema.parse(process.env);
  const env = {
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    configDir: resolve(projectRoot, parsed.CONFIG_DIR),
    screenshotDir: resolve(projectRoot, parsed.SCREENSHOT_DIR),
    taskArtifactDir: resolve(projectRoot, parsed.TASK_ARTIFACT_DIR),
    databaseUrl: parsed.DATABASE_URL,
    feishu: {
      webhookUrl: parsed.FEISHU_WEBHOOK_URL,
      appId: parsed.FEISHU_APP_ID,
      appSecret: parsed.FEISHU_APP_SECRET,
      verificationToken: parsed.FEISHU_VERIFICATION_TOKEN,
      useLongConnection: parsed.FEISHU_USE_LONG_CONNECTION === "true",
      defaultChatId: parsed.FEISHU_DEFAULT_CHAT_ID,
    },
    scheduler: {
      enabled: parsed.SCHEDULER_ENABLED === "true",
      stateFile: resolve(projectRoot, parsed.SCHEDULER_STATE_FILE),
      hotTopics: {
        enabled: parsed.SCHEDULER_HOT_TOPICS_ENABLED === "true",
        times: parsed.SCHEDULER_HOT_TOPICS_TIMES.split(",").map((item) => item.trim()).filter(Boolean),
      },
      weather: {
        enabled: parsed.WEATHER_ALERT_ENABLED === "true",
        location: parsed.WEATHER_ALERT_LOCATION,
        latitude: parsed.WEATHER_ALERT_LATITUDE,
        longitude: parsed.WEATHER_ALERT_LONGITUDE,
        checkIntervalMinutes: parsed.WEATHER_ALERT_CHECK_INTERVAL_MINUTES,
        alertWindowHours: parsed.WEATHER_ALERT_WINDOW_HOURS,
      },
      gold: {
        enabled: parsed.GOLD_ALERT_ENABLED === "true",
        checkIntervalMinutes: parsed.GOLD_ALERT_CHECK_INTERVAL_MINUTES,
        thresholdCny: parsed.GOLD_ALERT_THRESHOLD_CNY,
        routinePushIntervalHours: parsed.GOLD_ALERT_ROUTINE_PUSH_INTERVAL_HOURS,
      },
    },
    config: {
      hotReload: parsed.CONFIG_HOT_RELOAD === "true",
    },
    codex: {
      enabled: parsed.CODEX_RUNNER_ENABLED === "true",
      mode: parsed.CODEX_RUNNER_MODE,
      command: parsed.CODEX_COMMAND,
      args: parsed.CODEX_ARGS.split(/\s+/).filter(Boolean),
    },
    geminiRunner: {
      enabled: parsed.GEMINI_RUNNER_ENABLED === "true",
      command: parsed.GEMINI_COMMAND,
      args: parsed.GEMINI_ARGS.split(/\s+/).filter(Boolean),
    },
    localAccess: {
      workspaceRoot: resolve(projectRoot, parsed.LOCAL_ACCESS_WORKSPACE_ROOT),
      codex: {
        mode: parsed.LOCAL_ACCESS_CODEX_MODE,
        command: parsed.LOCAL_ACCESS_CODEX_COMMAND,
        args: parsed.LOCAL_ACCESS_CODEX_ARGS.split(/\s+/).filter(Boolean),
      },
      gemini: {
        mode: parsed.LOCAL_ACCESS_GEMINI_MODE,
        command: parsed.LOCAL_ACCESS_GEMINI_COMMAND,
        args: parsed.LOCAL_ACCESS_GEMINI_ARGS.split(/\s+/).filter(Boolean),
      },
    },
  };

  process.env.DATABASE_URL = process.env.DATABASE_URL ?? env.databaseUrl;

  return env;
}

function resolveProjectRoot(startDir: string): string {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(resolve(current, "config/providers.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }

    current = parent;
  }
}
