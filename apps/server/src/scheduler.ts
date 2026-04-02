import type { TaskRecord, TaskSubmission, TaskStore, TaskType } from "@office-agent/core";
import { summarizeText } from "@office-agent/core";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskOrchestrator } from "@office-agent/core";
import type { FeishuBotApp } from "@office-agent/feishu";
import type { AppEnv } from "./env";

const WEATHER_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const GOLD_API_ENDPOINT = "https://api.gold-api.com/price/XAU";
const USD_CNY_RATE_ENDPOINT = "https://api.frankfurter.dev/v2/rate/USD/CNY";
const GITHUB_SEARCH_API_ENDPOINT = "https://api.github.com/search/repositories";
const SHANGHAI_TIMEZONE = "Asia/Shanghai";
const TROY_OUNCE_IN_GRAMS = 31.1034768;
const GITHUB_TRENDING_LOOKBACK_DAYS = 7;
const GITHUB_TRENDING_CACHE_TTL_MS = 6 * 3_600_000;

export class PushScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly hotTopicRuns = new Set<string>();
  private lastWeatherAlertKey: string | null = null;
  private lastWeatherAlertAt = 0;
  private lastGoldBaseline: number | null = null;
  private lastGoldAlertAt = 0;
  private lastGoldRoutinePushAt = 0;
  private lastFeishuChatId: string | null = null;
  private lastGitHubTrendingDigest: string | null = null;
  private lastGitHubTrendingFetchedAt = 0;
  private stateLoaded = false;
  private stateWriteChain: Promise<void> = Promise.resolve();
  private started = false;
  private lockAcquired = false;

  private pushDisabled = false;

  constructor(
    private readonly env: AppEnv,
    private readonly orchestrator: TaskOrchestrator,
    private readonly store: TaskStore,
    private readonly feishuBot: FeishuBotApp,
    private readonly logger: { info: (input: unknown, msg?: string) => void; warn: (input: unknown, msg?: string) => void; error: (input: unknown, msg?: string) => void },
  ) {}

  start(): void {
    if (!this.env.scheduler.enabled) {
      return;
    }
    if (this.started || this.timers.length > 0) {
      return;
    }
    this.started = true;

    void this.startWithLock();
  }

  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers.length = 0;
    this.started = false;
    if (this.lockAcquired) {
      this.lockAcquired = false;
      void rm(this.getLockFilePath(), { force: true }).catch(() => undefined);
    }
  }

  private async startWithLock(): Promise<void> {
    const acquired = await this.acquireProcessLock();
    if (!acquired) {
      this.logger.warn({ feature: "scheduler" }, "Scheduler lock already held by another process; skipping duplicate scheduler startup.");
      this.started = false;
      return;
    }

    this.lockAcquired = true;

    if (!this.env.feishu.appId || !this.env.feishu.appSecret) {
      this.logger.warn({ feature: "scheduler" }, "FEISHU_APP_ID or FEISHU_APP_SECRET is missing; scheduler push notifications are disabled. Tasks will still run but results won't be pushed to Feishu.");
      this.pushDisabled = true;
    } else if (!this.env.feishu.defaultChatId) {
      this.logger.warn({ feature: "scheduler" }, "FEISHU_DEFAULT_CHAT_ID is not set; scheduler will try to infer chat ID from recent tasks. Set this env var to ensure reliable push delivery.");
    }

    this.timers.push(setInterval(() => void this.tickHotTopics(), 60_000));

    if (this.env.scheduler.weather.enabled) {
      this.timers.push(setInterval(() => void this.checkWeatherAlerts(), Math.max(5, this.env.scheduler.weather.checkIntervalMinutes) * 60_000));
      void this.checkWeatherAlerts();
    }

    if (this.env.scheduler.gold.enabled) {
      this.timers.push(setInterval(() => void this.checkGoldAlerts(), Math.max(5, this.env.scheduler.gold.checkIntervalMinutes) * 60_000));
      void this.checkGoldAlerts();
    }

    void this.tickHotTopics();
  }

  private async tickHotTopics(): Promise<void> {
    if (!this.env.scheduler.hotTopics.enabled) {
      return;
    }
    await this.ensureStateLoaded();

    const now = new Date();
    const local = formatLocalDateTime(now);
    const slot = `${local.date} ${local.time}`;
    if (!this.env.scheduler.hotTopics.times.includes(local.time) || this.hotTopicRuns.has(slot)) {
      return;
    }

    if (!await this.acquireHotTopicSlotLock(slot)) {
      this.hotTopicRuns.add(slot);
      await this.persistState();
      this.logger.warn({ feature: "scheduler", slot }, "Skipped duplicate hot topics slot because the slot lock already exists.");
      return;
    }

    if (await this.hasExistingHotTopicTask(slot)) {
      this.hotTopicRuns.add(slot);
      await this.persistState();
      this.logger.warn({ feature: "scheduler", slot }, "Skipped duplicate hot topics slot because an existing scheduler task already covers it.");
      return;
    }

    this.hotTopicRuns.add(slot);
    await this.persistState();
    try {
      const bulletinLabel = getBulletinLabel(local.time);
      const task = await this.runSchedulerTask({
        input: buildFrontierDigestPrompt(bulletinLabel, local.time),
        requestedType: "COMPLEX",
        requestedIntent: "office_discussion",
        qualityLevel: "standard",
        riskLevel: "low",
        sourceMeta: {
          schedulerKind: "daily_hot_topics",
          scheduledAt: slot,
        },
      });

      const answer =
        typeof task.result?.answer === "string"
          ? task.result.answer
          : task.outputSummary ?? "今日热点暂时未生成成功。";
      const provider = typeof task.result?.provider === "string" ? task.result.provider : null;
      if (provider === "mock_provider") {
        this.logger.warn({ feature: "scheduler", slot, provider }, "Skipped bulletin push because the task fell back to mock_provider.");
        await this.pushText(await this.composeHotTopicPushText(bulletinLabel, "生成失败：真实网页模型当前不可用，本次未推送演示内容。"));
        return;
      }
      await this.pushText(await this.composeHotTopicPushText(bulletinLabel, answer));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, "Daily hot topics push failed");
      const userFacingDetail = /审核未通过/u.test(detail)
        ? "格式审核未通过，本次快讯已跳过。"
        : summarizeText(detail, 200);
      await this.pushText(`今日热点推送失败：${userFacingDetail}`).catch(() => undefined);
    }
  }

  private async checkWeatherAlerts(): Promise<void> {
    const config = this.env.scheduler.weather;
    if (!config.enabled) {
      return;
    }
    await this.ensureStateLoaded();

    try {
      const forecast = await fetchWeatherForecast(config.latitude, config.longitude);
      const alert = detectWeatherChangeAlert(forecast, config.location, config.alertWindowHours);
      if (!alert) {
        return;
      }

      const now = Date.now();
      if (alert.key === this.lastWeatherAlertKey) {
        return;
      }

      if (this.lastWeatherAlertAt > 0 && now - this.lastWeatherAlertAt < getWeatherAlertCooldownMs(config.checkIntervalMinutes, config.alertWindowHours)) {
        return;
      }

      this.lastWeatherAlertKey = alert.key;
      this.lastWeatherAlertAt = now;
      await this.persistState();
      await this.pushText(alert.message);
    } catch (error) {
      this.logger.warn({ err: error }, "Weather alert check failed");
    }
  }

  private async checkGoldAlerts(): Promise<void> {
    const config = this.env.scheduler.gold;
    if (!config.enabled) {
      return;
    }
    await this.ensureStateLoaded();

    try {
      const current = await fetchGoldPriceCny();
      if (this.lastGoldBaseline == null) {
        this.lastGoldBaseline = current;
        this.lastGoldRoutinePushAt = Date.now();
        await this.persistState();
        await this.pushText(
          `金价监测已启动
当前金价约 ${current.toFixed(2)} 元/克，提醒阈值 ${config.thresholdCny} 元/克。`,
        );
        return;
      }

      const now = Date.now();
      if (shouldPushGoldRoutine(now, this.lastGoldRoutinePushAt, config.routinePushIntervalHours ?? 6)) {
        this.lastGoldRoutinePushAt = now;
        await this.persistState();
        await this.pushText(`金价播报\n当前金价约 ${current.toFixed(2)} 元/克。监测阈值：±${config.thresholdCny} 元/克。`);
      }

      const delta = current - this.lastGoldBaseline;
      if (Math.abs(delta) < config.thresholdCny) {
        return;
      }

      if (now - this.lastGoldAlertAt < 10 * 60_000) {
        return;
      }

      this.lastGoldAlertAt = now;
      this.lastGoldBaseline = current;
      await this.persistState();
      const direction = delta > 0 ? "上涨" : "下跌";
      await this.pushText(
        `金价提醒\n当前金价约 ${current.toFixed(2)} 元/克，较上次监测基准 ${direction} ${Math.abs(delta).toFixed(2)} 元/克，已超过阈值 ${config.thresholdCny} 元/克。`,
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Gold alert check failed");
    }
  }

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) {
      return;
    }

    this.stateLoaded = true;
    try {
      const raw = await readFile(this.env.scheduler.stateFile, "utf8");
      const parsed = JSON.parse(raw) as SchedulerState;
      for (const slot of parsed.hotTopicRuns ?? []) {
        if (typeof slot === "string" && slot.length > 0) {
          this.hotTopicRuns.add(slot);
        }
      }
      this.lastWeatherAlertKey = typeof parsed.lastWeatherAlertKey === "string" ? parsed.lastWeatherAlertKey : null;
      this.lastWeatherAlertAt = typeof parsed.lastWeatherAlertAt === "number" ? parsed.lastWeatherAlertAt : 0;
      this.lastGoldBaseline = typeof parsed.lastGoldBaseline === "number" && Number.isFinite(parsed.lastGoldBaseline)
        ? parsed.lastGoldBaseline
        : null;
      this.lastGoldAlertAt = typeof parsed.lastGoldAlertAt === "number" ? parsed.lastGoldAlertAt : 0;
      this.lastGoldRoutinePushAt = typeof parsed.lastGoldRoutinePushAt === "number" ? parsed.lastGoldRoutinePushAt : 0;
      this.lastFeishuChatId = typeof parsed.lastFeishuChatId === "string" ? parsed.lastFeishuChatId : null;
      this.lastGitHubTrendingDigest = typeof parsed.lastGitHubTrendingDigest === "string" ? parsed.lastGitHubTrendingDigest : null;
      this.lastGitHubTrendingFetchedAt = typeof parsed.lastGitHubTrendingFetchedAt === "number" ? parsed.lastGitHubTrendingFetchedAt : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        this.logger.warn({ err: error }, "Failed to load scheduler state");
      }
    }
  }

  private async persistState(): Promise<void> {
    const payload: SchedulerState = {
      hotTopicRuns: Array.from(this.hotTopicRuns).sort().slice(-32),
      lastWeatherAlertKey: this.lastWeatherAlertKey,
      lastWeatherAlertAt: this.lastWeatherAlertAt,
      lastGoldBaseline: this.lastGoldBaseline,
      lastGoldAlertAt: this.lastGoldAlertAt,
      lastGoldRoutinePushAt: this.lastGoldRoutinePushAt,
      lastFeishuChatId: this.lastFeishuChatId,
      lastGitHubTrendingDigest: this.lastGitHubTrendingDigest,
      lastGitHubTrendingFetchedAt: this.lastGitHubTrendingFetchedAt,
    };

    this.stateWriteChain = this.stateWriteChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.env.scheduler.stateFile), { recursive: true });
        await writeFile(this.env.scheduler.stateFile, JSON.stringify(payload, null, 2), "utf8");
      });

    await this.stateWriteChain;
  }

  private getLockFilePath(): string {
    return `${this.env.scheduler.stateFile}.lock`;
  }

  private async acquireProcessLock(): Promise<boolean> {
    const lockFile = this.getLockFilePath();
    await mkdir(dirname(lockFile), { recursive: true });
    const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockFile, "wx");
        try {
          await handle.writeFile(payload, "utf8");
        } finally {
          await handle.close();
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("EEXIST")) {
          throw error;
        }

        try {
          const raw = await readFile(lockFile, "utf8");
          if (!raw.trim()) {
            return false;
          }
          const parsed = JSON.parse(raw) as { pid?: number };
          const existingPid = typeof parsed.pid === "number" ? parsed.pid : null;
          if (existingPid && isProcessAlive(existingPid)) {
            return false;
          }
          if (!existingPid) {
            return false;
          }
        } catch {
          // Treat unreadable lock files as "another process is still starting"
          // so we do not delete an in-flight lock and start duplicate schedulers.
          return false;
        }

        await rm(lockFile, { force: true }).catch(() => undefined);
      }
    }

    return false;
  }

  private async hasExistingHotTopicTask(slot: string): Promise<boolean> {
    const items = await this.store.listTasks(120);
    for (const item of items) {
      const task = await this.store.getTask(item.id);
      if (!task || task.source !== "scheduler") {
        continue;
      }

      const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
      if (sourceMeta.schedulerKind !== "daily_hot_topics") {
        continue;
      }
      if (sourceMeta.scheduledAt !== slot) {
        continue;
      }

      return true;
    }

    return false;
  }

  private getHotTopicSlotLockPath(slot: string): string {
    const sanitized = slot.replace(/[:\s]/g, "_");
    return `${this.env.scheduler.stateFile}.${sanitized}.slot`;
  }

  private async acquireHotTopicSlotLock(slot: string): Promise<boolean> {
    const lockFile = this.getHotTopicSlotLockPath(slot);
    await mkdir(dirname(lockFile), { recursive: true });

    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, slot, createdAt: new Date().toISOString() }, null, 2), "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("EEXIST")) {
        return false;
      }
      throw error;
    }
  }

  private async pushText(text: string): Promise<void> {
    if (this.pushDisabled) {
      this.logger.warn({ feature: "scheduler" }, "Push skipped: Feishu credentials not configured.");
      return;
    }

    try {
      const preferredChatId = this.env.feishu.defaultChatId || this.lastFeishuChatId;
      if (preferredChatId) {
        await this.feishuBot.pushTextToChat(preferredChatId, text);
        return;
      }

      const inferredChatId = await this.findLatestFeishuChatId();
      if (!inferredChatId) {
        this.logger.warn({ feature: "scheduler" }, "Scheduler has no FEISHU_DEFAULT_CHAT_ID and could not infer a recent chat.");
        return;
      }

      this.lastFeishuChatId = inferredChatId;
      await this.persistState();
      await this.feishuBot.pushTextToChat(inferredChatId, text);
    } catch (error) {
      this.logger.error({ err: error, feature: "scheduler" }, "Failed to push text to Feishu chat");
    }
  }

  private async composeHotTopicPushText(bulletinLabel: string, rawAnswer: string): Promise<string> {
    const bulletinBody = normalizeBulletinBody(rawAnswer, bulletinLabel) || "今日热点暂时未生成成功。";
    const githubDigest = await this.getGitHubTrendingDigest();
    return [
      bulletinLabel,
      summarizeText(bulletinBody, 1_600),
      githubDigest,
    ]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join("\n\n");
  }

  private async getGitHubTrendingDigest(): Promise<string | null> {
    const now = Date.now();
    if (this.lastGitHubTrendingDigest && now - this.lastGitHubTrendingFetchedAt < GITHUB_TRENDING_CACHE_TTL_MS) {
      return this.lastGitHubTrendingDigest;
    }

    try {
      const project = await fetchGitHubTrendingProject();
      const digest = formatGitHubTrendingDigest(project);
      if (!digest) {
        return this.lastGitHubTrendingDigest;
      }

      this.lastGitHubTrendingDigest = digest;
      this.lastGitHubTrendingFetchedAt = now;
      await this.persistState();
      return digest;
    } catch (error) {
      this.logger.warn({ err: error }, "GitHub trending project fetch failed");
      return this.lastGitHubTrendingDigest;
    }
  }

  private async runSchedulerTask(submission: Omit<TaskSubmission, "source">): Promise<TaskRecord> {
    const queued = await this.orchestrator.submitTask({
      ...submission,
      source: "scheduler",
    });
    const task = await waitForTaskCompletion(this.store, queued.taskId, 15 * 60_000);
    if (!task) {
      throw new Error(`Scheduled task ${queued.taskId} timed out.`);
    }
    if (task.status !== "completed") {
      throw new Error(task.error ?? `Scheduled task ${queued.taskId} finished with status ${task.status}.`);
    }
    return task;
  }

  private async findLatestFeishuChatId(): Promise<string | null> {
    const items = await this.store.listTasks(50);
    for (const item of items) {
      const task = await this.store.getTask(item.id);
      if (!task || task.source !== "feishu") {
        continue;
      }

      const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
      if (typeof sourceMeta.chatId === "string" && sourceMeta.chatId.length > 0) {
        return sourceMeta.chatId;
      }
    }

    return null;
  }
}

