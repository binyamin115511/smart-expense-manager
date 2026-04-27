const API = "";
let token = localStorage.getItem("token") || "";
let catChart = null;
let dailyChart = null;
let monthlyChart = null;
let chatHistory = [];
const shownAlerts = new Set();

const CATEGORIES = [
  { value: "מזון",     icon: "🍔" },
  { value: "דלק",     icon: "⛽" },
  { value: "תחבורה",  icon: "🚗" },
  { value: "קניות",   icon: "🛍️" },
  { value: "חשבונות", icon: "💡" },
  { value: "בידור",   icon: "🎬" },
  { value: "בריאות",  icon: "💊" },
  { value: "ביגוד",   icon: "👕" },
  { value: "חינוך",   icon: "📚" },
  { value: "מנויים",  icon: "📱" },
  { value: "כללי",    icon: "📦" }
];

const CAT_COLORS = ["#667eea","#11998e","#f7971e","#8e44ad","#e53e3e","#00b4d8","#ff9f1c","#27ae60","#c0392b","#2980b9","#7f8c8d"];

// ========== INIT ==========
window.addEventListener("DOMContentLoaded", () => {
  buildCategoryGrid();
  if (token) showApp();
  else show("auth-screen");
  document.getElementById("dash-date").textContent = new Date().toLocaleDateString("he-IL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
});

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

async function showApp() {
  // Verify token is still valid before showing app
  const check = await api("/me");
  if (!check || check.error) {
    token = "";
    localStorage.removeItem("token");
    show("auth-screen");
    return;
  }
  show("app-screen");
  loadUserInfo();
  showPage("dashboard");
  if ("Notification" in window) updateNotifStatus(Notification.permission);
}

// ========== AUTH ==========
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  event.target.classList.add("active");
  document.getElementById("login-form").style.display = tab === "login" ? "block" : "none";
  document.getElementById("register-form").style.display = tab === "register" ? "block" : "none";
  document.getElementById("auth-error").textContent = "";
}

async function login() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  if (!email || !password) return setAuthError("נא למלא את כל השדות");
  const res = await api("/login", "POST", { email, password });
  if (res.error) return setAuthError(res.error);
  token = res.token;
  localStorage.setItem("token", token);
  showApp();
}

async function register() {
  const email = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  if (!email || !password) return setAuthError("נא למלא את כל השדות");
  const res = await api("/register", "POST", { email, password });
  if (res.error) return setAuthError(res.error);
  setAuthError("✅ נרשמת בהצלחה! כעת התחבר");
}

function logout() {
  token = "";
  localStorage.removeItem("token");
  chatHistory = [];
  show("auth-screen");
}

function setAuthError(msg) {
  document.getElementById("auth-error").textContent = msg;
}

// ========== PAGES ==========
function showPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item, .bottom-nav-item").forEach(n => n.classList.remove("active"));

  document.getElementById("page-" + name).classList.add("active");

  document.querySelectorAll(".nav-item, .bottom-nav-item").forEach(item => {
    if (item.getAttribute("onclick")?.includes(`'${name}'`)) item.classList.add("active");
  });

  if (name === "dashboard") loadDashboard();
  if (name === "expenses")  loadExpenses();
  if (name === "stats")     loadStats();
  if (name === "settings")  loadSettings();
}

// ========== USER INFO ==========
async function loadUserInfo() {
  const user = await api("/me");
  if (!user || user.error) return;
  document.getElementById("user-email-display").textContent = user.email;
  const badge = document.getElementById("plan-badge");
  badge.textContent = user.plan === "premium" ? "⭐ פרימיום" : "חינמי";
  badge.className = `plan-badge ${user.plan === "premium" ? "premium" : "free"}`;
}

// ========== TOAST ==========
function showToast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

// ========== NOTIFICATIONS ==========
function requestNotifications() {
  if (!("Notification" in window)) return showToast("הדפדפן לא תומך בהתראות", "warning");
  Notification.requestPermission().then(perm => {
    updateNotifStatus(perm);
    if (perm === "granted") showToast("✅ התראות מופעלות!", "success");
    else showToast("התראות נדחו", "warning");
  });
}

