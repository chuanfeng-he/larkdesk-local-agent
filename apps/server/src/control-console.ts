export function buildControlConsoleHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>IAI 控制台</title>
    <style>
      :root {
        --bg: #f3efe6;
        --panel: rgba(255,255,255,0.82);
        --line: rgba(36,31,26,0.12);
        --ink: #221c17;
        --muted: #6f655b;
        --accent: #0d6b5f;
        --warn: #d26a2e;
        --bad: #b4442f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(13,107,95,0.16), transparent 32%),
          radial-gradient(circle at top right, rgba(210,106,46,0.14), transparent 28%),
          linear-gradient(180deg, #f5f1e8 0%, #ebe3d5 100%);
      }
      .shell { max-width: 1320px; margin: 0 auto; padding: 28px 20px 40px; }
      .hero { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 18px; }
      .hero h1 { margin: 0; font-size: 32px; }
      .hero p { margin: 8px 0 0; color: var(--muted); }
      .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
      .panel {
        grid-column: span 12;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 18px;
        backdrop-filter: blur(10px);
        box-shadow: 0 18px 48px rgba(51,40,28,0.08);
      }
      .panel h2 { margin: 0 0 12px; font-size: 18px; }
      .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
      .stat { background: rgba(255,255,255,0.68); border: 1px solid var(--line); border-radius: 16px; padding: 14px; }
      .stat .k { font-size: 24px; font-weight: 700; }
      .stat .v { color: var(--muted); margin-top: 6px; }
      .cols { display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; }
      .stack { display: grid; gap: 12px; }
      .card {
        background: rgba(255,255,255,0.76);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px;
      }
      .row { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
      .title { font-weight: 700; }
      .sub, .muted { color: var(--muted); }
      .sub { margin-top: 6px; line-height: 1.45; }
      .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .pill {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 5px 10px;
        font-size: 12px;
        background: rgba(34,28,23,0.06);
      }
      .pill.warn { background: rgba(210,106,46,0.14); color: #8e471b; }
      .pill.bad { background: rgba(180,68,47,0.14); color: #8b2f21; }
      .pill.good { background: rgba(13,107,95,0.14); color: #0d6b5f; }
      .actions { display: flex; gap: 8px; margin-top: 12px; }
      button {
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        font-weight: 700;
        cursor: pointer;
        background: var(--ink);
        color: white;
      }
      button.alt { background: rgba(34,28,23,0.12); color: var(--ink); }
      button.warn { background: var(--warn); }
      button.bad { background: var(--bad); }
      .split { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
      @media (max-width: 980px) {
        .stats, .split, .cols { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <div>
          <h1>IAI 控制台</h1>
          <p>审批中心、控制台、分层记忆、技能包统一入口</p>
        </div>
        <button class="alt" onclick="refreshAll()">刷新</button>
      </div>

      <section class="panel">
        <div class="stats">
          <div class="stat"><div class="k" id="stat-tasks">-</div><div class="v">活跃任务</div></div>
          <div class="stat"><div class="k" id="stat-approvals">-</div><div class="v">待批项目</div></div>
          <div class="stat"><div class="k" id="stat-memory">-</div><div class="v">记忆条目</div></div>
          <div class="stat"><div class="k" id="stat-packs">-</div><div class="v">技能包</div></div>
        </div>
        <div class="cols">
          <div class="stack">
            <div class="card">
              <div class="row">
                <div class="title">待审批</div>
                <div class="muted" id="approval-updated">-</div>
              </div>
              <div id="approvals" class="stack" style="margin-top:12px"></div>
            </div>
            <div class="card">
              <div class="row">
                <div class="title">审批策略</div>
                <div class="muted">控制中心默认规则</div>
              </div>
              <div id="policies" class="stack" style="margin-top:12px"></div>
            </div>
          </div>
          <div class="stack">
            <div class="card">
              <div class="row">
                <div class="title">分层记忆</div>
                <div class="muted">working / episodic / long_term</div>
              </div>
              <div id="memory" class="split" style="margin-top:12px"></div>
            </div>
            <div class="card">
              <div class="row">
                <div class="title">技能包</div>
                <div class="muted">任务能力装配</div>
              </div>
              <div id="packs" class="stack" style="margin-top:12px"></div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel" style="margin-top:16px">
        <div class="row">
          <div class="title">活跃任务</div>
          <div class="muted">来自现有监控快照</div>
        </div>
        <div id="tasks" class="stack" style="margin-top:12px"></div>
      </section>
    </div>
    <script>
      const finalStatuses = new Set(["completed", "failed", "needs_browser_launch", "provider_session_lost", "needs_manual_login", "needs_human_intervention"]);

      async function getJson(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error("请求失败: " + response.status);
        return response.json();
      }

      async function post(url) {
        const response = await fetch(url, { method: "POST" });
        if (!response.ok) throw new Error("请求失败: " + response.status);
        return response.json().catch(() => ({}));
      }

      function pill(text, cls = "") {
        return '<span class="pill ' + cls + '">' + text + '</span>';
      }

      function renderApprovals(items) {
        const root = document.getElementById("approvals");
        if (!items.length) {
          root.innerHTML = '<div class="card">当前没有待审批项目</div>';
          return;
        }
        root.innerHTML = items.map((item) => {
          const taskTag = item.taskId ? pill("任务 " + item.taskId) : "";
          const runnerTag = item.runner ? pill(item.runner) : "";
          const actions = item.taskId ? '<div class="actions"><button onclick="approveTask(\\'' + item.taskId + '\\')">批准</button><button class="bad" onclick="rejectTask(\\'' + item.taskId + '\\')">拒绝</button></div>' : "";
          return '<div class="card"><div class="row"><div class="title">' + item.summary + '</div>' + pill(item.status, item.status === "pending" ? "warn" : "") + '</div><div class="sub">' + (item.detail || "-") + '</div><div class="meta">' + pill(item.kind) + taskTag + runnerTag + pill(item.createdAt || "-") + '</div>' + actions + '</div>';
        }).join("");
      }

      function renderPolicies(items) {
        const root = document.getElementById("policies");
        root.innerHTML = items.map((item) => {
          const tags = [
            pill("模式 " + item.mode, item.mode === "manual" ? "warn" : item.mode === "auto" ? "good" : ""),
            pill("优先级 " + item.priority),
            item.matchRunners?.length ? pill("Runner " + item.matchRunners.join("/")) : "",
          ].join("");
          return '<div class="card"><div class="row"><div class="title">' + item.name + '</div>' + (item.enabled ? pill("启用", "good") : pill("停用", "bad")) + '</div><div class="sub">' + (item.description || "-") + '</div><div class="meta">' + tags + '</div></div>';
        }).join("") || '<div class="card">暂无审批策略</div>';
      }

      function renderMemory(items) {
        const root = document.getElementById("memory");
        const groups = {
          working: { title: "工作记忆", items: [] },
          episodic: { title: "情景记忆", items: [] },
          long_term: { title: "长期记忆", items: [] }
        };
        items.forEach((item) => {
          if (groups[item.layer]) groups[item.layer].items.push(item);
        });
        root.innerHTML = Object.entries(groups).map(([key, group]) => {
          const cards = group.items.slice(0, 4).map((item) => '<div class="card"><div class="title">' + item.title + '</div><div class="sub">' + (item.summary || item.content || "-") + '</div><div class="meta">' + pill(item.kind) + pill("重要度 " + item.importance) + '</div></div>').join("");
          return '<div><div class="title" style="margin-bottom:10px">' + group.title + '</div>' + (cards || '<div class="card">暂无</div>') + '</div>';
        }).join("");
      }

      function renderPacks(items) {
        const root = document.getElementById("packs");
        root.innerHTML = items.map((item) => '<div class="card"><div class="row"><div class="title">' + item.name + '</div>' + (item.enabled ? pill("启用", "good") : pill("停用", "bad")) + '</div><div class="sub">' + item.description + '</div><div class="meta">' + pill("技能 " + item.skillIds.length) + (item.toolHints?.length ? pill("工具 " + item.toolHints.join("/")) : "") + (item.memoryLayers?.length ? pill("记忆 " + item.memoryLayers.join("/")) : "") + '</div></div>').join("") || '<div class="card">暂无技能包</div>';
      }

      function renderTasks(items) {
        const root = document.getElementById("tasks");
        root.innerHTML = items.map((item) => {
          const workflow = item.workflow || {};
          const actions = !finalStatuses.has(item.status) ? '<div class="actions"><button class="alt" onclick="interveneTask(\\'' + item.taskId + '\\')">人工介入</button><button class="bad" onclick="stopTask(\\'' + item.taskId + '\\')">停止</button></div>' : "";
          return '<div class="card"><div class="row"><div><div class="title">' + item.taskId + '</div><div class="sub">' + (item.summary || "-") + '</div></div>' + pill(item.status, item.status === "completed" ? "good" : item.status === "failed" ? "bad" : "") + '</div><div class="meta">' + pill("意图 " + (workflow.intent || "-")) + pill("产物 " + (workflow.artifactType || "-")) + pill("技能包 " + ((workflow.selectedSkillPacks || []).length || 0)) + pill("审批 " + (workflow.approvalPlan?.mode || "observe")) + '</div>' + actions + '</div>';
        }).join("") || '<div class="card">暂无活跃任务</div>';
      }

      async function approveTask(taskId) {
        await post("/tasks/" + taskId + "/approve");
        await refreshAll();
      }
      async function rejectTask(taskId) {
        await post("/tasks/" + taskId + "/reject");
        await refreshAll();
      }
      async function stopTask(taskId) {
        await post("/tasks/" + taskId + "/stop");
        await refreshAll();
      }
      async function interveneTask(taskId) {
        await post("/tasks/" + taskId + "/intervene");
        await refreshAll();
      }

      async function refreshAll() {
        const [monitor, approvals, policies, memory, packs] = await Promise.all([
          getJson("/monitor"),
          getJson("/approvals?status=pending&limit=20"),
          getJson("/approval-policies"),
          getJson("/memory?limit=18"),
          getJson("/skill-packs")
        ]);

        const tasks = monitor.activeTasks || [];
        const approvalItems = approvals.approvals || [];
        const memoryItems = memory.entries || [];
        const skillPacks = packs.skillPacks || [];

        document.getElementById("stat-tasks").textContent = String(tasks.length);
        document.getElementById("stat-approvals").textContent = String(approvalItems.length);
        document.getElementById("stat-memory").textContent = String(memoryItems.length);
        document.getElementById("stat-packs").textContent = String(skillPacks.length);
        document.getElementById("approval-updated").textContent = new Date().toLocaleString("zh-CN");

        renderApprovals(approvalItems);
        renderPolicies(policies.policies || []);
        renderMemory(memoryItems);
        renderPacks(skillPacks);
        renderTasks(tasks);
      }

      refreshAll().catch((error) => {
        document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;right:16px;bottom:16px;background:#b4442f;color:#fff;padding:12px 14px;border-radius:12px">' + error.message + '</div>');
      });
      setInterval(() => { refreshAll().catch(() => {}); }, 8000);
    </script>
  </body>
</html>`;
}
