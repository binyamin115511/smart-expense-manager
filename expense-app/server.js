require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET || "smart_expense_secret_2024";
const GROQ_KEY   = process.env.GROQ_API_KEY || "";
const MONGO_URI  = process.env.MONGO_URI || "";

// =========================
// AI (Groq)
// =========================
let groq = null;
if (GROQ_KEY) {
  const Groq = require("groq-sdk");
  groq = new Groq({ apiKey: GROQ_KEY });
}

// =========================
// DB — MongoDB Atlas OR NeDB (local fallback)
// =========================
let db;

async function initDB() {
  if (MONGO_URI) {
    // ── Cloud: MongoDB Atlas ──
    const mongoose = require("mongoose");
    await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB Atlas connected");

    const UserSchema = new mongoose.Schema({
      email:     { type: String, unique: true },
      password:  String,
      budget:    { type: Number, default: 0 },
      goal:      { type: Number, default: 0 },
      foodLimit: { type: Number, default: 0 },
      plan:      { type: String, default: "free" }
    });
    const ExpenseSchema = new mongoose.Schema({
      userId:   String,
      title:    String,
      amount:   Number,
      category: String,
      date:     { type: Date, default: Date.now }
    });

    const User    = mongoose.models.User    || mongoose.model("User", UserSchema);
    const Expense = mongoose.models.Expense || mongoose.model("Expense", ExpenseSchema);

    db = {
      users: {
        findOne: q => User.findOne(q).lean(),
        find:    q => User.find(q).lean(),
        insert:  d => User.create(d).then(u => u.toObject()),
        update:  (q, u) => User.findOneAndUpdate(q, u, { new: true }).lean()
      },
      expenses: {
        findOne: q => Expense.findOne(q).lean(),
        find:    (q, sort) => Expense.find(q).sort(sort || { date: -1 }).lean(),
        insert:  d => Expense.create(d).then(e => e.toObject()),
        update:  (q, u) => Expense.findOneAndUpdate(q, u, { new: true }).lean(),
        remove:  q => Expense.deleteOne(q)
      }
    };

    // Normalize _id to string for MongoDB docs
    const wrap = (fn) => async (...args) => {
      const res = await fn(...args);
      if (!res) return res;
      const normalize = (d) => {
        if (!d) return d;
        d._id = d._id?.toString();
        return d;
      };
      return Array.isArray(res) ? res.map(normalize) : normalize(res);
    };

    for (const col of ["users", "expenses"]) {
      for (const method of ["findOne", "find", "insert", "update"]) {
        db[col][method] = wrap(db[col][method]);
      }
    }

  } else {
    // ── Local: NeDB ──
    const Datastore = require("@seald-io/nedb");
    const dbPath = path.join(__dirname, "data");
    require("fs").mkdirSync(dbPath, { recursive: true });

    const users    = new Datastore({ filename: path.join(dbPath, "users.db"),    autoload: true });
    const expenses = new Datastore({ filename: path.join(dbPath, "expenses.db"), autoload: true });
    users.ensureIndex({ fieldName: "email", unique: true });

    const p = (fn) => (...args) => new Promise((res, rej) => fn(...args, (e, d) => e ? rej(e) : res(d)));

    db = {
      users: {
        findOne: q => p(users.findOne.bind(users))(q),
        find:    q => p(users.find.bind(users))(q),
        insert:  d => p(users.insert.bind(users))(d),
        update:  (q, u) => new Promise((res, rej) =>
          users.update(q, u, { returnUpdatedDocs: true }, (e, n, doc) => e ? rej(e) : res(doc)))
      },
      expenses: {
        findOne: q => p(expenses.findOne.bind(expenses))(q),
        find:    (q, sort) => new Promise((res, rej) => {
          let cur = expenses.find(q);
          if (sort) cur = cur.sort(sort);
          cur.exec((e, d) => e ? rej(e) : res(d));
        }),
        insert: d => p(expenses.insert.bind(expenses))(d),
        update: (q, u) => new Promise((res, rej) =>
          expenses.update(q, u, { returnUpdatedDocs: true }, (e, n, doc) => e ? rej(e) : res(doc))),
        remove: q => p(expenses.remove.bind(expenses))(q, {})
      }
    };

    console.log("✅ NeDB (local) ready");
  }
}

