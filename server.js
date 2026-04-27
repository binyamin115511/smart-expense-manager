require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Datastore = require("@seald-io/nedb");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET || "smart_expense_secret_2024";
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// =========================
// DB (NeDB)
// =========================
const dbPath = path.join(__dirname, "data");
require("fs").mkdirSync(dbPath, { recursive: true });

const users = new Datastore({ filename: path.join(dbPath, "users.db"), autoload: true });
const expenses = new Datastore({ filename: path.join(dbPath, "expenses.db"), autoload: true });

users.ensureIndex({ fieldName: "email", unique: true });

const db = {
  users: {
    findOne: (q) => new Promise((res, rej) => users.findOne(q, (e, d) => e ? rej(e) : res(d))),
    find: (q) => new Promise((res, rej) => users.find(q, (e, d) => e ? rej(e) : res(d))),
    insert: (d) => new Promise((res, rej) => users.insert(d, (e, r) => e ? rej(e) : res(r))),
    update: (q, u, o) => new Promise((res, rej) => users.update(q, u, o || {}, (e, n) => e ? rej(e) : res(n)))
  },
  expenses: {
    findOne: (q) => new Promise((res, rej) => expenses.findOne(q, (e, d) => e ? rej(e) : res(d))),
    find: (q, sort) => new Promise((res, rej) => {
      let cursor = expenses.find(q);
      if (sort) cursor = cursor.sort(sort);
      cursor.exec((e, d) => e ? rej(e) : res(d));
    }),
    insert: (d) => new Promise((res, rej) => expenses.insert(d, (e, r) => e ? rej(e) : res(r))),
    update: (q, u, o) => new Promise((res, rej) => expenses.update(q, u, o || {}, (e, n, r) => e ? rej(e) : res(r))),
    remove: (q) => new Promise((res, rej) => expenses.remove(q, {}, (e, n) => e ? rej(e) : res(n)))
  }
};

// =========================
// AI (OpenAI / Groq)
// =========================
let groq = null;
let openai = null;
if (OPENAI_KEY) {
  const OpenAI = require("openai");
  openai = new OpenAI({ apiKey: OPENAI_KEY });
} else if (GROQ_KEY) {
  const Groq = require("groq-sdk");
  groq = new Groq({ apiKey: GROQ_KEY });
}

async function runAI(messages, maxTokens = 450) {
  if (openai) {
    const result = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      max_tokens: maxTokens
    });
    return result.choices?.[0]?.message?.content || "לא התקבלה תשובה";
  }

  if (groq) {
    const result = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      max_tokens: maxTokens
    });
    return result.choices?.[0]?.message?.content || "לא התקבלה תשובה";
  }

  throw new Error("AI provider is not configured");
}

// =========================
// AUTH MIDDLEWARE
// =========================
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// =========================
// AUTH ROUTES
// =========================
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const exists = await db.users.findOne({ email });
    if (exists) return res.status(400).json({ error: "Email already registered" });
    const hashed = await bcrypt.hash(password, 10);
    await db.users.insert({ email, password: hashed, budget: 0, goal: 0, foodLimit: 0, plan: "free" });
    res.json({ message: "User created" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.users.findOne({ email });
    if (!user) return res.status(401).json({ error: "User not found" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Wrong password" });
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, email: user.email, budget: user.budget, goal: user.goal, plan: user.plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/me", auth, async (req, res) => {
  const user = await db.users.findOne({ _id: req.userId });
  if (!user) return res.status(404).json({ error: "User not found" });
  const { password: _, ...safe } = user;
  res.json(safe);
});

// =========================
// EXPENSE CRUD
// =========================
app.post("/expenses", auth, async (req, res) => {
  try {
    const { title, amount, category, date } = req.body;
    if (!title || !amount || !category) return res.status(400).json({ error: "Missing fields" });
    const expense = await db.expenses.insert({
      userId: req.userId,
      title,
      amount: Number(amount),
      category,
      date: date ? new Date(date).toISOString() : new Date().toISOString()
    });
    res.json(expense);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/expenses", auth, async (req, res) => {
  try {
    const { q, category, from, to, sort = "date_desc" } = req.query;
    let filter = { userId: req.userId };
    if (category && category !== "all") filter.category = category;
    let data = await db.expenses.find(filter, { date: -1 });
    if (q) { const re = new RegExp(q, "i"); data = data.filter(e => re.test(e.title)); }
    if (from) data = data.filter(e => new Date(e.date) >= new Date(from));
    if (to) data = data.filter(e => new Date(e.date) <= new Date(to));
    if (sort === "amount_asc") data.sort((a, b) => a.amount - b.amount);
    else if (sort === "amount_desc") data.sort((a, b) => b.amount - a.amount);
    else if (sort === "date_asc") data.sort((a, b) => new Date(a.date) - new Date(b.date));
    else data.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/expenses/:id", auth, async (req, res) => {
  try {
    const { title, amount, category, date } = req.body;
    const update = {};
    if (title) update.title = title;
    if (amount) update.amount = Number(amount);
    if (category) update.category = category;
    if (date) update.date = new Date(date).toISOString();
    await db.expenses.update({ _id: req.params.id, userId: req.userId }, { $set: update }, {});
    const updated = await db.expenses.findOne({ _id: req.params.id });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/expenses/:id", auth, async (req, res) => {
  await db.expenses.remove({ _id: req.params.id, userId: req.userId });
  res.json({ message: "deleted" });
});

// =========================
// STATS
// =========================
app.get("/stats/categories", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const result = {};
  data.forEach(e => { result[e.category] = (result[e.category] || 0) + e.amount; });
  res.json(result);
});

app.get("/stats/total", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const total = data.reduce((sum, e) => sum + e.amount, 0);
  res.json({ total });
});

app.get("/stats/months", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date();
  const m = now.getMonth(), y = now.getFullYear();
  let current = 0, last = 0;
  data.forEach(e => {
    const d = new Date(e.date);
    const em = d.getMonth(), ey = d.getFullYear();
    if (em === m && ey === y) current += e.amount;
    const lm = m === 0 ? 11 : m - 1;
    const ly = m === 0 ? y - 1 : y;
    if (em === lm && ey === ly) last += e.amount;
  });
  res.json({ current, last, diff: current - last, pct: last > 0 ? ((current - last) / last * 100).toFixed(1) : null });
});

app.get("/stats/daily", auth, async (req, res) => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const data = await db.expenses.find({ userId: req.userId });
  const byDay = {};
  data.filter(e => new Date(e.date) >= start).forEach(e => {
    const day = new Date(e.date).getDate();
    byDay[day] = (byDay[day] || 0) + e.amount;
  });
  res.json(byDay);
});

app.get("/stats/monthly", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date();
  const monthly = [];

  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = d.getMonth();
    const year = d.getFullYear();
    const total = data
      .filter((e) => {
        const ed = new Date(e.date);
        return ed.getMonth() === month && ed.getFullYear() === year;
      })
      .reduce((sum, e) => sum + e.amount, 0);

    monthly.push({
      label: d.toLocaleDateString("he-IL", { month: "short", year: "2-digit" }),
      total: Number(total.toFixed(2))
    });
  }

  res.json(monthly);
});

