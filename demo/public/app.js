/* global document, window, navigator, crypto, performance, TextEncoder */
/**
 * The interview demo page: reads the forms, calls the API through api.js and shows the answers.
 *
 * - Every value shown comes from an API response. The page computes nothing about quotas, plans
 *   or access, and does not validate input: the service does, and the page shows its answer.
 * - All state lives in the `state` object below, in memory only. The API key is never written to
 *   localStorage, sessionStorage, IndexedDB, cookies, the URL or the console, and refreshing the
 *   page forgets it.
 * - Text from the API is inserted with textContent only, never parsed as HTML.
 */
import { createApiCaller } from "./api.js";
import {
  MASKED_API_KEY,
  addPage,
  defaultAccountName,
  describeFailure,
  describeRequest,
  firstPageQuery,
  formatNumber,
  hasNextPage,
  formatTimestamp,
  newRequestId,
  nextPageQuery,
  planKind,
  redactSecrets,
  requestIdAdvice,
  shortId,
  startPagination,
  summarizeDecision,
  summarizeUsage,
  toJsonNumber,
  withoutApiKey,
} from "./helpers.js";

const callApi = createApiCaller({
  fetch: (input, init) => window.fetch(input, init),
  now: () => performance.now(),
});

const USER_NAMES = ["Ada", "Bob", "Chen", "Dana", "Eli", "Fay"];

/** The whole page state. Nothing here is persisted anywhere. */
const state = {
  /** The only copy of the API key, or null. */
  apiKey: null,
  /** "created" (returned by POST /v1/accounts) or "pasted". */
  keySource: null,
  keyRevealed: false,
  /** The authenticated account as GET /v1/account returns it (never the key). */
  account: null,
  health: null,
  plans: [],
  /** Every user seen in this session (created, listed or read), by ID. */
  users: new Map(),
  activeUserId: null,
  usersPager: null,
  usageUsersPager: null,
  historyPager: null,
  /** The previous consume request and the first 200 response body sent for it. */
  lastConsume: null,
  /** Sections with a request in flight; their buttons are disabled. */
  busy: new Set(),
  usersCreated: 0,
};

// ---------------------------------------------------------------------------------------------
// DOM helpers

function byId(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`The page has no element #${id}`);
  }
  return element;
}

/** Creates an element; text and children are inserted as text nodes or elements, never HTML. */
function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.className) {
    element.className = options.className;
  }
  if (options.text !== undefined) {
    element.textContent = options.text;
  }
  if (options.title) {
    element.title = options.title;
  }
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) {
      element.append(child);
    }
  }
  return element;
}

function pill(text, tone) {
  return el("span", { className: `pill pill-${tone}`, text });
}

function idText(id) {
  return el("span", { className: "mono", text: String(id), title: String(id) });
}

function shortIdText(id) {
  return el("span", { className: "mono", text: shortId(id), title: String(id) });
}

/** A definition list of [label, value] pairs; a value may be text or an element. */
function facts(entries) {
  return el(
    "dl",
    { className: "facts" },
    entries.map(([label, value]) =>
      el("div", {}, [el("dt", { text: label }), el("dd", {}, [value])]),
    ),
  );
}

function button(text, onClick, { className = "button-secondary button-small", attrs = {} } = {}) {
  const element = el("button", { className, text, attrs: { type: "button", ...attrs } });
  element.addEventListener("click", onClick);
  return element;
}

/** The response as formatted JSON, folded, with every secret removed. */
function rawJson(data, label = "Raw JSON") {
  return el("details", { className: "raw" }, [
    el("summary", { text: label }),
    el("pre", { text: JSON.stringify(redactSecrets(data), null, 2) }),
  ]);
}

function notice(tone, title, detail) {
  return el("div", { className: `notice notice-${tone}`, attrs: { role: "status" } }, [
    el("strong", { text: title }),
    detail ? el("p", { text: detail }) : null,
  ]);
}

/** A failed call: kind, HTTP status, the service's error code and a safe explanation. */
function errorNotice(result) {
  const failure = describeFailure(result);
  const label = [failure.status ? `HTTP ${String(failure.status)}` : "", failure.code ?? ""]
    .filter((part) => part !== "")
    .join(" · ");
  return el(
    "div",
    {
      className: `notice ${failure.retryable ? "notice-warn" : "notice-error"}`,
      attrs: { role: "alert", "data-kind": failure.kind },
    },
    [
      el("strong", { text: failure.title }),
      label === "" ? null : el("span", { className: "code", text: label }),
      failure.detail ? el("p", { text: failure.detail }) : null,
    ],
  );
}

function meter(percent, label) {
  const fill = el("div", {
    className: percent >= 100 ? "meter-fill meter-fill-full" : "meter-fill",
  });
  fill.style.width = `${String(percent)}%`;
  return el(
    "div",
    {
      className: "meter",
      attrs: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(percent),
        "aria-label": label,
      },
    },
    [fill],
  );
}

