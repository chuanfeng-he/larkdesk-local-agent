import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import initSqlJs from "sql.js";

const DEFAULT_DATABASE_URL = "file:../../../data/office-agent.db";

async function main(): Promise<void> {
  const SQL = await initSqlJs({});
  const dbPath = resolveDatabasePath(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  await mkdir(dirname(dbPath), { recursive: true });

  const existing = existsSync(dbPath) ? await readFile(dbPath) : undefined;
  const db = existing ? new SQL.Database(existing) : new SQL.Database();

  db.run(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS Task (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      sourceMetaJson TEXT,
      userInput TEXT NOT NULL,
      normalizedInput TEXT NOT NULL,
      summary TEXT,
      outputSummary TEXT,
      resultJson TEXT,
      error TEXT,
      cacheKey TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completedAt DATETIME
    );

    CREATE INDEX IF NOT EXISTS Task_status_createdAt_idx ON Task(status, createdAt);
    CREATE INDEX IF NOT EXISTS Task_cacheKey_idx ON Task(cacheKey);

    CREATE TABLE IF NOT EXISTS TaskStep (
      id TEXT PRIMARY KEY NOT NULL,
      taskId TEXT NOT NULL,
      phase TEXT NOT NULL,
      provider TEXT,
      status TEXT NOT NULL,
      inputSummary TEXT,
      outputSummary TEXT,
      metaJson TEXT,
      startedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      endedAt DATETIME,
      FOREIGN KEY(taskId) REFERENCES Task(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS TaskStep_taskId_startedAt_idx ON TaskStep(taskId, startedAt);

    CREATE TABLE IF NOT EXISTS ProviderState (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      lastError TEXT,
      recoveryHint TEXT,
      metaJson TEXT,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checkedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS CacheEntry (
      id TEXT PRIMARY KEY NOT NULL,
      key TEXT NOT NULL UNIQUE,
      taskType TEXT NOT NULL,
      valueJson TEXT NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS KnowledgeEntry (
      id TEXT PRIMARY KEY NOT NULL,
      key TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'global',
      kind TEXT NOT NULL,
      layer TEXT NOT NULL DEFAULT 'long_term',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      tagsJson TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      source TEXT,
      sourceTaskId TEXT,
      pinned BOOLEAN NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lastAccessedAt DATETIME,
      FOREIGN KEY(sourceTaskId) REFERENCES Task(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS KnowledgeEntry_kind_updatedAt_idx ON KnowledgeEntry(kind, updatedAt);
    CREATE INDEX IF NOT EXISTS KnowledgeEntry_sourceTaskId_idx ON KnowledgeEntry(sourceTaskId);
    CREATE INDEX IF NOT EXISTS KnowledgeEntry_pinned_updatedAt_idx ON KnowledgeEntry(pinned, updatedAt);

    CREATE TABLE IF NOT EXISTS ApprovalPolicy (
      id TEXT PRIMARY KEY NOT NULL,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      enabled BOOLEAN NOT NULL DEFAULT 1,
      mode TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      matchTaskTypesJson TEXT,
      matchIntentsJson TEXT,
      matchArtifactsJson TEXT,
      matchRunnersJson TEXT,
      matchKeywordsJson TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ApprovalPolicy_enabled_priority_idx ON ApprovalPolicy(enabled, priority);

    CREATE TABLE IF NOT EXISTS ApprovalRequest (
      id TEXT PRIMARY KEY NOT NULL,
      taskId TEXT,
      policyKey TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL,
      detail TEXT,
      runner TEXT,
      source TEXT,
      decisionNote TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decidedAt DATETIME,
      FOREIGN KEY(taskId) REFERENCES Task(id) ON DELETE SET NULL,
      FOREIGN KEY(policyKey) REFERENCES ApprovalPolicy(key) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS ApprovalRequest_status_createdAt_idx ON ApprovalRequest(status, createdAt);
    CREATE INDEX IF NOT EXISTS ApprovalRequest_taskId_idx ON ApprovalRequest(taskId);
    CREATE INDEX IF NOT EXISTS ApprovalRequest_policyKey_idx ON ApprovalRequest(policyKey);
  `);

  ensureColumn(db, "KnowledgeEntry", "layer", "ALTER TABLE KnowledgeEntry ADD COLUMN layer TEXT NOT NULL DEFAULT 'long_term';");
  ensureColumn(db, "KnowledgeEntry", "importance", "ALTER TABLE KnowledgeEntry ADD COLUMN importance INTEGER NOT NULL DEFAULT 50;");
  db.run("CREATE INDEX IF NOT EXISTS KnowledgeEntry_layer_updatedAt_idx ON KnowledgeEntry(layer, updatedAt);");

  const data = db.export();
  await writeFile(dbPath, Buffer.from(data));
  db.close();
  console.log(`Initialized SQLite schema at ${dbPath}`);
}

function ensureColumn(db: any, table: string, column: string, statement: string): void {
  const rows = db.exec(`PRAGMA table_info(${table});`) as Array<{ values?: unknown[][] }>;
  const values = rows[0]?.values ?? [];
  const exists = values.some((entry) => String(entry[1]) === column);
  if (!exists) {
    db.run(statement);
  }
}

function resolveDatabasePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    return resolve(process.cwd(), "data/office-agent.db");
  }

  const relativePath = databaseUrl.slice("file:".length);
  if (relativePath.startsWith("/")) {
    return relativePath;
  }

  return resolve(process.cwd(), "packages/storage/prisma", relativePath);
}

void main();