app.get("/stats/monthly", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date();
  const points = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    points.push({ key, label: `${String(m + 1).padStart(2, "0")}/${y}`, total: 0, y, m });
  }

  data.forEach((e) => {
    const d = new Date(e.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const p = points.find((x) => x.key === key);
    if (p) p.total += e.amount;
  });

  res.json(points.map((p) => ({ label: p.label, total: p.total })));
});

// NEW: trends per category (current vs last month)
app.get("/stats/trends", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date();
  const m = now.getMonth(), y = now.getFullYear();
  const lm = m === 0 ? 11 : m - 1;
  const ly = m === 0 ? y - 1 : y;
  const current = {}, last = {};
  data.forEach(e => {
    const d = new Date(e.date);
    if (d.getMonth() === m && d.getFullYear() === y) current[e.category] = (current[e.category] || 0) + e.amount;
    if (d.getMonth() === lm && d.getFullYear() === ly) last[e.category] = (last[e.category] || 0) + e.amount;
  });
  const trends = {};
  const cats = new Set([...Object.keys(current), ...Object.keys(last)]);
  cats.forEach(cat => {
    const c = current[cat] || 0;
    const l = last[cat] || 0;
    trends[cat] = { current: c, last: l, diff: c - l, pct: l > 0 ? ((c - l) / l * 100).toFixed(1) : null };
  });
  res.json(trends);
});

// NEW: weekly summary
app.get("/stats/weekly", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  let thisWeek = 0, lastWeek = 0;
  const byDay = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

  data.forEach(e => {
    const d = new Date(e.date);
    if (d >= weekStart) { thisWeek += e.amount; byDay[d.getDay()] += e.amount; }
    else if (d >= lastWeekStart && d < weekStart) lastWeek += e.amount;
  });

  res.json({ thisWeek, lastWeek, diff: thisWeek - lastWeek, byDay });
});