function updateNotifStatus(perm) {
  const el = document.getElementById("notif-status");
  const btn = document.getElementById("notif-btn");
  if (!el) return;
  if (perm === "granted") { el.textContent = "✅ מופעלות"; if (btn) btn.style.display = "none"; }
  else if (perm === "denied") { el.textContent = "❌ נחסמו"; if (btn) btn.style.display = "none"; }
  else el.textContent = "ממתין";
}

function sendBrowserNotif(title, body) {
  if (Notification.permission === "granted") {
    new Notification(title, { body, icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💰</text></svg>" });
  }
}

// ========== ALERTS ==========
function checkAlerts(data) {
  const { total = 0, monthTotal = 0, budget = 0, goal = 0, foodTotal = 0, foodLimit = 0 } = data;

  if (budget > 0 && monthTotal > budget) {
    const key = `budget-${Math.floor(monthTotal / 100)}`;
    if (!shownAlerts.has(key)) {
      shownAlerts.add(key);
      showToast(`⚠️ חרגת מהתקציב! הוצאת ₪${monthTotal.toFixed(0)} מתוך ₪${budget}`, "danger");
      sendBrowserNotif("חריגה מתקציב!", `הוצאת ₪${monthTotal.toFixed(0)} מתוך ₪${budget}`);
    }
  } else if (budget > 0 && monthTotal > budget * 0.8) {
    const key = `budget-warn-${Math.floor(monthTotal / 50)}`;
    if (!shownAlerts.has(key)) {
      shownAlerts.add(key);
      showToast(`🔶 השתמשת ב-${Math.round((monthTotal / budget) * 100)}% מהתקציב`, "warning");
    }
  }

  if (goal > 0 && total > goal) {
    const key = `goal-${Math.floor(total / 100)}`;
    if (!shownAlerts.has(key)) {
      shownAlerts.add(key);
      showToast(`❌ חרגת מהיעד הכולל! ₪${total.toFixed(0)} > ₪${goal}`, "danger");
      sendBrowserNotif("חריגה מהיעד!", `סה"כ ₪${total.toFixed(0)} חרג מהיעד ₪${goal}`);
    }
  }

  if (foodLimit > 0 && foodTotal > foodLimit) {
    const key = `food-${Math.floor(foodTotal / 50)}`;
    if (!shownAlerts.has(key)) {
      shownAlerts.add(key);
      showToast(`🍔 חרגת מתקציב המזון! ₪${foodTotal.toFixed(0)} > ₪${foodLimit}`, "danger");
      sendBrowserNotif("הוצאות מזון גבוהות!", `₪${foodTotal.toFixed(0)} על מזון (מגבלה: ₪${foodLimit})`);
    }
  }
}

// ========== DASHBOARD ==========
async function loadDashboard() {
  const [insightsData, monthData, weekData, expenses] = await Promise.all([
    api("/stats/insights"),
    api("/stats/months"),
    api("/stats/weekly"),
    api("/expenses")
  ]);
  const user = await api("/me");

  // Stat cards
  document.getElementById("dash-total").textContent = fmt(insightsData.total || 0);
  document.getElementById("dash-total-sub").textContent = `${(expenses || []).length} הוצאות`;
  document.getElementById("dash-month").textContent = fmt(insightsData.monthTotal || 0);
  document.getElementById("dash-budget").textContent = user.budget > 0 ? fmt(user.budget) : "לא הוגדר";

  // Month trend
  const trendEl = document.getElementById("dash-month-trend");
  if (monthData.pct !== null) {
    const up = monthData.diff > 0;
    trendEl.textContent = `${up ? "▲" : "▼"} ${Math.abs(monthData.pct)}% מחודש קודם`;
    trendEl.className = `stat-trend ${up ? "up" : "down"}`;
  } else {
    trendEl.textContent = "אין נתוני חודש קודם";
    trendEl.className = "stat-trend";
  }

  // Top category
  const topCat = insightsData.topCategory;
  const topCatEl = CATEGORIES.find(c => c.value === topCat);
  document.getElementById("dash-top-cat").textContent = topCat ? `${topCatEl?.icon || ""} ${topCat}` : "—";
  if (topCat && insightsData.categories) {
    const pct = ((insightsData.categories[topCat] / insightsData.total) * 100).toFixed(0);
    document.getElementById("dash-top-cat-sub").textContent = `${pct}% מסה"כ`;
  }

  // Budget bar
  const budget = user.budget || 0;
  const monthTotal = insightsData.monthTotal || 0;
  const pct = budget > 0 ? Math.min((monthTotal / budget) * 100, 100) : 0;
  const bar = document.getElementById("budget-bar");
  bar.style.width = pct + "%";
  bar.className = "progress-bar " + (pct < 60 ? "low" : pct < 85 ? "mid" : "high");

  const pctLabel = document.getElementById("budget-pct-label");
  if (budget > 0) {
    pctLabel.textContent = `${pct.toFixed(0)}%`;
    pctLabel.className = "badge " + (pct < 60 ? "green" : pct < 85 ? "orange" : "red");
    document.getElementById("budget-label").textContent = `₪${monthTotal.toFixed(0)} מתוך ₪${budget}`;
  } else {
    pctLabel.textContent = "";
    document.getElementById("budget-label").textContent = "לא הוגדר תקציב חודשי — הגדר בהגדרות";
  }

  // Weekly summary
  const weekEl = document.getElementById("weekly-summary");
  const weekDiff = weekData.diff || 0;
  weekEl.innerHTML = `
    <div class="weekly-item">
      <div class="label">השבוע</div>
      <div class="val">${fmt(weekData.thisWeek || 0)}</div>
    </div>
    <div class="weekly-item">
      <div class="label">שבוע קודם</div>
      <div class="val">${fmt(weekData.lastWeek || 0)}</div>
    </div>
    <div class="weekly-item">
      <div class="label">הפרש</div>
      <div class="val ${weekDiff > 0 ? "up" : "down"}">${weekDiff > 0 ? "+" : ""}${fmt(weekDiff)}</div>
    </div>
  `;

  // Insights
  const insightsList = document.getElementById("insights-list");
  insightsList.innerHTML = (insightsData.messages || [])
    .map(m => `<div class="insight-item">${m}</div>`)
    .join("") || '<div class="insight-item">✅ הכל נראה מאוזן</div>';

  // Recent expenses
  const recent = (expenses || []).slice(0, 5);
  const recentEl = document.getElementById("recent-expenses-list");
  if (!recent.length) {
    recentEl.innerHTML = '<div class="empty-state">לא הוספת הוצאות עדיין — התחל בהוספה מהירה!</div>';
  } else {
    recentEl.innerHTML = `<table>
      <thead><tr><th>כותרת</th><th>קטגוריה</th><th>סכום</th><th>תאריך</th></tr></thead>
      <tbody>${recent.map(e => `
        <tr>
          <td>${e.title}</td>
          <td>${catBadge(e.category)}</td>
          <td class="amount-cell">${fmt(e.amount)}</td>
          <td>${fmtDate(e.date)}</td>
        </tr>`).join("")}
      </tbody></table>`;
  }

  checkAlerts(insightsData);
}

// ========== EXPENSES PAGE ==========
async function loadExpenses() {
  const q        = document.getElementById("search-q")?.value || "";
  const category = document.getElementById("filter-cat")?.value || "all";
  const sort     = document.getElementById("filter-sort")?.value || "date_desc";
  const from     = document.getElementById("filter-from")?.value || "";
  const to       = document.getElementById("filter-to")?.value || "";

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category !== "all") params.set("category", category);
  if (sort) params.set("sort", sort);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const expenses = await api("/expenses?" + params.toString());
  const el = document.getElementById("expenses-list");
  const summaryBar = document.getElementById("expenses-summary-bar");

  if (!expenses || !expenses.length) {
    el.innerHTML = '<div class="empty-state">לא נמצאו הוצאות</div>';
    summaryBar.innerHTML = "";
    return;
  }

  const total = expenses.reduce((s, e) => s + e.amount, 0);
  summaryBar.innerHTML = `
    <div class="summary-chip">📊 ${expenses.length} הוצאות</div>
    <div class="summary-chip">💰 סה"כ: ${fmt(total)}</div>
    <div class="summary-chip">📈 ממוצע: ${fmt(total / expenses.length)}</div>
  `;

  el.innerHTML = `<table>
    <thead>
      <tr><th>כותרת</th><th>קטגוריה</th><th>סכום</th><th>תאריך</th><th>פעולות</th></tr>
    </thead>
    <tbody>
      ${expenses.map(e => `
        <tr>
          <td><strong>${e.title}</strong></td>
          <td>${catBadge(e.category)}</td>
          <td class="amount-cell">${fmt(e.amount)}</td>
          <td>${fmtDate(e.date)}</td>
          <td class="actions-cell">
            <button class="btn-icon" title="עריכה" onclick="openEditModal('${e._id}','${esc(e.title)}',${e.amount},'${e.category}','${e.date}')">✏️</button>
            <button class="btn-icon" title="מחיקה" onclick="deleteExpense('${e._id}')">🗑️</button>
          </td>
        </tr>`).join("")}
    </tbody></table>`;
}

function clearFilters() {
  document.getElementById("search-q").value = "";
  document.getElementById("filter-cat").value = "all";
  document.getElementById("filter-sort").value = "date_desc";
  document.getElementById("filter-from").value = "";
  document.getElementById("filter-to").value = "";
  loadExpenses();
}

// ========== STATS PAGE ==========
async function loadStats() {
  const [catData, dailyData, monthData, trendsData, monthlyData] = await Promise.all([
    api("/stats/categories"),
    api("/stats/daily"),
    api("/stats/months"),
    api("/stats/trends"),
    api("/stats/monthly")
  ]);

  // Category doughnut
  const catCtx = document.getElementById("cat-chart");
  if (catChart) catChart.destroy();
  const cats = Object.keys(catData);
  const vals = cats.map(k => catData[k]);
  catChart = new Chart(catCtx, {
    type: "doughnut",
    data: { labels: cats, datasets: [{ data: vals, backgroundColor: CAT_COLORS, borderWidth: 2, borderColor: "#fff" }] },
    options: {
      plugins: { legend: { position: "bottom", labels: { padding: 12, font: { size: 12 } } } },
      cutout: "62%"
    }
  });

  // Daily bar
  const dailyCtx = document.getElementById("daily-chart");
  if (dailyChart) dailyChart.destroy();
  const days = Object.keys(dailyData).map(Number).sort((a, b) => a - b);
  dailyChart = new Chart(dailyCtx, {
    type: "bar",
    data: {
      labels: days.map(d => `${d}`),
      datasets: [{ label: "₪", data: days.map(d => dailyData[d]), backgroundColor: "rgba(102,126,234,0.75)", borderRadius: 6 }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => "₪" + v } } }
    }
  });

  // Monthly bar (last 6 months)
  const monthlyCtx = document.getElementById("monthly-chart");
  if (monthlyChart) monthlyChart.destroy();
  const monthlySeries = Array.isArray(monthlyData) ? monthlyData : [];
  monthlyChart = new Chart(monthlyCtx, {
    type: "bar",
    data: {
      labels: monthlySeries.map(x => x.label),
      datasets: [{ label: "סה\"כ חודשי", data: monthlySeries.map(x => x.total), backgroundColor: "rgba(17,153,142,0.75)", borderRadius: 6 }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => "₪" + v } } }
    }
  });

  // Month compare
  const diffClass = monthData.diff > 0 ? "positive" : "negative";
  const diffSign  = monthData.diff > 0 ? "+" : "";
  document.getElementById("month-compare").innerHTML = `
    <div class="compare-item">
      <div class="label">חודש נוכחי</div>
      <div class="val">${fmt(monthData.current)}</div>
    </div>
    <div class="compare-item">
      <div class="label">חודש קודם</div>
      <div class="val">${fmt(monthData.last)}</div>
    </div>
    <div class="compare-item">
      <div class="label">הפרש</div>
      <div class="val ${diffClass}">${diffSign}${fmt(monthData.diff)}${monthData.pct ? ` (${monthData.pct}%)` : ""}</div>
    </div>`;

  // Trends
  const trendsEl = document.getElementById("trends-list");
  const trendEntries = Object.entries(trendsData).sort((a, b) => b[1].current - a[1].current);
  if (!trendEntries.length) {
    trendsEl.innerHTML = '<div class="empty-state">אין נתונים להשוואה</div>';
  } else {
    trendsEl.innerHTML = trendEntries.map(([cat, t]) => {
      const up   = t.diff > 0;
      const same = t.diff === 0;
      const arrow = same ? "→" : up ? "▲" : "▼";
      const cls   = same ? "same" : up ? "up" : "down";
      const pctTxt = t.pct !== null ? ` (${up ? "+" : ""}${t.pct}%)` : " (חדש)";
      const catObj = CATEGORIES.find(c => c.value === cat);
      return `<div class="trend-row">
        <div class="trend-cat">${catObj?.icon || ""} ${cat}</div>
        <div class="trend-vals">${fmt(t.last)} → ${fmt(t.current)}</div>
        <div class="trend-arrow ${cls}">${arrow}${pctTxt}</div>
      </div>`;
    }).join("");
  }
}