/** A table; each row is { cells: (text | element)[], className? }. */
function table(caption, columns, rows) {
  return el("div", { className: "table-wrap" }, [
    el("table", {}, [
      el("caption", { text: caption }),
      el("thead", {}, [
        el(
          "tr",
          {},
          columns.map((column) =>
            el("th", {
              className: column.numeric ? "number" : "",
              text: column.label,
              attrs: { scope: "col" },
            }),
          ),
        ),
      ]),
      el(
        "tbody",
        {},
        rows.map((row) =>
          el(
            "tr",
            { className: row.className ?? "" },
            row.cells.map((cell, index) =>
              el("td", { className: columns.at(index)?.numeric ? "number" : "" }, [cell]),
            ),
          ),
        ),
      ),
    ]),
  ]);
}

function pagerFooter(pager) {
  const rows = `${String(pager.items.length)} row${pager.items.length === 1 ? "" : "s"} from ${String(pager.pages)} page${pager.pages === 1 ? "" : "s"}. `;
  return el("p", {
    className: "list-footer",
    text:
      pager.nextCursor === null
        ? `${rows}End of the list (nextCursor is null).`
        : `${rows}More rows are available: use “Load next page”.`,
  });
}

/** Shows the requests an action sent, for example "POST /v1/users → 201 · 9 ms". */
function showRequests(lineId, ...results) {
  byId(lineId).textContent = results.map((result) => describeRequest(result)).join("  ;  ");
}

// ---------------------------------------------------------------------------------------------
// Rendering of the shared state

function activeUser() {
  return state.activeUserId === null ? undefined : state.users.get(state.activeUserId);
}

/** Enables and disables controls; called after every state change. */
function render() {
  const hasKey = state.apiKey !== null;
  const hasUser = activeUser() !== undefined;
  for (const control of document.querySelectorAll("button")) {
    const section = control.closest("section.card");
    const busy = section !== null && state.busy.has(section.id);
    const missing =
      (control.hasAttribute("data-needs-key") && !hasKey) ||
      (control.hasAttribute("data-needs-user") && !hasUser) ||
      (control.hasAttribute("data-needs-plans") && state.plans.length === 0) ||
      (control.hasAttribute("data-needs-replay") && state.lastConsume === null) ||
      (control.id === "users-next" && !hasNextPage(state.usersPager)) ||
      (control.id === "usage-users-next" && !hasNextPage(state.usageUsersPager)) ||
      (control.id === "history-next" && !hasNextPage(state.historyPager));
    control.disabled = busy || missing;
  }
  for (const section of document.querySelectorAll("section.card")) {
    section.setAttribute("aria-busy", String(state.busy.has(section.id)));
  }
  renderSession();
}

function renderSession() {
  byId("session-api").replaceChildren(
    state.health === null
      ? pill("Not checked", "muted")
      : state.health === "healthy"
        ? pill("Healthy", "ok")
        : pill("Unhealthy", "bad"),
  );
  byId("session-account").replaceChildren(
    state.account === null
      ? "None"
      : el("span", {}, [state.account.name, el("br"), shortIdText(state.account.id)]),
  );
  byId("session-key").replaceChildren(
    state.apiKey === null
      ? "Not in memory"
      : el("span", {}, [
          pill("In memory", "ok"),
          ` ${state.keySource === "created" ? "(new account)" : "(pasted)"}`,
        ]),
  );
  const user = activeUser();
  byId("session-user").replaceChildren(
    user === undefined
      ? "None"
      : el("span", {}, [`${user.name} · ${user.plan.name}`, el("br"), shortIdText(user.id)]),
  );
}

function renderKeyPanel() {
  const panel = byId("key-panel");
  panel.hidden = state.apiKey === null;
  const created = state.keySource === "created";
  byId("key-display").textContent =
    state.apiKey !== null && state.keyRevealed ? state.apiKey : MASKED_API_KEY;
  const reveal = byId("key-reveal");
  reveal.hidden = !created;
  reveal.textContent = state.keyRevealed ? "Hide" : "Reveal";
  reveal.setAttribute("aria-pressed", String(state.keyRevealed));
  byId("key-copy").hidden = !created;
  byId("key-hint").textContent = created
    ? "Returned once by POST /v1/accounts: the service keeps only its SHA-256 digest and can never show it again. It is kept only in this page's memory, and refreshing the page clears it. Copy it now if you need it later."
    : "The pasted key is kept only in this page's memory. Refreshing the page clears it.";
}

function renderAccountCard() {
  const container = byId("account-result");
  const { account } = state;
  if (account === null) {
    container.replaceChildren();
    return;
  }
  container.replaceChildren(
    el("article", { className: "summary-card" }, [
      el("div", { className: "summary-title" }, [
        el("h3", { text: account.name }),
        pill("Active account", "info"),
        button("Refresh", () => void runAction("account", refreshAccount), {
          attrs: { "data-needs-key": "" },
        }),
      ]),
      facts([
        ["Account ID", idText(account.id)],
        ["Account plan", `${account.plan.name} (${planKind(account.plan)})`],
        ["Monthly allowance", formatNumber(account.plan.monthlyAllowance)],
        ["Max units per request", formatNumber(account.plan.maxUnitsPerRequest)],
        ["Created", formatTimestamp(account.createdAt)],
      ]),
      rawJson(account),
    ]),
  );
}