async function waitForTaskCompletion(store: TaskStore, taskId: string, timeoutMs: number): Promise<TaskRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await store.getTask(taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      return task;
    }

    await delay(3_000);
  }

  return store.getTask(taskId);
}

function isTerminalTaskStatus(status: string): boolean {
  return [
    "completed",
    "failed",
    "needs_browser_launch",
    "provider_session_lost",
    "needs_manual_login",
    "needs_human_intervention",
  ].includes(status);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalDateTime(date: Date): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function getBulletinLabel(time: string): string {
  if (time === "08:00") return "08:00 前沿快讯";
  if (time === "12:00") return "12:00 前沿快讯";
  if (time === "16:00") return "16:00 前沿快讯";
  if (time === "20:00") return "20:00 前沿快讯";
  return `${time} 前沿快讯`;
}

function buildFrontierDigestPrompt(label: string, slotTime: string): string {
  return [
    `请输出一份“${label}”。`,
    "主题只保留三组：",
    "1. AI / 大模型热点",
    "2. SLAM / 自动驾驶前沿",
    "3. 具身智能热点",
    "输出结构固定：",
    `标题：一行，带上 ${slotTime}`,
    "AI / 大模型：2-3 条",
    "SLAM / 自动驾驶：1-2 条",
    "具身智能：1-2 条",
    "最后补 1 行“影响判断”",
    "每条最多两句：先说发生了什么，再说为什么值得关注。",
    "优先覆盖更广的可验证信源：模型厂商官方博客 / 发布页 / X，Hugging Face，GitHub Releases，机器之心、量子位、智东西，以及自动驾驶和机器人公司的官方渠道。",
    "要求：",
    "- 优先写最近 4 小时内的新动态；如果 4 小时内确实没有高信号更新，可补充近 24 小时内仍值得关注的进展，并在该条前标注“【近24小时】”",
    "- 不要寒暄，不要自我解释，不要写来源列表",
    "- 如果某一栏没有高信号更新，直接写“暂无高信号更新”",
    "- 只输出最终可推送正文",
  ].join("\n");
}

interface OpenMeteoForecast {
  hourly: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability: number[];
    weather_code: number[];
    wind_speed_10m: number[];
  };
}