// =========================
// AUTH MIDDLEWARE
// =========================
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.userId = jwt.verify(token, JWT_SECRET).id; next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.users.findOne({ email });
    if (!user) return res.status(401).json({ error: "User not found" });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: "Wrong password" });
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, email: user.email, budget: user.budget, goal: user.goal, plan: user.plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/me", auth, async (req, res) => {
  const user = await db.users.findOne({ _id: req.userId });
  if (!user) return res.status(404).json({ error: "Not found" });
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
      userId: req.userId, title, amount: Number(amount), category,
      date: date ? new Date(date).toISOString() : new Date().toISOString()
    });
    res.json(expense);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/expenses", auth, async (req, res) => {
  try {
    const { q, category, from, to } = req.query;
    let data = await db.expenses.find({ userId: req.userId });
    if (category && category !== "all") data = data.filter(e => e.category === category);
    if (q) { const re = new RegExp(q, "i"); data = data.filter(e => re.test(e.title)); }
    if (from) data = data.filter(e => new Date(e.date) >= new Date(from));
    if (to)   data = data.filter(e => new Date(e.date) <= new Date(to));
    data.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/expenses/:id", auth, async (req, res) => {
  try {
    const { title, amount, category, date } = req.body;
    const u = {};
    if (title)    u.title    = title;
    if (amount)   u.amount   = Number(amount);
    if (category) u.category = category;
    if (date)     u.date     = new Date(date).toISOString();
    const updated = await db.expenses.update(
      { _id: req.params.id, userId: req.userId }, { $set: u }
    );
    res.json(updated || await db.expenses.findOne({ _id: req.params.id }));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  const r = {};
  data.forEach(e => { r[e.category] = (r[e.category] || 0) + e.amount; });
  res.json(r);
});

app.get("/stats/months", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date(), m = now.getMonth(), y = now.getFullYear();
  let current = 0, last = 0;
  const lm = m === 0 ? 11 : m - 1, ly = m === 0 ? y - 1 : y;
  data.forEach(e => {
    const d = new Date(e.date);
    if (d.getMonth() === m && d.getFullYear() === y) current += e.amount;
    if (d.getMonth() === lm && d.getFullYear() === ly) last += e.amount;
  });
  res.json({ current, last, diff: current - last, pct: last > 0 ? ((current - last) / last * 100).toFixed(1) : null });
});

app.get("/stats/daily", auth, async (req, res) => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const data = await db.expenses.find({ userId: req.userId });
  const byDay = {};
  data.filter(e => new Date(e.date) >= start)
      .forEach(e => { const d = new Date(e.date).getDate(); byDay[d] = (byDay[d] || 0) + e.amount; });
  res.json(byDay);
});

app.get("/stats/weekly", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0,0,0,0);
  const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  let thisWeek = 0, lastWeek = 0;
  const byDay = {0:0,1:0,2:0,3:0,4:0,5:0,6:0};
  data.forEach(e => {
    const d = new Date(e.date);
    if (d >= weekStart) { thisWeek += e.amount; byDay[d.getDay()] += e.amount; }
    else if (d >= lastWeekStart) lastWeek += e.amount;
  });
  res.json({ thisWeek, lastWeek, diff: thisWeek - lastWeek, byDay });
});

app.get("/stats/trends", auth, async (req, res) => {
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date(), m = now.getMonth(), y = now.getFullYear();
  const lm = m === 0 ? 11 : m - 1, ly = m === 0 ? y - 1 : y;
  const cur = {}, lst = {};
  data.forEach(e => {
    const d = new Date(e.date);
    if (d.getMonth() === m && d.getFullYear() === y) cur[e.category] = (cur[e.category] || 0) + e.amount;
    if (d.getMonth() === lm && d.getFullYear() === ly) lst[e.category] = (lst[e.category] || 0) + e.amount;
  });
  const trends = {};
  new Set([...Object.keys(cur), ...Object.keys(lst)]).forEach(cat => {
    const c = cur[cat] || 0, l = lst[cat] || 0;
    trends[cat] = { current: c, last: l, diff: c - l, pct: l > 0 ? ((c - l) / l * 100).toFixed(1) : null };
  });
  res.json(trends);
});