function planLabel(plan) {
  return `${plan.name} · ${planKind(plan)} · ${formatNumber(plan.monthlyAllowance)}/month · ${formatNumber(plan.maxUnitsPerRequest)}/request`;
}

/** Fills a plan <select> from the plans the API listed, grouped by scope. */
function fillPlanSelect(select, { firstScope = "ACCOUNT", preferCustom = false } = {}) {
  const previous = select.value;
  const scopes = firstScope === "USER" ? ["USER", "ACCOUNT"] : ["ACCOUNT", "USER"];
  const groups = scopes
    .map((scope) => {
      const plans = state.plans.filter((plan) => plan.scope === scope);
      return plans.length === 0
        ? null
        : el(
            "optgroup",
            { attrs: { label: `${scope} plans` } },
            plans.map((plan) => el("option", { text: planLabel(plan), attrs: { value: plan.id } })),
          );
    })
    .filter((group) => group !== null);
  if (groups.length === 0) {
    select.replaceChildren(el("option", { text: "Load plans first", attrs: { value: "" } }));
    return;
  }
  select.replaceChildren(...groups);
  const custom = state.plans.find((plan) => plan.code === null);
  if (state.plans.some((plan) => plan.id === previous)) {
    select.value = previous;
  } else if (preferCustom && custom !== undefined) {
    select.value = custom.id;
  }
}

function renderPlanSelects() {
  fillPlanSelect(byId("plan-update-id"), { preferCustom: true });
  fillPlanSelect(byId("account-plan-id"), { firstScope: "ACCOUNT" });
  fillPlanSelect(byId("user-plan-id"), { firstScope: "USER" });
  showPlanPlaceholders();
}

/** Shows the selected plan's current values as placeholders of the optional update fields. */
function showPlanPlaceholders() {
  const plan = state.plans.find((candidate) => candidate.id === byId("plan-update-id").value);
  byId("plan-update-name").placeholder = plan?.name ?? "";
  byId("plan-update-allowance").placeholder = plan ? String(plan.monthlyAllowance) : "";
  byId("plan-update-max").placeholder = plan ? String(plan.maxUnitsPerRequest) : "";
}

function renderPlansTable() {
  const container = byId("plans-result");
  if (state.plans.length === 0) {
    container.replaceChildren();
    return;
  }
  const user = activeUser();
  container.replaceChildren(
    table(
      "Plans visible to this account: predefined plans first, then this account's custom plans.",
      [
        { label: "Name" },
        { label: "Type" },
        { label: "Scope" },
        { label: "Monthly allowance", numeric: true },
        { label: "Max per request", numeric: true },
        { label: "Plan ID" },
        { label: "In use by" },
      ],
      state.plans.map((plan) => ({
        cells: [
          plan.name,
          plan.code === null
            ? pill("Custom", "info")
            : el("span", {}, [pill("Predefined", "muted"), " ", el("code", { text: plan.code })]),
          plan.scope,
          formatNumber(plan.monthlyAllowance),
          formatNumber(plan.maxUnitsPerRequest),
          shortIdText(plan.id),
          [
            state.account?.plan.id === plan.id ? "this account" : "",
            user?.plan.id === plan.id ? `active user (${user.name})` : "",
          ]
            .filter((text) => text !== "")
            .join(", ") || "—",
        ],
      })),
    ),
  );
}