async function loadAIReport() {
  const el = document.getElementById("ai-report-output");
  el.textContent = "⏳ מנתח את ההוצאות שלך...";
  const res = await api("/ai/report");
  el.textContent = res.error ? "⚠️ " + res.error : res.ai;
}

// ========== AI CHAT ==========
async function sendChat() {
  const input = document.getElementById("chat-input");
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";

  appendChatMsg(msg, "user");
  const typing = appendChatMsg("מקליד...", "bot typing");

  const res = await api("/ai/chat", "POST", { message: msg, history: chatHistory });

  typing.remove();

  if (res.error) {
    appendChatMsg("⚠️ " + res.error, "bot");
  } else {
    appendChatMsg(res.reply, "bot");
    chatHistory.push({ role: "user", content: msg });
    chatHistory.push({ role: "assistant", content: res.reply });
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
  }
}

function askSuggestion(text) {
  document.getElementById("chat-input").value = text;
  sendChat();
}

function appendChatMsg(text, type) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `chat-msg ${type}`;
  div.innerHTML = `<div class="chat-bubble">${text.replace(/\n/g, "<br>")}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// ========== SETTINGS ==========
async function loadSettings() {
  const user = await api("/me");
  if (!user || user.error) return;
  if (user.budget)    document.getElementById("set-budget").value     = user.budget;
  if (user.goal)      document.getElementById("set-goal").value       = user.goal;
  if (user.foodLimit) document.getElementById("set-food-limit").value = user.foodLimit;
  if ("Notification" in window) updateNotifStatus(Notification.permission);
}

async function saveBudget() {
  const budget = parseFloat(document.getElementById("set-budget").value);
  if (isNaN(budget) || budget < 0) return showToast("הכנס מספר תקין", "warning");
  await api("/budget", "POST", { budget });
  shownAlerts.clear();
  showToast("✅ תקציב חודשי עודכן", "success");
}

async function saveGoal() {
  const goal = parseFloat(document.getElementById("set-goal").value);
  if (isNaN(goal) || goal < 0) return showToast("הכנס מספר תקין", "warning");
  await api("/goal", "POST", { goal });
  shownAlerts.clear();
  showToast("✅ יעד חיסכון עודכן", "success");
}

async function saveFoodLimit() {
  const foodLimit = parseFloat(document.getElementById("set-food-limit").value);
  if (isNaN(foodLimit) || foodLimit < 0) return showToast("הכנס מספר תקין", "warning");
  await api("/foodlimit", "POST", { foodLimit });
  shownAlerts.clear();
  showToast("✅ תקציב מזון עודכן", "success");
}

async function togglePlan() {
  const current = document.getElementById("plan-badge")?.textContent.includes("פרימיום") ? "premium" : "free";
  const next = current === "premium" ? "free" : "premium";
  const res = await api("/plan", "POST", { plan: next });
  if (res.error) return showToast("⚠️ " + res.error, "warning");
  showToast(next === "premium" ? "⭐ עברתם לפרימיום" : "חזרת לגרסה חינמית", "success");
  loadUserInfo();
}

// ========== QUICK ADD ==========
async function quickAdd() {
  const title    = document.getElementById("qa-title").value.trim();
  const amount   = parseFloat(document.getElementById("qa-amount").value);
  const category = document.getElementById("qa-category").value;
  if (!title || isNaN(amount) || amount <= 0) return showToast("נא למלא כותרת וסכום תקין", "warning");

  await api("/expenses", "POST", { title, amount, category });
  document.getElementById("qa-title").value  = "";
  document.getElementById("qa-amount").value = "";
  showToast(`✅ "${title}" נוספה`, "success");
  const updated = await api("/stats/insights");
  checkAlerts(updated);
  loadDashboard();
}

// ========== MODAL ==========
let selectedCategory = "מזון";

function buildCategoryGrid() {
  const grid = document.getElementById("category-grid");
  if (!grid) return;
  grid.innerHTML = CATEGORIES.map(c => `
    <button class="cat-btn${c.value === selectedCategory ? " selected" : ""}"
      onclick="selectCategory('${c.value}', this)">
      <div>${c.icon}</div>
      <div>${c.value}</div>
    </button>`).join("");
}

function selectCategory(val, el) {
  selectedCategory = val;
  document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("selected"));
  el.classList.add("selected");
}

function openAddModal() {
  document.getElementById("modal-title").textContent = "הוסף הוצאה";
  document.getElementById("modal-id").value = "";
  document.getElementById("modal-expense-title").value = "";
  document.getElementById("modal-expense-amount").value = "";
  document.getElementById("modal-expense-date").value = todayStr();
  selectedCategory = "מזון";
  buildCategoryGrid();
  document.getElementById("expense-modal").style.display = "flex";
}

function openEditModal(id, title, amount, category, date) {
  document.getElementById("modal-title").textContent = "עריכת הוצאה";
  document.getElementById("modal-id").value = id;
  document.getElementById("modal-expense-title").value = title;
  document.getElementById("modal-expense-amount").value = amount;
  document.getElementById("modal-expense-date").value = date ? date.slice(0, 10) : todayStr();
  selectedCategory = category;
  buildCategoryGrid();
  document.getElementById("expense-modal").style.display = "flex";
}

function closeModal() {
  document.getElementById("expense-modal").style.display = "none";
}

async function saveExpense() {
  const id     = document.getElementById("modal-id").value;
  const title  = document.getElementById("modal-expense-title").value.trim();
  const amount = parseFloat(document.getElementById("modal-expense-amount").value);
  const date   = document.getElementById("modal-expense-date").value;

  if (!title || isNaN(amount) || amount <= 0) return showToast("נא למלא כותרת וסכום תקין", "warning");

  if (id) {
    await api("/expenses/" + id, "PUT", { title, amount, category: selectedCategory, date });
    showToast("✅ הוצאה עודכנה", "success");
  } else {
    await api("/expenses", "POST", { title, amount, category: selectedCategory, date });
    showToast(`✅ "${title}" נוספה`, "success");
  }

  closeModal();
  const updated = await api("/stats/insights");
  checkAlerts(updated);
  loadExpenses();
}

async function deleteExpense(id) {
  if (!confirm("למחוק הוצאה זו?")) return;
  await api("/expenses/" + id, "DELETE");
  showToast("🗑️ הוצאה נמחקה", "info");
  loadExpenses();
}

// ========== HELPERS ==========
async function api(path, method = "GET", body = null) {
  try {
    const opts = {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    return await res.json();
  } catch (e) {
    console.error("API error:", e);
    return { error: e.message };
  }
}

function fmt(n) {
  return "₪" + Number(n || 0).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("he-IL");
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function esc(s) {
  return String(s).replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function catBadge(cat) {
  const c = CATEGORIES.find(x => x.value === cat);
  return `<span class="category-badge">${c?.icon || ""} ${cat}</span>`;
}

// Close modal on overlay click
document.getElementById("expense-modal")?.addEventListener("click", function(e) {
  if (e.target === this) closeModal();
});

// ========== PWA SERVICE WORKER ==========
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// PWA install prompt
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallBanner();
});

function showInstallBanner() {
  if (document.getElementById("install-banner")) return;
  const banner = document.createElement("div");
  banner.id = "install-banner";
  banner.innerHTML = `
    <span>📱 התקן את האפליקציה על הטלפון!</span>
    <button onclick="installPWA()" class="btn-install">התקן</button>
    <button onclick="this.parentElement.remove()" class="btn-dismiss">✕</button>
  `;
  document.body.appendChild(banner);
}

async function installPWA() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  document.getElementById("install-banner")?.remove();
  if (outcome === "accepted") showToast("✅ האפליקציה הותקנה!", "success");
}