app.get("/stats/insights", auth, async (req, res) => {
  const user = await db.users.findOne({ _id: req.userId });
  const data = await db.expenses.find({ userId: req.userId });
  const now = new Date(), m = now.getMonth(), y = now.getFullYear();
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
    messages.push(`🔶 השתמשת ב-${Math.round((monthTotal/user.budget)*100)}% מהתקציב החודשי`);
  if (user.goal && total > user.goal)
    messages.push(`❌ חרגת מהיעד הכולל (${total.toFixed(0)} > ${user.goal})`);
  const topCat = Object.entries(cats).sort((a,b) => b[1]-a[1])[0];
  if (topCat && total > 0 && topCat[1] > total * 0.4)
    messages.push(`📊 הוצאות גבוהות בקטגוריה "${topCat[0]}" (${Math.round((topCat[1]/total)*100)}%)`);
  const foodTotal = cats["מזון"] || 0;
  if (user.foodLimit && foodTotal > user.foodLimit)
    messages.push(`🍔 חרגת מתקציב המזון (${foodTotal.toFixed(0)} > ${user.foodLimit})`);
  if (!messages.length) messages.push("✅ הוצאותיך נראות מאוזנות");
  res.json({ total, monthTotal, messages, categories: cats, foodTotal,
    budget: user.budget||0, goal: user.goal||0, foodLimit: user.foodLimit||0,
    topCategory: topCat ? topCat[0] : null });
});

// =========================
// BUDGET / GOAL / FOOD
// =========================
app.post("/budget",    auth, async (req, res) => { await db.users.update({ _id: req.userId }, { $set: { budget:    Number(req.body.budget)    } }); res.json({ ok: true }); });
app.post("/goal",      auth, async (req, res) => { await db.users.update({ _id: req.userId }, { $set: { goal:      Number(req.body.goal)      } }); res.json({ ok: true }); });
app.post("/foodlimit", auth, async (req, res) => { await db.users.update({ _id: req.userId }, { $set: { foodLimit: Number(req.body.foodLimit) } }); res.json({ ok: true }); });

// =========================
// AI REPORT
// =========================
app.get("/ai/report", auth, async (req, res) => {
  if (!groq) return res.status(400).json({ error: "Groq API key not configured" });
  const user = await db.users.findOne({ _id: req.userId });
  const data = await db.expenses.find({ userId: req.userId });
  let summary = "", total = 0;
  data.forEach(e => { summary += `${e.title} - ₪${e.amount} - ${e.category}\n`; total += e.amount; });
  try {
    const ai = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: `אתה יועץ פיננסי אישי. נתח את ההוצאות ותן 3 עצות פשוטות בעברית:\n\nהוצאות:\n${summary||"אין"}\n\nסה"כ: ₪${total}\nתקציב: ₪${user.budget||"לא הוגדר"}\nיעד: ₪${user.goal||"לא הוגדר"}` }]
    });
    res.json({ ai: ai.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =========================
// AI CHAT
// =========================
app.post("/ai/chat", auth, async (req, res) => {
  if (!groq) return res.status(400).json({ error: "Groq API key not configured" });
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });
  const user = await db.users.findOne({ _id: req.userId });
  const data = await db.expenses.find({ userId: req.userId });
  let total = 0; const cats = {};
  const now = new Date(), m = now.getMonth(), y = now.getFullYear(); let monthTotal = 0;
  data.forEach(e => {
    total += e.amount; cats[e.category] = (cats[e.category]||0) + e.amount;
    const d = new Date(e.date);
    if (d.getMonth()===m && d.getFullYear()===y) monthTotal += e.amount;
  });
  const catSummary = Object.entries(cats).map(([k,v]) => `${k}: ₪${v.toFixed(0)}`).join(", ");
  try {
    const ai = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 400,
      messages: [
        { role: "system", content: `אתה יועץ פיננסי אישי חכם. ענה תמיד בעברית קצר וברור.\nנתוני המשתמש: סה"כ ₪${total.toFixed(0)}, חודש נוכחי ₪${monthTotal.toFixed(0)}, תקציב ₪${user.budget||"לא הוגדר"}, יעד ₪${user.goal||"לא הוגדר"}, קטגוריות: ${catSummary||"אין"}` },
        ...(history||[]).slice(-6),
        { role: "user", content: message }
      ]
    });
    res.json({ reply: ai.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =========================
// SPA fallback
// =========================
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// =========================
// START
// =========================
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Smart Expense Manager → http://localhost:${PORT}`);
    if (!MONGO_URI) console.log("⚠️  Running with local NeDB — set MONGO_URI for cloud persistence");
  });
}).catch(e => { console.error("DB init failed:", e); process.exit(1); });