function renderUserSelect() {
  const select = byId("consume-user");
  if (state.users.size === 0) {
    select.replaceChildren(
      el("option", { text: "No users yet: create or load users", attrs: { value: "" } }),
    );
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.replaceChildren(
    ...[...state.users.values()].map((user) =>
      el("option", {
        text: `${user.name} · ${user.plan.name} · ${shortId(user.id)}`,
        attrs: { value: user.id },
      }),
    ),
  );
  if (state.activeUserId !== null) {
    select.value = state.activeUserId;
  }
}

function userCard(title, user) {
  return el("article", { className: "summary-card" }, [
    el("div", { className: "summary-title" }, [
      el("h3", { text: `${title}: ${user.name}` }),
      user.id === state.activeUserId
        ? pill("Active user", "info")
        : button("Make active", () => {
            setActiveUser(user.id);
          }),
    ]),
    facts([
      ["User ID", idText(user.id)],
      ["User plan", `${user.plan.name} (${planKind(user.plan)})`],
      ["Monthly allowance", formatNumber(user.plan.monthlyAllowance)],
      ["Max units per request", formatNumber(user.plan.maxUnitsPerRequest)],
      ["Created", formatTimestamp(user.createdAt)],
      ["Updated", formatTimestamp(user.updatedAt)],
    ]),
    rawJson(user),
  ]);
}

function renderUsersList() {
  const container = byId("users-list");
  const pager = state.usersPager;
  if (pager === null) {
    container.replaceChildren();
    return;
  }
  container.replaceChildren(
    table(
      "Users of this account, oldest first (GET /v1/users).",
      [
        { label: "Name" },
        { label: "Plan" },
        { label: "User ID" },
        { label: "Created" },
        { label: "" },
      ],
      pager.items.map((item) => {
        const user = state.users.get(item.id) ?? item;
        const active = user.id === state.activeUserId;
        return {
          className: active ? "row-active" : "",
          cells: [
            user.name,
            `${user.plan.name} (${formatNumber(user.plan.monthlyAllowance)}/month, ${formatNumber(user.plan.maxUnitsPerRequest)}/request)`,
            shortIdText(user.id),
            formatTimestamp(user.createdAt),
            active
              ? pill("Active", "info")
              : button("Select", () => {
                  setActiveUser(user.id);
                }),
          ],
        };
      }),
    ),
    pagerFooter(pager),
  );
}

function setActiveUser(id) {
  state.activeUserId = id;
  byId("user-get-id").value = id;
  renderUserSelect();
  renderUsersList();
  renderPlansTable();
  render();
}

function rememberUsers(users) {
  for (const user of users) {
    state.users.set(user.id, user);
  }
}

/** Forgets everything that belongs to the current account (used when the key changes or is cleared). */
function resetAccountState() {
  state.apiKey = null;
  state.keySource = null;
  state.keyRevealed = false;
  state.account = null;
  state.plans = [];
  state.users = new Map();
  state.activeUserId = null;
  state.usersPager = null;
  state.usageUsersPager = null;
  state.historyPager = null;
  state.lastConsume = null;
  for (const id of [
    "account-result",
    "plans-result",
    "plans-action-result",
    "user-result",
    "users-list",
    "consume-result",
    "usage-account-card",
    "usage-user-card",
    "usage-users-list",
    "history-list",
  ]) {
    byId(id).replaceChildren();
  }
  for (const id of ["plans-request", "users-request", "consume-request", "usage-request"]) {
    byId(id).textContent = "";
  }
  byId("user-get-id").value = "";
  byId("key-status").textContent = "";
  renderPlanSelects();
  renderUserSelect();
  renderReplayTarget();
}

function setSession(apiKey, source, account) {
  resetAccountState();
  state.apiKey = apiKey;
  state.keySource = source;
  state.account = account;
  renderAccountCard();
  renderKeyPanel();
}

// ---------------------------------------------------------------------------------------------
// Actions. Each one runs through runAction, which blocks a second submission while it runs.

function api(request) {
  return callApi({ ...request, apiKey: state.apiKey });
}

async function runAction(sectionId, task) {
  if (state.busy.has(sectionId)) {
    return;
  }
  const focused = document.activeElement;
  state.busy.add(sectionId);
  render();
  try {
    await task();
  } catch {
    // A defect of the page itself; no detail is shown (it could contain request data).
    document
      .querySelector(`#${sectionId} .result`)
      ?.replaceChildren(
        notice("error", "The demo page hit an unexpected error.", "Reload the page and try again."),
      );
  } finally {
    state.busy.delete(sectionId);
    render();
    if (focused instanceof window.HTMLElement && document.activeElement === document.body) {
      focused.focus();
    }
  }
}

// 1. System status

async function checkHealth() {
  const [live, ready] = await Promise.all([
    callApi({ path: "/health/live" }),
    callApi({ path: "/health/ready" }),
  ]);
  const liveOk = renderHealthTile("health-live", live, "ok");
  const readyOk = renderHealthTile("health-ready", ready, "ready");
  state.health = liveOk && readyOk ? "healthy" : "unhealthy";
}

function renderHealthTile(id, result, expectedStatus) {
  const tile = byId(id);
  const healthy = result.status === 200 && result.data?.status === expectedStatus;
  tile.querySelector(".tile-state")?.replaceChildren(
    pill(healthy ? "Healthy" : "Unhealthy", healthy ? "ok" : "bad"),
    " ",
    el("span", {
      className: "mono",
      text: result.networkError
        ? "no response"
        : `HTTP ${String(result.status)}${healthy ? ` · "${expectedStatus}"` : ""}`,
    }),
  );
  const failure = healthy ? null : describeFailure(result);
  tile.querySelector(".tile-detail").textContent = healthy
    ? `Answered in ${String(result.durationMs)} ms.`
    : [failure.code, failure.detail].filter(Boolean).join(": ");
  return healthy;
}

// 2. Account setup

async function createAccount() {
  const result = await callApi({
    method: "POST",
    path: "/v1/accounts",
    body: { name: byId("account-name").value },
  });
  showRequests("account-request", result);
  if (result.status !== 201 || typeof result.data?.apiKey !== "string") {
    byId("account-result").replaceChildren(errorNotice(result));
    return;
  }
  setSession(result.data.apiKey, "created", withoutApiKey(result.data));
  // The raw body holds the key: drop it so nothing else can show it.
  result.text = "";
  result.data = null;
  byId("account-name").value = defaultAccountName(new Date());
  await loadPlans();
}

async function useExistingKey() {
  const input = byId("existing-key");
  const apiKey = input.value.trim();
  input.value = "";
  const result = await callApi({ path: "/v1/account", apiKey });
  showRequests("account-request", result);
  if (!result.ok) {
    // The key is not kept: it only lived in this function.
    byId("account-result").replaceChildren(errorNotice(result));
    return;
  }
  setSession(apiKey, "pasted", result.data);
  await loadPlans();
  await loadUsersFirstPage();
}

async function refreshAccount() {
  const result = await api({ path: "/v1/account" });
  showRequests("account-request", result);
  if (!result.ok) {
    byId("account-result").replaceChildren(errorNotice(result));
    return;
  }
  state.account = result.data;
  renderAccountCard();
  renderPlansTable();
}

async function copyKey() {
  const status = byId("key-status");
  if (state.apiKey === null) {
    return;
  }
  try {
    await navigator.clipboard.writeText(state.apiKey);
    status.textContent = "Copied to the clipboard.";
  } catch {
    status.textContent = "Copying failed: reveal the key and copy it by hand.";
  }
}

function clearKey() {
  resetAccountState();
  renderKeyPanel();
  byId("account-result").replaceChildren(
    notice(
      "ok",
      "API key cleared.",
      "The key and this account's results were removed from the page's memory. Data in the service is unchanged.",
    ),
  );
  render();
}

// 3. Plans

async function loadPlans() {
  const result = await api({ path: "/v1/plans" });
  showRequests("plans-request", result);
  if (!result.ok) {
    byId("plans-result").replaceChildren(errorNotice(result));
    return result;
  }
  state.plans = Array.isArray(result.data?.plans) ? result.data.plans : [];
  renderPlansTable();
  renderPlanSelects();
  return result;
}

/** After a plan change: the plans, the account and (if listed) the users, as the API reports them now. */
async function reloadAfterPlanChange(...earlier) {
  const plans = await loadPlans();
  const account = await api({ path: "/v1/account" });
  if (account.ok) {
    state.account = account.data;
    renderAccountCard();
    renderPlansTable();
  }
  const results = [...earlier, plans, account];
  if (state.usersPager !== null) {
    results.push(await loadUsersFirstPage());
  }
  showRequests("plans-request", ...results);
}

function planCard(title, plan) {
  return el("article", { className: "summary-card" }, [
    el("div", { className: "summary-title" }, [
      el("h3", { text: `${title}: ${plan.name}` }),
      pill(planKind(plan), plan.code === null ? "info" : "muted"),
    ]),
    facts([
      ["Plan ID", idText(plan.id)],
      ["Scope", plan.scope],
      ["Monthly allowance", formatNumber(plan.monthlyAllowance)],
      ["Max units per request", formatNumber(plan.maxUnitsPerRequest)],
    ]),
    rawJson(plan),
  ]);
}

async function createPlan() {
  const result = await api({
    method: "POST",
    path: "/v1/plans",
    body: {
      name: byId("plan-create-name").value,
      scope: byId("plan-create-scope").value,
      monthlyAllowance: toJsonNumber(byId("plan-create-allowance").value),
      maxUnitsPerRequest: toJsonNumber(byId("plan-create-max").value),
    },
  });
  showRequests("plans-request", result);
  const container = byId("plans-action-result");
  if (result.status !== 201) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  container.replaceChildren(planCard("Custom plan created", result.data));
  byId("plan-update-id").value = result.data.id;
  await reloadAfterPlanChange(result);
}

async function updatePlan() {
  const planId = byId("plan-update-id").value;
  const body = {};
  const name = byId("plan-update-name").value;
  const monthlyAllowance = toJsonNumber(byId("plan-update-allowance").value);
  const maxUnitsPerRequest = toJsonNumber(byId("plan-update-max").value);
  if (name !== "") {
    body.name = name;
  }
  if (monthlyAllowance !== undefined) {
    body.monthlyAllowance = monthlyAllowance;
  }
  if (maxUnitsPerRequest !== undefined) {
    body.maxUnitsPerRequest = maxUnitsPerRequest;
  }
  const result = await api({
    method: "PATCH",
    path: `/v1/plans/${encodeURIComponent(planId)}`,
    body,
  });
  showRequests("plans-request", result);
  const container = byId("plans-action-result");
  if (!result.ok) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  container.replaceChildren(planCard("Plan updated", result.data));
  for (const id of ["plan-update-name", "plan-update-allowance", "plan-update-max"]) {
    byId(id).value = "";
  }
  await reloadAfterPlanChange(result);
}

async function assignAccountPlan() {
  const result = await api({
    method: "PUT",
    path: "/v1/account/plan",
    body: { planId: byId("account-plan-id").value },
  });
  showRequests("plans-request", result);
  const container = byId("plans-action-result");
  if (!result.ok) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  state.account = result.data;
  renderAccountCard();
  renderPlansTable();
  container.replaceChildren(
    notice(
      "ok",
      `Account plan is now “${result.data.plan.name}”.`,
      `${formatNumber(result.data.plan.monthlyAllowance)} units a month, at most ${formatNumber(result.data.plan.maxUnitsPerRequest)} per request, shared by every user. Usage already counted this month is kept.`,
    ),
  );
}

// 4. Users

async function createUser() {
  const result = await api({
    method: "POST",
    path: "/v1/users",
    body: { name: byId("user-name").value },
  });
  showRequests("users-request", result);
  const container = byId("user-result");
  if (result.status !== 201) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  rememberUsers([result.data]);
  state.usersCreated += 1;
  byId("user-name").value =
    USER_NAMES.at(state.usersCreated) ?? `User ${String(state.usersCreated + 1)}`;
  setActiveUser(result.data.id);
  container.replaceChildren(userCard("Created", result.data));
  if (state.usersPager !== null) {
    showRequests("users-request", result, await loadUsersFirstPage());
  }
}

async function loadUsersFirstPage() {
  const pager = startPagination({}, Number(byId("users-limit").value));
  const result = await api({ path: "/v1/users", query: firstPageQuery(pager) });
  return showUsersPage(pager, result);
}

async function loadUsersNextPage() {
  const query = state.usersPager === null ? null : nextPageQuery(state.usersPager);
  if (query === null) {
    return;
  }
  const result = await api({ path: "/v1/users", query });
  showUsersPage(state.usersPager, result);
}

function showUsersPage(pager, result) {
  showRequests("users-request", result);
  if (!result.ok) {
    byId("users-list").replaceChildren(errorNotice(result));
    return result;
  }
  const users = Array.isArray(result.data?.users) ? result.data.users : [];
  rememberUsers(users);
  state.usersPager = addPage(pager, users, result.data.nextCursor);
  if (state.activeUserId === null && users.length > 0) {
    state.activeUserId = users[0].id;
    byId("user-get-id").value = users[0].id;
  }
  renderUsersList();
  renderUserSelect();
  renderPlansTable();
  byId("users-list").append(rawJson(result.data, "Raw JSON (last page)"));
  return result;
}

async function getUser() {
  const userId = byId("user-get-id").value.trim();
  const result = await api({ path: `/v1/users/${encodeURIComponent(userId)}` });
  showRequests("users-request", result);
  const container = byId("user-result");
  if (!result.ok) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  rememberUsers([result.data]);
  renderUserSelect();
  renderUsersList();
  container.replaceChildren(userCard("User", result.data));
}

async function assignUserPlan() {
  const user = activeUser();
  if (user === undefined) {
    return;
  }
  const result = await api({
    method: "PUT",
    path: `/v1/users/${encodeURIComponent(user.id)}/plan`,
    body: { planId: byId("user-plan-id").value },
  });
  showRequests("users-request", result);
  const container = byId("user-result");
  if (!result.ok) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  rememberUsers([result.data]);
  renderUserSelect();
  renderUsersList();
  renderPlansTable();
  container.replaceChildren(userCard("Plan assigned", result.data));
}

// 5. Consume

function setNewRequestId() {
  byId("consume-request-id").value = newRequestId(() => crypto.randomUUID());
  showRequestIdAdvice();
}

function showRequestIdAdvice() {
  byId("consume-request-id-advice").textContent =
    requestIdAdvice(byId("consume-request-id").value) ?? "";
}

function renderReplayTarget() {
  const target = byId("consume-replay-target");
  const previous = state.lastConsume;
  if (previous === null) {
    target.textContent = "No request sent yet.";
    return;
  }
  const userName = state.users.get(previous.body.userId)?.name ?? shortId(previous.body.userId);
  target.textContent = `requestId ${String(previous.body.requestId)} · units ${JSON.stringify(previous.body.units ?? null)} · user ${userName}`;
}

async function sendConsume(body, isReplay) {
  const previous = state.lastConsume;
  const result = await api({ method: "POST", path: "/v1/consume", body });
  showRequests("consume-request", result);
  const decided = result.status === 200 && typeof result.data?.accepted === "boolean";
  const reference = isReplay ? (previous?.text ?? null) : null;
  state.lastConsume = { body, text: reference ?? (decided ? result.text : null) };
  renderReplayTarget();

  const container = byId("consume-result");
  if (!decided) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  const comparison =
    isReplay && reference !== null
      ? result.text === reference
        ? notice(
            "ok",
            "Replay: the stored decision was returned.",
            `The response body is identical to the original, byte for byte (${String(new TextEncoder().encode(result.text).length)} bytes). Nothing was counted again.`,
          )
        : notice(
            "warn",
            "Replay: the response differs from the original response.",
            "Compare the raw JSON below.",
          )
      : null;
  container.replaceChildren(decisionCard(result.data, comparison));
}

function decisionCard(decision, comparison) {
  const summary = summarizeDecision(decision);
  const user = state.users.get(summary.userId);
  return el(
    "article",
    {
      className: `summary-card decision ${summary.accepted ? "decision-accepted" : "decision-rejected"}`,
    },
    [
      el("div", { className: "summary-title" }, [
        pill(summary.accepted ? "ACCEPTED" : "REJECTED", summary.accepted ? "ok" : "bad"),
        el("h3", {
          text: summary.accepted ? "Accepted" : `Rejected: ${String(summary.blockedBy)}`,
        }),
      ]),
      el("p", { text: summary.explanation }),
      comparison,
      facts([
        ["requestId", el("span", { className: "mono", text: String(summary.requestId) })],
        ["Units", formatNumber(summary.units)],
        [
          "User",
          user === undefined
            ? shortIdText(summary.userId)
            : `${user.name} (${shortId(summary.userId)})`,
        ],
        ["Blocking rule", summary.blockingRule ?? "— (none)"],
        ["Blocking level", summary.blockingLevel ?? "— (none)"],
        ["Month (UTC)", String(summary.month)],
        ["Processed", formatTimestamp(summary.processedAt)],
      ]),
      el(
        "div",
        { className: "decision-levels" },
        summary.levels.map((level) =>
          el(
            "section",
            {
              className: level.blocking ? "level level-blocking" : "level",
              attrs: { "aria-label": level.label },
            },
            [
              el("div", { className: "summary-title" }, [
                el("h4", { text: `${level.label}: ${String(level.planName)}` }),
                level.blocking ? pill("Blocking", "bad") : null,
              ]),
              meter(
                level.percentUsed,
                `${level.label}: ${formatNumber(level.used)} of ${formatNumber(level.monthlyAllowance)} used`,
              ),
              facts([
                ["Used", `${formatNumber(level.used)} of ${formatNumber(level.monthlyAllowance)}`],
                ["Remaining", formatNumber(level.remaining)],
                ["Max per request", formatNumber(level.maxUnitsPerRequest)],
              ]),
            ],
          ),
        ),
      ),
      rawJson(decision),
    ],
  );
}

// 6. Usage and history

function usageFilters() {
  return {
    month: byId("usage-month").value.trim() || undefined,
    limit: Number(byId("usage-limit").value),
  };
}

function usageCard(title, result) {
  if (!result.ok) {
    return errorNotice(result);
  }
  const usage = summarizeUsage(result.data);
  return el("article", { className: "summary-card" }, [
    el("div", { className: "summary-title" }, [
      el("h3", { text: title }),
      pill(
        usage.currentMonth
          ? `${String(usage.month)} · current month`
          : `${String(usage.month)} · past month`,
        "muted",
      ),
    ]),
    usage.currentMonth
      ? meter(
          usage.percentUsed,
          `${title}: ${formatNumber(usage.used)} of ${formatNumber(usage.monthlyAllowance)} used`,
        )
      : null,
    facts(
      usage.currentMonth
        ? [
            ["Used", `${formatNumber(usage.used)} of ${formatNumber(usage.monthlyAllowance)}`],
            ["Remaining", formatNumber(usage.remaining)],
            ["Max per request", formatNumber(usage.maxUnitsPerRequest)],
          ]
        : [["Used", formatNumber(usage.used)]],
    ),
    usage.currentMonth
      ? null
      : el("p", {
          className: "hint",
          text: "A past month reports used units only: the limits that applied are recorded on each decision in the history.",
        }),
    rawJson(result.data),
  ]);
}

async function loadAccountUsage() {
  const { month } = usageFilters();
  const result = await api({ path: "/v1/usage", query: { month } });
  showRequests("usage-request", result);
  byId("usage-account-card").replaceChildren(usageCard("Account usage", result));
}

async function loadUserUsage() {
  const user = activeUser();
  if (user === undefined) {
    return;
  }
  const { month } = usageFilters();
  const result = await api({
    path: `/v1/users/${encodeURIComponent(user.id)}/usage`,
    query: { month },
  });
  showRequests("usage-request", result);
  byId("usage-user-card").replaceChildren(usageCard(`User usage: ${user.name}`, result));
}

async function loadUsageUsers(next) {
  let pager = state.usageUsersPager;
  let query;
  if (next) {
    query = pager === null ? null : nextPageQuery(pager);
  } else {
    const { month, limit } = usageFilters();
    pager = startPagination({ month }, limit);
    query = firstPageQuery(pager);
  }
  if (query === null || pager === null) {
    return;
  }
  const result = await api({ path: "/v1/usage/users", query });
  showRequests("usage-request", result);
  const container = byId("usage-users-list");
  if (!result.ok) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  state.usageUsersPager = {
    ...addPage(pager, result.data.users ?? [], result.data.nextCursor),
    currentMonth: result.data.currentMonth === true,
    month: result.data.month,
  };
  const { currentMonth, month } = state.usageUsersPager;
  container.replaceChildren(
    table(
      `Every user's usage in ${String(month)}, newest user first (GET /v1/usage/users).`,
      currentMonth
        ? [
            { label: "Name" },
            { label: "Plan" },
            { label: "Used", numeric: true },
            { label: "Monthly allowance", numeric: true },
            { label: "Remaining", numeric: true },
            { label: "Max per request", numeric: true },
          ]
        : [{ label: "Name" }, { label: "Used", numeric: true }],
      state.usageUsersPager.items.map((row) => ({
        className: row.userId === state.activeUserId ? "row-active" : "",
        cells: currentMonth
          ? [
              row.name,
              row.planName,
              formatNumber(row.used),
              formatNumber(row.monthlyAllowance),
              formatNumber(row.remaining),
              formatNumber(row.maxUnitsPerRequest),
            ]
          : [row.name, formatNumber(row.used)],
      })),
    ),
    pagerFooter(state.usageUsersPager),
    rawJson(result.data, "Raw JSON (last page)"),
  );
}

async function loadHistory(next) {
  let pager = state.historyPager;
  let query;
  if (next) {
    query = pager === null ? null : nextPageQuery(pager);
  } else {
    const { month, limit } = usageFilters();
    const onlyUser = byId("history-only-user").checked
      ? (state.activeUserId ?? undefined)
      : undefined;
    pager = startPagination({ userId: onlyUser, month }, limit);
    query = firstPageQuery(pager);
  }
  if (query === null || pager === null) {
    return;
  }
  const result = await api({ path: "/v1/history", query });
  showRequests("usage-request", result);
  const container = byId("history-list");
  if (!result.ok) {
    container.replaceChildren(errorNotice(result));
    return;
  }
  state.historyPager = addPage(pager, result.data.decisions ?? [], result.data.nextCursor);
  const filterUser =
    result.data.userId === null
      ? "all users"
      : (state.users.get(result.data.userId)?.name ?? shortId(result.data.userId));
  const filterMonth = result.data.month ?? "all months";
  container.replaceChildren(
    table(
      `Stored decisions, newest first (GET /v1/history): ${filterUser}, ${String(filterMonth)}.`,
      [
        { label: "Processed (UTC)" },
        { label: "requestId" },
        { label: "User" },
        { label: "Units", numeric: true },
        { label: "Outcome" },
        { label: "Blocking" },
        { label: "User used / remaining", numeric: true },
        { label: "Account used / remaining", numeric: true },
      ],
      state.historyPager.items.map((decision) => {
        const summary = summarizeDecision(decision);
        const [userLevel, accountLevel] = summary.levels;
        return {
          cells: [
            formatTimestamp(summary.processedAt).replace(" UTC", ""),
            el("span", { className: "mono", text: String(summary.requestId) }),
            state.users.get(summary.userId)?.name ?? shortIdText(summary.userId),
            formatNumber(summary.units),
            pill(summary.outcome, summary.accepted ? "ok" : "bad"),
            summary.blockedBy ?? "—",
            `${formatNumber(userLevel?.used)} / ${formatNumber(userLevel?.remaining)}`,
            `${formatNumber(accountLevel?.used)} / ${formatNumber(accountLevel?.remaining)}`,
          ],
        };
      }),
    ),
    pagerFooter(state.historyPager),
    rawJson(result.data, "Raw JSON (last page)"),
  );
}

// ---------------------------------------------------------------------------------------------
// Wiring

function onSubmit(formId, sectionId, task) {
  byId(formId).addEventListener("submit", (event) => {
    event.preventDefault();
    void runAction(sectionId, task);
  });
}

function onClick(buttonId, sectionId, task) {
  byId(buttonId).addEventListener("click", () => {
    void runAction(sectionId, task);
  });
}

function init() {
  byId("usage-cards").replaceChildren(
    el("div", { attrs: { id: "usage-account-card" } }),
    el("div", { attrs: { id: "usage-user-card" } }),
  );
  byId("account-name").value = defaultAccountName(new Date());
  setNewRequestId();

  onClick("health-check", "status", checkHealth);

  onSubmit("account-create-form", "account", createAccount);
  onSubmit("account-key-form", "account", useExistingKey);
  byId("key-reveal").addEventListener("click", () => {
    state.keyRevealed = !state.keyRevealed;
    renderKeyPanel();
  });
  byId("key-copy").addEventListener("click", () => void copyKey());
  byId("key-clear").addEventListener("click", clearKey);

  onClick("plans-load", "plans", loadPlans);
  onSubmit("plan-create-form", "plans", createPlan);
  onSubmit("plan-update-form", "plans", updatePlan);
  onSubmit("account-plan-form", "plans", assignAccountPlan);
  byId("plan-update-id").addEventListener("change", showPlanPlaceholders);

  onSubmit("user-create-form", "users", createUser);
  onSubmit("user-get-form", "users", getUser);
  onSubmit("user-plan-form", "users", assignUserPlan);
  onClick("users-load", "users", loadUsersFirstPage);
  onClick("users-next", "users", loadUsersNextPage);

  onSubmit("consume-form", "consume", () =>
    sendConsume(
      {
        userId: state.activeUserId ?? "",
        units: toJsonNumber(byId("consume-units").value),
        requestId: byId("consume-request-id").value,
      },
      false,
    ),
  );
  onClick("consume-replay", "consume", async () => {
    if (state.lastConsume !== null) {
      await sendConsume(state.lastConsume.body, true);
    }
  });
  byId("consume-new-id").addEventListener("click", setNewRequestId);
  byId("consume-request-id").addEventListener("input", showRequestIdAdvice);
  byId("consume-user").addEventListener("change", (event) => {
    setActiveUser(event.target.value);
  });

  onClick("usage-account", "usage", loadAccountUsage);
  onClick("usage-user", "usage", loadUserUsage);
  onClick("usage-users", "usage", () => loadUsageUsers(false));
  onClick("usage-users-next", "usage", () => loadUsageUsers(true));
  onClick("history-load", "usage", () => loadHistory(false));
  onClick("history-next", "usage", () => loadHistory(true));

  renderKeyPanel();
  renderPlanSelects();
  renderUserSelect();
  renderReplayTarget();
  render();
  void runAction("status", checkHealth);
}

init();
