// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Sincronização do backlog (`jira/backlog.json`) com o Jira Cloud por REST.
 *
 *   node scripts/jira.ts whoami
 *   node scripts/jira.ts fields
 *   node scripts/jira.ts list
 *   node scripts/jira.ts seed [--dry-run]
 *   node scripts/jira.ts sync [--dry-run]
 *   node scripts/jira.ts self-test
 *
 * Credenciais vêm do ambiente ou de `.env` na raiz (que é ignorado pelo git):
 * JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BACKLOG = `${ROOT}jira/backlog.json`;

interface Story {
  summary: string;
  points: number;
  labels: string[];
  acceptance: string;
  jiraKey?: string;
}

interface Epic {
  name: string;
  summary: string;
  priority: string;
  stories: Story[];
  jiraKey?: string;
}

interface Backlog {
  project: { name: string; key: string; template: string; description: string; jiraKey?: string; jiraName?: string };
  epics: Epic[];
}

interface PlanItem {
  kind: "epic" | "task";
  key?: string;
  summary: string;
  description: string;
  labels: string[];
  parentName?: string;
  epicName?: string;
  points?: number;
}

function loadEnv(): void {
  const path = `${ROOT}.env`;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (process.env[name!] !== undefined) continue;
    process.env[name!] = rawValue!.replace(/^["']|["']$/g, "");
  }
}

function credentials(): { base: string; email: string; token: string } {
  const base = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!base || !email || !token) {
    throw new Error("defina JIRA_BASE_URL, JIRA_EMAIL e JIRA_API_TOKEN (copie .env.example para .env)");
  }
  return { base: base.replace(/\/+$/, ""), email, token };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { base, email, token } = credentials();
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization,
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${path}: ${text.slice(0, 300)}`);
  return (text === "" ? {} : JSON.parse(text)) as T;
}

function storyDescription(story: Story): string {
  return `Critério de aceite: ${story.acceptance}\n\nEstimativa: ${story.points} pontos.`;
}

function epicDescription(epic: Epic): string {
  return `${epic.summary}.\n\nPrioridade: ${epic.priority}.\n\nProjeto: FrankFrames — vídeo determinístico a partir de HTML.`;
}

/** Planejamento puro: o que criar, o que atualizar. Testável sem rede. */
export function plan(backlog: Backlog, existing: Map<string, string>, mode: "seed" | "sync"): PlanItem[] {
  const items: PlanItem[] = [];
  for (const epic of backlog.epics) {
    const epicKey = epic.jiraKey ?? existing.get(epic.name);
    if (epicKey === undefined) {
      items.push({ kind: "epic", summary: epic.name, description: epicDescription(epic), labels: [], epicName: epic.name, points: undefined });
    } else if (mode === "sync") {
      items.push({ kind: "epic", key: epicKey, summary: epic.name, description: epicDescription(epic), labels: [], epicName: epic.name });
    }
    for (const story of epic.stories) {
      const key = story.jiraKey ?? existing.get(story.summary);
      if (key === undefined) {
        items.push({
          kind: "task",
          summary: story.summary,
          description: storyDescription(story),
          labels: story.labels,
          parentName: epic.name,
          points: story.points,
        });
      } else if (mode === "sync") {
        items.push({
          kind: "task",
          key,
          summary: story.summary,
          description: storyDescription(story),
          labels: story.labels,
          parentName: epic.name,
          points: story.points,
        });
      }
    }
  }
  return items;
}

interface JiraIssue {
  key: string;
  fields: { summary: string; parent?: { key: string } };
}

async function searchProject(projectKey: string): Promise<Map<string, string>> {
  const jql = encodeURIComponent(`project = ${projectKey} ORDER BY key ASC`);
  const result = await api<{ issues?: JiraIssue[] }>(`/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=1000`).catch(() =>
    api<{ issues?: JiraIssue[] }>(`/rest/api/3/search?jql=${jql}&fields=summary&maxResults=1000`),
  );
  const map = new Map<string, string>();
  for (const issue of result.issues ?? []) map.set(issue.fields.summary, issue.key);
  return map;
}

let cachedPointsField: string | null | undefined;

async function storyPointsField(): Promise<string | null> {
  if (cachedPointsField !== undefined) return cachedPointsField;
  const fields = await api<Array<{ id: string; name: string }>>("/rest/api/3/field");
  const found = fields.find((field) => /^(story points|story point estimate)$/i.test(field.name));
  cachedPointsField = found?.id ?? null;
  return cachedPointsField;
}

async function createIssue(input: {
  projectKey: string;
  typeId: string;
  summary: string;
  description: string;
  labels: string[];
  parentKey?: string;
  points?: number;
}): Promise<string> {
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    issuetype: { id: input.typeId },
    summary: input.summary,
    description: input.description,
  };
  if (input.labels.length > 0) fields.labels = input.labels;
  if (input.parentKey !== undefined) fields.parent = { key: input.parentKey };

  const pointsField = input.points === undefined ? null : await storyPointsField();
  if (pointsField !== null) fields[pointsField] = input.points;

  try {
    const created = await api<{ key: string }>("/rest/api/2/issue", { method: "POST", body: JSON.stringify({ fields }) });
    return created.key;
  } catch (error) {
    if (pointsField === null) throw error;
    // Campo de estimativa fora da tela de create: recria sem ele.
    delete fields[pointsField];
    const created = await api<{ key: string }>("/rest/api/2/issue", { method: "POST", body: JSON.stringify({ fields }) });
    return created.key;
  }
}

async function updateIssue(key: string, input: { description: string; labels: string[]; points?: number }): Promise<void> {
  const fields: Record<string, unknown> = { description: input.description };
  if (input.labels.length > 0) fields.labels = input.labels;
  const pointsField = input.points === undefined ? null : await storyPointsField();
  if (pointsField !== null) fields[pointsField] = input.points;
  await api(`/rest/api/2/issue/${key}`, { method: "PUT", body: JSON.stringify({ fields }) }).catch(async (error) => {
    if (pointsField === null) throw error;
    delete fields[pointsField];
    await api(`/rest/api/2/issue/${key}`, { method: "PUT", body: JSON.stringify({ fields }) });
  });
}

function selfTest(): void {
  const stored = JSON.parse(readFileSync(BACKLOG, "utf8")) as Backlog;
  // Plano de primeira execução: sem nenhuma chave conhecida.
  const backlog: Backlog = structuredClone(stored);
  for (const epic of backlog.epics) {
    delete epic.jiraKey;
    for (const story of epic.stories) delete story.jiraKey;
  }
  const empty = new Map<string, string>();
  const created = plan(backlog, empty, "seed");
  const epicCount = created.filter((item) => item.kind === "epic").length;
  const taskCount = created.filter((item) => item.kind === "task").length;
  if (backlog.epics.length !== 8) throw new Error(`esperado 8 épicos, obtido ${backlog.epics.length}`);
  if (created.length !== 33) throw new Error(`esperado 33 itens no plano, obtido ${created.length}`);
  if (epicCount !== 8 || taskCount !== 25) throw new Error(`plano desbalanceado: ${epicCount}/${taskCount}`);
  for (const item of created) {
    if (!item.description.includes("Critério de aceite") && item.kind === "task") throw new Error(`sem critério: ${item.summary}`);
  }
  const known = new Map(created.map((i) => [i.summary, "EDT-999"]));
  const resync = plan(backlog, known, "sync");
  if (resync.some((item) => item.key === undefined)) throw new Error("sync deveria reaproveitar chaves existentes");
  const real = plan(stored, new Map(), "sync");
  if (real.length !== 33 || real.some((item) => item.key === undefined)) {
    throw new Error(`sync do backlog real deveria ter 33 itens com chave, obtido ${real.length}`);
  }
  process.stdout.write(`self-test ok: ${epicCount} épicos, ${taskCount} tarefas, ${resync.length} no plano, ${real.length} no sync\n`);
}

async function main(): Promise<void> {
  loadEnv();
  const [command, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");

  if (command === "self-test") return selfTest();

  const backlog = JSON.parse(readFileSync(BACKLOG, "utf8")) as Backlog;
  const projectKey = process.env.JIRA_PROJECT_KEY ?? backlog.project.jiraKey ?? "EDT";

  if (command === "whoami") {
    const me = await api<{ displayName: string; emailAddress: string; accountId: string }>("/rest/api/3/myself");
    process.stdout.write(`${me.displayName} <${me.emailAddress}> ${me.accountId}\n`);
    return;
  }

  if (command === "show") {
    const key = flags.find((flag) => !flag.startsWith("-"));
    if (key === undefined) {
      process.stderr.write("uso: node scripts/jira.ts show <chave>\n");
      process.exit(2);
    }
    const issue = await api<{ key: string; fields: { summary: string; description?: unknown; parent?: { key: string }; status?: { name: string }; labels?: string[] } }>(
      `/rest/api/3/issue/${key}?fields=summary,description,parent,status,labels`,
    );
    const description = issue.fields.description;
    process.stdout.write(`${issue.key} [${issue.fields.status?.name ?? "?"}] ${issue.fields.summary}\n`);
    if (issue.fields.parent) process.stdout.write(`pai: ${issue.fields.parent.key}\n`);
    if (issue.fields.labels?.length) process.stdout.write(`rótulos: ${issue.fields.labels.join(", ")}\n`);
    if (description !== undefined) {
      const text = typeof description === "string" ? description : JSON.stringify(description, null, 2);
      process.stdout.write(`---\n${text}\n`);
    }
    return;
  }

  if (command === "fields") {
    const fields = await api<Array<{ id: string; name: string; schema?: { type?: string } }>>("/rest/api/3/field");
    const points = fields.filter((field) => /point|estimate/i.test(field.name));
    for (const field of points) process.stdout.write(`${field.id}\t${field.name}\t${field.schema?.type ?? ""}\n`);
    if (points.length === 0) process.stdout.write("nenhum campo de estimativa encontrado\n");
    return;
  }

  if (command === "list") {
    const issues = await api<{ issues?: JiraIssue[] }>(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${projectKey} ORDER BY key ASC`)}&fields=summary,parent&maxResults=1000`,
    ).catch(() => api<{ issues?: JiraIssue[] }>(`/rest/api/3/search?jql=${encodeURIComponent(`project = ${projectKey} ORDER BY key ASC`)}&fields=summary,parent&maxResults=1000`));
    for (const issue of issues.issues ?? []) {
      const parent = issue.fields.parent ? ` ← ${issue.fields.parent.key}` : "";
      process.stdout.write(`${issue.key}\t${issue.fields.summary}${parent}\n`);
    }
    process.stdout.write(`\n${issues.issues?.length ?? 0} itens\n`);
    return;
  }

  if (command === "seed" || command === "sync") {
    const existing = await searchProject(projectKey);
    const items = plan(backlog, existing, command);
    if (dryRun) {
      for (const item of items) process.stdout.write(`[${item.kind}] ${item.key ?? "(novo)"} ${item.summary}\n`);
      process.stdout.write(`\n${items.length} item(ns) no plano\n`);
      return;
    }
    const epicKeys = new Map<string, string>();
    for (const epic of backlog.epics) if (epic.jiraKey) epicKeys.set(epic.name, epic.jiraKey);

    const typeIds = { epic: "10262", task: "10264" };
    for (const item of items) {
      const parentKey = item.kind === "task" ? epicKeys.get(item.parentName ?? "") : undefined;
      if (item.key === undefined) {
        const key = await createIssue({
          projectKey,
          typeId: typeIds[item.kind],
          summary: item.summary,
          description: item.description,
          labels: item.labels,
          ...(parentKey !== undefined ? { parentKey } : {}),
          ...(item.points !== undefined ? { points: item.points } : {}),
        });
        if (item.kind === "epic") {
          epicKeys.set(item.summary, key);
          const epic = backlog.epics.find((candidate) => candidate.name === item.summary);
          if (epic) epic.jiraKey = key;
        } else {
          const epic = backlog.epics.find((candidate) => candidate.name === item.parentName);
          const story = epic?.stories.find((candidate) => candidate.summary === item.summary);
          if (story) story.jiraKey = key;
        }
        process.stdout.write(`criado ${key} ${item.summary}\n`);
      } else {
        await updateIssue(item.key, {
          description: item.description,
          labels: item.labels,
          ...(item.points !== undefined ? { points: item.points } : {}),
        });
        process.stdout.write(`atualizado ${item.key} ${item.summary}\n`);
      }
    }
    writeFileSync(BACKLOG, `${JSON.stringify(backlog, null, 2)}\n`);
    return;
  }

  process.stderr.write("uso: node scripts/jira.ts whoami|fields|list|seed|sync|self-test [--dry-run]\n");
  process.exit(2);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`erro: ${(error as Error).message}\n`);
  process.exit(1);
}