async function fetchWeatherForecast(latitude: number, longitude: number): Promise<OpenMeteoForecast> {
  const url = new URL(WEATHER_ENDPOINT);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("hourly", "temperature_2m,precipitation_probability,weather_code,wind_speed_10m");
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", SHANGHAI_TIMEZONE);
  return (await fetchJsonWithRetry(url, "Open-Meteo weather")) as OpenMeteoForecast;
}

function detectWeatherChangeAlert(
  forecast: OpenMeteoForecast,
  location: string,
  alertWindowHours: number,
): { key: string; message: string } | null {
  const now = new Date();
  const times = forecast.hourly.time.map((entry) => new Date(entry));
  const currentIndex = Math.max(0, times.findIndex((time) => time.getTime() >= now.getTime()) - 1);
  const current = readWeatherPoint(forecast, Math.max(0, currentIndex));
  if (!current) {
    return null;
  }

  for (let index = currentIndex + 1; index < times.length; index += 1) {
    const hoursAhead = (times[index].getTime() - now.getTime()) / 3_600_000;
    if (hoursAhead < 0 || hoursAhead > alertWindowHours) {
      continue;
    }

    const next = readWeatherPoint(forecast, index);
    if (!next) {
      continue;
    }

    const categoryChanged = weatherCategory(current.code) !== weatherCategory(next.code);
    const rainIncoming = current.precipitationProbability < 40 && next.precipitationProbability >= 60;
    const tempDrop = current.temperature - next.temperature >= 6;
    const tempRise = next.temperature - current.temperature >= 6;
    const windRise = current.windSpeed < 25 && next.windSpeed >= 35;

    if (!(categoryChanged || rainIncoming || tempDrop || tempRise || windRise)) {
      continue;
    }

    const changeTime = new Intl.DateTimeFormat("zh-CN", {
      timeZone: SHANGHAI_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(times[index]);
    const reasons: string[] = [];
    if (categoryChanged) reasons.push(`${weatherLabel(current.code)}转${weatherLabel(next.code)}`);
    if (rainIncoming) reasons.push(`降水概率升至${Math.round(next.precipitationProbability)}%`);
    if (tempDrop) reasons.push(`预计降温${Math.round(current.temperature - next.temperature)}°C`);
    if (tempRise) reasons.push(`预计升温${Math.round(next.temperature - current.temperature)}°C`);
    if (windRise) reasons.push(`阵风增强至${Math.round(next.windSpeed)} km/h`);
    const reasonKinds = [
      categoryChanged ? `${weatherCategory(current.code)}_to_${weatherCategory(next.code)}` : null,
      rainIncoming ? "rain_incoming" : null,
      tempDrop ? "temp_drop" : null,
      tempRise ? "temp_rise" : null,
      windRise ? "wind_rise" : null,
    ].filter((value): value is string => Boolean(value));
    const alertBucketMs = 3 * 3_600_000;
    const alertBucketStart = Math.floor(times[index].getTime() / alertBucketMs) * alertBucketMs;

    return {
      key: `${location}:${new Date(alertBucketStart).toISOString()}:${reasonKinds.join("|")}`,
      message: `${location}天气提醒\n预计 ${changeTime} 左右天气将有明显变化：${reasons.join("，")}。`,
    };
  }

  return null;
}

function readWeatherPoint(forecast: OpenMeteoForecast, index: number): {
  code: number;
  temperature: number;
  precipitationProbability: number;
  windSpeed: number;
} | null {
  const code = forecast.hourly.weather_code[index];
  const temperature = forecast.hourly.temperature_2m[index];
  const precipitationProbability = forecast.hourly.precipitation_probability[index];
  const windSpeed = forecast.hourly.wind_speed_10m[index];
  if ([code, temperature, precipitationProbability, windSpeed].some((value) => typeof value !== "number" || Number.isNaN(value))) {
    return null;
  }
  return { code, temperature, precipitationProbability, windSpeed };
}

function weatherCategory(code: number): string {
  if ([95, 96, 99].includes(code)) return "thunder";
  if ([61, 63, 65, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([45, 48].includes(code)) return "fog";
  if ([1, 2, 3].includes(code)) return "cloud";
  return "clear";
}

function weatherLabel(code: number): string {
  switch (weatherCategory(code)) {
    case "thunder":
      return "雷雨";
    case "rain":
      return "降雨";
    case "snow":
      return "降雪";
    case "fog":
      return "雾";
    case "cloud":
      return "多云";
    default:
      return "晴好";
  }
}

async function fetchGoldPriceCny(): Promise<number> {
  const goldPayload = (await fetchJsonWithRetry(
    new URL(GOLD_API_ENDPOINT),
    "Gold API gold spot",
    { attempts: 2, timeoutMs: 8_000 },
  )) as Record<string, any>;
  const fxPayload = (await fetchJsonWithRetry(
    new URL(USD_CNY_RATE_ENDPOINT),
    "Frankfurter USD/CNY",
    { attempts: 2, timeoutMs: 8_000 },
  )) as Record<string, any>;

  const goldUsd = Number.parseFloat(String(goldPayload.price ?? ""));
  const usdCny = Number.parseFloat(String(fxPayload.rate ?? ""));

  if (!Number.isFinite(goldUsd)) {
    const note = typeof goldPayload.error === "string"
      ? goldPayload.error
      : JSON.stringify(goldPayload).slice(0, 240);
    throw new Error(`Invalid gold price payload: ${note}`);
  }

  if (!Number.isFinite(usdCny)) {
    const note = typeof fxPayload.message === "string"
      ? fxPayload.message
      : JSON.stringify(fxPayload).slice(0, 240);
    throw new Error(`Invalid USD/CNY payload: ${note}`);
  }

  return (goldUsd * usdCny) / TROY_OUNCE_IN_GRAMS;
}

async function fetchGitHubTrendingProject(): Promise<GitHubTrendingProject | null> {
  const lookbackDate = new Date(Date.now() - GITHUB_TRENDING_LOOKBACK_DAYS * 24 * 3_600_000);
  const since = lookbackDate.toISOString().slice(0, 10);
  const url = new URL(GITHUB_SEARCH_API_ENDPOINT);
  url.searchParams.set("q", `created:>=${since} archived:false mirror:false stars:>=20`);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "8");

  const payload = (await fetchJsonWithRetry(
    url,
    "GitHub repository search",
    {
      attempts: 2,
      timeoutMs: 8_000,
      init: {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "office-agent-scheduler",
        },
      },
    },
  )) as GitHubSearchResponse;

  const items = Array.isArray(payload.items) ? payload.items : [];
  const picked = pickFrontierRelevantGitHubProject(items);
  if (!picked) {
    return null;
  }

  return {
    fullName: picked.full_name,
    htmlUrl: picked.html_url,
    description: picked.description,
    language: picked.language,
    stars: picked.stargazers_count,
  };
}

async function fetchJsonWithRetry(
  url: URL,
  label: string,
  options: { attempts?: number; timeoutMs?: number; init?: RequestInit } = {},
): Promise<unknown> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...(options.init ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`${label} request failed: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} request failed.`);
}

interface SchedulerState {
  hotTopicRuns?: string[];
  lastWeatherAlertKey?: string | null;
  lastWeatherAlertAt?: number;
  lastGoldBaseline?: number | null;
  lastGoldAlertAt?: number;
  lastGoldRoutinePushAt?: number;
  lastFeishuChatId?: string | null;
  lastGitHubTrendingDigest?: string | null;
  lastGitHubTrendingFetchedAt?: number;
}

interface GitHubSearchResponse {
  items?: GitHubSearchItem[];
}

interface GitHubSearchItem {
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  topics?: string[];
}

interface GitHubTrendingProject {
  fullName: string;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  stars: number;
}

function getWeatherAlertCooldownMs(checkIntervalMinutes: number, alertWindowHours: number): number {
  const minimumMinutes = Math.max(90, checkIntervalMinutes * 3);
  const maximumMinutes = Math.max(90, alertWindowHours * 60);
  return Math.min(minimumMinutes, maximumMinutes) * 60_000;
}

function shouldPushGoldRoutine(now: number, lastPushAt: number, routinePushIntervalHours: number): boolean {
  const intervalMs = Math.max(1, routinePushIntervalHours) * 3_600_000;
  return lastPushAt <= 0 || now - lastPushAt >= intervalMs;
}

function normalizeBulletinBody(rawAnswer: string, bulletinLabel: string): string {
  const cleaned = rawAnswer.replace(/\r\n/g, "\n").trim();
  if (!cleaned) {
    return "";
  }

  const lines = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index) => index > 0 || line.trim().length > 0);

  if (lines[0]?.trim() === bulletinLabel) {
    lines.shift();
  }

  return lines.join("\n").trim();
}