app.get("/stats/insights", auth, async (req, res) => {
  const user = await db.users.findOne({ _id: req.userId });
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date();
  const m = now.getMonth(), y = now.getFullYear();
  let total = 0, monthTotal = 0;
  const cats = {};

  data.forEach(e => {
    total += e.amount;
    cats[e.category] = (cats[e.category] || 0) + e.amount;
    const d = new Date(e.date);
    if (d.getMonth() === m && d.getFullYear() === y) monthTotal += e.amount;
  });

  const messages = [];
  if (user.budget && monthTotal > user.budget)
    messages.push(`⚠️ חרגת מהתקציב החודשי (${monthTotal.toFixed(0)} > ${user.budget})`);
  else if (user.budget && monthTotal > user.budget * 0.8)
    messages.push(`🔶 השתמשת ב-${Math.round((monthTotal / user.budget) * 100)}% מהתקציב החודשי`);

  if (user.goal && total > user.goal)
    messages.push(`❌ חרגת מהיעד הכולל (${total.toFixed(0)} > ${user.goal})`);

  const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
  if (topCat && total > 0 && topCat[1] > total * 0.4)
    messages.push(`📊 הוצאות גבוהות בקטגוריה "${topCat[0]}" (${Math.round((topCat[1] / total) * 100)}%)`);

  const foodTotal = cats["מזון"] || 0;
  if (user.foodLimit && foodTotal > user.foodLimit)
    messages.push(`🍔 חרגת מתקציב המזון (${foodTotal.toFixed(0)} > ${user.foodLimit})`);

  const avg = data.length ? total / data.length : 0;
  const unusual = data.filter((e) => avg > 0 && e.amount > avg * 2.5).slice(0, 3);
  if (unusual.length) {
    messages.push(`🧠 זוהו ${unusual.length} הוצאות חריגות ביחס לממוצע שלך`);
  }

  if (!messages.length) messages.push("✅ הוצאותיך נראות מאוזנות");

  res.json({
    total, monthTotal, messages, categories: cats,
    foodTotal, budget: user.budget || 0, goal: user.goal || 0, foodLimit: user.foodLimit || 0,
    topCategory: topCat ? topCat[0] : null
  });
});

// =========================
// BUDGET + GOAL + FOOD LIMIT
// =========================
app.post("/budget", auth, async (req, res) => {
  await db.users.update({ _id: req.userId }, { $set: { budget: Number(req.body.budget) } });
  res.json({ ok: true });
});

app.post("/goal", auth, async (req, res) => {
  await db.users.update({ _id: req.userId }, { $set: { goal: Number(req.body.goal) } });
  res.json({ ok: true });
});

app.post("/foodlimit", auth, async (req, res) => {
  await db.users.update({ _id: req.userId }, { $set: { foodLimit: Number(req.body.foodLimit) } });
  res.json({ ok: true });
});

app.post("/plan", auth, async (req, res) => {
  const plan = req.body.plan === "premium" ? "premium" : "free";
  await db.users.update({ _id: req.userId }, { $set: { plan } });
  res.json({ ok: true, plan });
});

// =========================
// AI REPORT
// =========================
app.get("/ai/report", auth, async (req, res) => {
  if (!groq && !openai) return res.status(400).json({ error: "AI key not configured" });
  const user = await db.users.findOne({ _id: req.userId });
  if (!user || user.plan !== "premium") {
    return res.status(403).json({ error: "AI available for premium users only" });
  }
  const data = await db.expenses.find({ userId: req.userId });
  let summary = "", total = 0;
  data.forEach(e => { summary += `${e.title} - ₪${e.amount} - ${e.category}\n`; total += e.amount; });

  const prompt = `אתה יועץ פיננסי אישי. נתח את ההוצאות ותן 3 עצות פשוטות בעברית:

הוצאות:
${summary || "אין הוצאות עדיין"}

סה"כ: ₪${total}
תקציב חודשי: ₪${user.budget || "לא הוגדר"}
יעד: ₪${user.goal || "לא הוגדר"}`;

  try {
    const ai = await runAI([{ role: "user", content: prompt }], 450);
    res.json({ ai });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// AI CHAT (NEW)
// =========================
app.post("/ai/chat", auth, async (req, res) => {
  if (!groq && !openai) return res.status(400).json({ error: "AI key not configured" });

  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  const user = await db.users.findOne({ _id: req.userId });
  if (!user || user.plan !== "premium") {
    return res.status(403).json({ error: "AI available for premium users only" });
  }
  const data = await db.expenses.find({ userId: req.userId });

  let total = 0;
  const cats = {};
  const now = new Date();
  const m = now.getMonth(), y = now.getFullYear();
  let monthTotal = 0;

  data.forEach(e => {
    total += e.amount;
    cats[e.category] = (cats[e.category] || 0) + e.amount;
    const d = new Date(e.date);
    if (d.getMonth() === m && d.getFullYear() === y) monthTotal += e.amount;
  });

  const catSummary = Object.entries(cats).map(([k, v]) => `${k}: ₪${v.toFixed(0)}`).join(", ");

  const systemPrompt = `אתה יועץ פיננסי אישי חכם ואדיב. אתה עונה תמיד בעברית בצורה קצרה וברורה.

נתוני המשתמש:
- סה"כ הוצאות: ₪${total.toFixed(0)}
- הוצאות חודש נוכחי: ₪${monthTotal.toFixed(0)}
- תקציב חודשי: ₪${user.budget || "לא הוגדר"}
- יעד חיסכון: ₪${user.goal || "לא הוגדר"}
- הוצאות לפי קטגוריה: ${catSummary || "אין נתונים"}

ענה על שאלות המשתמש בהתבסס על הנתונים האלה. תן עצות מעשיות וספציפיות.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...(history || []).slice(-6),
    { role: "user", content: message }
  ];

  try {
    const reply = await runAI(messages, 450);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// SPA fallback
// =========================
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =========================
// SERVER
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();
  let localIP = "localhost";
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log(`✅ Smart Expense Manager`);
  console.log(`   מחשב:  http://localhost:${PORT}`);
  console.log(`   טלפון: http://${localIP}:${PORT}`);
});