function pickFrontierRelevantGitHubProject(items: GitHubSearchItem[]): GitHubSearchItem | null {
  const scored = items
    .filter((item) => typeof item.full_name === "string" && item.full_name.length > 0 && typeof item.html_url === "string" && item.html_url.length > 0)
    .map((item) => ({
      item,
      score: scoreGitHubProject(item),
    }))
    .sort((left, right) => right.score - left.score || right.item.stargazers_count - left.item.stargazers_count);

  return scored[0]?.item ?? null;
}

function scoreGitHubProject(item: GitHubSearchItem): number {
  const combined = `${item.full_name} ${item.description ?? ""} ${(item.topics ?? []).join(" ")}`.toLowerCase();
  const frontierKeywords = [
    "ai",
    "agent",
    "llm",
    "model",
    "rag",
    "robot",
    "robotics",
    "embodied",
    "slam",
    "autonomous",
    "driving",
    "vision",
  ];
  const keywordHits = frontierKeywords.filter((keyword) => combined.includes(keyword)).length;
  return keywordHits * 1_000 + Math.min(item.stargazers_count, 999);
}

function formatGitHubTrendingDigest(project: GitHubTrendingProject | null): string | null {
  if (!project) {
    return null;
  }

  const description = summarizeText(
    project.description?.trim() || "仓库暂未填写描述，但近 7 天热度较高。",
    160,
  );
  const language = project.language?.trim() || "未标注语言";
  return [
    `GitHub 热门项目：${project.fullName}（${language}，${formatCompactNumber(project.stars)} stars）`,
    `简介：${description}`,
    `链接：${project.htmlUrl}`,
  ].join("\n");
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (value >= 10_000) {
    return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}w`;
  }
  return String(Math.round(value));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
