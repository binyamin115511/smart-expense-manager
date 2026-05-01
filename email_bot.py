import os
import time
import base64
import sqlite3
import json
from datetime import datetime, timedelta, timezone
from email import message_from_bytes
from email.header import decode_header
from email.mime.text import MIMEText

from dotenv import load_dotenv
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

load_dotenv()

# ================= CONFIG =================
SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
]
ARCHIVE_DAYS     = int(os.getenv("ARCHIVE_DAYS", 180))
SUMMARY_EMAIL    = os.getenv("SUMMARY_EMAIL", "")
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

URGENT_CATEGORIES = {"client", "finance", "security"}

LABELS = {
    "shopping":   "Shopping",
    "finance":    "Finance",
    "work":       "Work",
    "social":     "Social",
    "newsletter": "Newsletter",
    "security":   "Security",
    "travel":     "Travel",
    "spam":       "Junk-Mail",
    "client":     "Client",
    "general":    "General",
}

KEYWORDS = {
    "shopping": [
        "order", "הזמנה", "shipped", "נשלח", "delivery", "משלוח", "tracking", "מעקב",
        "aliexpress", "amazon", "ebay", "ksp", "zara", "fashion nova", "purchase",
        "רכישה", "cart", "עגלה", "checkout", "קנייה", "store", "חנות", "item", "פריט",
        "package", "חבילה", "receipt", "קבלה", "return", "החזרה", "refund", "החזר כספי",
    ],
    "finance": [
        "invoice", "חשבונית", "payment", "תשלום", "bank", "בנק", "salary", "משכורת",
        "tax", "מס", "billing", "חיוב", "transfer", "העברה", "account", "חשבון",
        "credit", "אשראי", "loan", "הלוואה", "insurance", "ביטוח", "investment", "השקעה",
        "budget", "תקציב", "expense", "הוצאה", "income", "הכנסה", "paypal", "bit", "ביט",
        "payoneer", "תלוש שכר", "חשבון בנק",
    ],
    "work": [
        "meeting", "פגישה", "deadline", "דדליין", "task", "משימה", "report", "דוח",
        "office", "משרד", "schedule", "לוח זמנים", "hr", "slack", "zoom", "jira",
        "project", "פרויקט", "team", "צוות", "manager", "מנהל", "employee", "עובד",
        "contract", "חוזה", "interview", "ראיון", "career", "קריירה", "linkedin",
        "resume", "קורות חיים", "hiring", "גיוס",
    ],
    "social": [
        "facebook", "instagram", "twitter", "tiktok", "whatsapp", "youtube",
        "followed", "liked", "commented", "tagged", "friend request", "בקשת חברות",
        "shared", "שיתף",
    ],
    "newsletter": [
        "newsletter", "ניוזלטר", "unsubscribe", "הסר מרשימה", "digest", "weekly",
        "שבועי", "monthly", "חודשי", "blog", "בלוג", "tips", "טיפים", "news",
        "חדשות", "מגזין", "magazine", "subscription", "מנוי",
    ],
    "security": [
        "security", "אבטחה", "password", "סיסמה", "verify", "verification",
        "login", "כניסה", "suspicious", "חשוד", "unauthorized", "two-factor", "2fa",
        "breach", "פרצה", "reset", "איפוס", "התראת אבטחה",
    ],
    "travel": [
        "flight", "טיסה", "hotel", "מלון", "airbnb", "trip", "נסיעה", "vacation",
        "חופשה", "passport", "דרכון", "visa", "אשרה", "itinerary", "מסלול",
        "check-in", "airport", "שדה תעופה", "airline",
    ],
    "spam": [
        "winner", "זכית", "free money", "lottery", "הגרלה", "congratulations",
        "limited time", "זמן מוגבל", "act now", "click here", "earn money",
        "make money", "weight loss", "casino", "קזינו",
    ],
    "client": [
        "client", "לקוח", "customer", "proposal", "הצעת מחיר", "quote", "הצעה",
        "contract", "חוזה", "deal", "עסקה", "partner", "שותף",
    ],
}

URGENT_KEYWORDS = [
    "urgent", "דחוף", "asap", "immediately", "מיידי", "critical", "קריטי",
    "important", "חשוב", "action required", "נדרשת פעולה", "expires", "פג תוקף",
]


# ================= DATABASE =================
conn = sqlite3.connect("emails.db")
cursor = conn.cursor()
cursor.execute("""
CREATE TABLE IF NOT EXISTS emails (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_id   TEXT UNIQUE,
    sender     TEXT,
    subject    TEXT,
    category   TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
""")
conn.commit()


# ================= AUTH =================
def authenticate() -> Credentials:
    # תמיכה בענן — טעינה ממשתני סביבה
    token_b64 = os.getenv("TOKEN_JSON_B64")
    creds_b64 = os.getenv("CREDENTIALS_JSON_B64")

    if token_b64 and not os.path.exists("token.json"):
        with open("token.json", "w") as f:
            f.write(base64.b64decode(token_b64).decode())

    if creds_b64 and not os.path.exists("credentials.json"):
        with open("credentials.json", "w") as f:
            f.write(base64.b64decode(creds_b64).decode())

    if os.path.exists("token.json"):
        return Credentials.from_authorized_user_file("token.json", SCOPES)

    flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
    creds = flow.run_local_server(port=0)
    with open("token.json", "w") as f:
        f.write(creds.to_json())
    return creds


def get_service():
    return build("gmail", "v1", credentials=authenticate())


# ================= GMAIL HELPERS =================
def get_inbox_messages(service) -> list:
    messages, page_token = [], None
    while True:
        kwargs = {"userId": "me", "labelIds": ["INBOX"], "maxResults": 500}
        if page_token:
            kwargs["pageToken"] = page_token
        results = service.users().messages().list(**kwargs).execute()
        messages.extend(results.get("messages", []))
        page_token = results.get("nextPageToken")
        if not page_token:
            break
    return messages


def get_message_detail(service, msg_id):
    msg = service.users().messages().get(userId="me", id=msg_id, format="raw").execute()
    raw = base64.urlsafe_b64decode(msg["raw"])
    return message_from_bytes(raw)


def get_message_metadata(service, msg_id):
    return service.users().messages().get(
        userId="me", id=msg_id, format="metadata",
        metadataHeaders=["Subject", "From", "Date"]
    ).execute()


def extract_body(email_msg) -> str:
    if email_msg.is_multipart():
        for part in email_msg.walk():
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if ct == "text/plain" and "attachment" not in cd:
                payload = part.get_payload(decode=True)
                if payload:
                    return payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    else:
        payload = email_msg.get_payload(decode=True)
        if payload:
            return payload.decode(email_msg.get_content_charset() or "utf-8", errors="replace")
    return ""


def decode_subject(raw) -> str:
    if not raw:
        return "(ללא נושא)"
    parts = decode_header(str(raw))
    return "".join(
        p.decode(enc or "utf-8") if isinstance(p, bytes) else p
        for p, enc in parts
    )


_label_cache: dict = {}

def get_or_create_label(service, label_name: str) -> str:
    if label_name in _label_cache:
        return _label_cache[label_name]
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    for label in labels:
        if label["name"] == label_name:
            _label_cache[label_name] = label["id"]
            return label["id"]
    created = service.users().labels().create(
        userId="me",
        body={"name": label_name, "labelListVisibility": "labelShow", "messageListVisibility": "show"},
    ).execute()
    _label_cache[label_name] = created["id"]
    return created["id"]


def apply_label(service, msg_id: str, label_name: str):
    label_id = get_or_create_label(service, label_name)
    service.users().messages().modify(
        userId="me", id=msg_id,
        body={"addLabelIds": [label_id], "removeLabelIds": ["INBOX"]}
    ).execute()


def star_message(service, msg_id: str):
    service.users().messages().modify(
        userId="me", id=msg_id,
        body={"addLabelIds": ["STARRED"]}
    ).execute()


# ================= CLASSIFICATION =================
def classify_email(subject: str, sender: str, body: str) -> str:
    text = (str(subject) + " " + str(sender) + " " + body[:500]).lower()
    scores = {cat: sum(1 for kw in kws if kw in text) for cat, kws in KEYWORDS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "general"


def is_urgent(subject: str, body: str) -> bool:
    text = (str(subject) + " " + body[:300]).lower()
    return any(kw in text for kw in URGENT_KEYWORDS)


# ================= TELEGRAM =================
def send_telegram(message: str):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return
    try:
        import urllib.request
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        data = json.dumps({"chat_id": TELEGRAM_CHAT_ID, "text": message}).encode()
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


# ================= DAILY SUMMARY =================
def send_daily_summary(service, stats: dict):
    if not SUMMARY_EMAIL:
        return

    today = datetime.now().strftime("%d/%m/%Y")
    total = sum(stats.values())
    if total == 0:
        return

    rows = ""
    icons = {"shopping": "🛍", "finance": "💰", "work": "💼", "social": "👥",
             "newsletter": "📰", "security": "🔒", "travel": "✈️",
             "spam": "🗑", "client": "📩", "general": "📋"}
    for cat, count in sorted(stats.items(), key=lambda x: -x[1]):
        if count:
            rows += f"<tr><td>{icons.get(cat,'')} {LABELS[cat]}</td><td><b>{count}</b></td></tr>"

    html = f"""
    <div style="font-family:Arial;max-width:500px;margin:auto;direction:rtl">
      <h2 style="color:#1a73e8">📬 סיכום יומי — {today}</h2>
      <p>עובדו <b>{total}</b> מיילים היום:</p>
      <table style="width:100%;border-collapse:collapse">
        <tr style="background:#f1f3f4"><th style="padding:8px;text-align:right">קטגוריה</th><th style="padding:8px">כמות</th></tr>
        {rows}
      </table>
      <p style="color:#888;font-size:12px;margin-top:20px">הבוט שלך עובד 24/7 🤖</p>
    </div>
    """

    msg = MIMEText(html, "html", "utf-8")
    msg["To"] = SUMMARY_EMAIL
    msg["From"] = "me"
    msg["Subject"] = f"📬 סיכום בוט מיילים — {today}"

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service.users().messages().send(userId="me", body={"raw": raw}).execute()
    print(f"📊 סיכום יומי נשלח ל-{SUMMARY_EMAIL}")


# ================= ARCHIVE OLD EMAILS =================
def archive_old_emails(service):
    cutoff = datetime.now(timezone.utc) - timedelta(days=ARCHIVE_DAYS)
    cutoff_ts = int(cutoff.timestamp())

    results = service.users().messages().list(
        userId="me",
        labelIds=["INBOX"],
        q=f"before:{cutoff_ts}",
        maxResults=200
    ).execute()

    old_messages = results.get("messages", [])
    if not old_messages:
        return

    print(f"📦 מארכב {len(old_messages)} מיילים ישנים...")
    for msg in old_messages:
        service.users().messages().modify(
            userId="me", id=msg["id"],
            body={"removeLabelIds": ["INBOX"]}
        ).execute()
    print(f"   ✅ {len(old_messages)} מיילים הועברו לארכיון")


# ================= DASHBOARD =================
def generate_dashboard():
    cursor.execute("""
        SELECT category, COUNT(*) as count
        FROM emails
        GROUP BY category
        ORDER BY count DESC
    """)
    rows = cursor.fetchall()

    cursor.execute("SELECT COUNT(*) FROM emails")
    total = cursor.fetchone()[0]

    cursor.execute("""
        SELECT sender, COUNT(*) as count
        FROM emails
        GROUP BY sender
        ORDER BY count DESC
        LIMIT 5
    """)
    top_senders = cursor.fetchall()

    icons = {"shopping": "🛍", "finance": "💰", "work": "💼", "social": "👥",
             "newsletter": "📰", "security": "🔒", "travel": "✈️",
             "spam": "🗑", "client": "📩", "general": "📋"}

    cat_rows = ""
    for cat, count in rows:
        pct = round(count / total * 100) if total else 0
        label = LABELS.get(cat, cat)
        icon = icons.get(cat, "📧")
        cat_rows += f"""
        <tr>
          <td>{icon} {label}</td>
          <td>{count}</td>
          <td>
            <div style="background:#e8f0fe;border-radius:4px;height:18px;width:100%">
              <div style="background:#1a73e8;height:18px;border-radius:4px;width:{pct}%"></div>
            </div>
          </td>
          <td>{pct}%</td>
        </tr>"""

    sender_rows = ""
    for sender, count in top_senders:
        short = sender[:45] + "..." if len(sender) > 45 else sender
        sender_rows += f"<tr><td>{short}</td><td><b>{count}</b></td></tr>"

    now = datetime.now().strftime("%d/%m/%Y %H:%M")
    html = f"""<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <title>דשבורד בוט מיילים</title>
  <style>
    body {{ font-family: Arial, sans-serif; background: #f8f9fa; padding: 30px; color: #333; }}
    h1 {{ color: #1a73e8; }}
    .card {{ background: white; border-radius: 12px; padding: 20px; margin: 15px 0;
             box-shadow: 0 2px 8px rgba(0,0,0,0.08); }}
    .stat {{ display: inline-block; text-align: center; margin: 10px 20px; }}
    .stat-num {{ font-size: 2.5em; font-weight: bold; color: #1a73e8; }}
    table {{ width: 100%; border-collapse: collapse; }}
    th {{ background: #f1f3f4; padding: 10px; text-align: right; }}
    td {{ padding: 8px 10px; border-bottom: 1px solid #f1f3f4; }}
    .updated {{ color: #888; font-size: 13px; margin-top: 5px; }}
  </style>
</head>
<body>
  <h1>📬 דשבורד בוט מיילים</h1>
  <p class="updated">עודכן: {now}</p>

  <div class="card">
    <div class="stat"><div class="stat-num">{total}</div>סה"כ מיילים</div>
  </div>

  <div class="card">
    <h2>📊 לפי קטגוריה</h2>
    <table>
      <tr><th>קטגוריה</th><th>כמות</th><th>גרף</th><th>%</th></tr>
      {cat_rows}
    </table>
  </div>

  <div class="card">
    <h2>👤 שולחים מובילים</h2>
    <table>
      <tr><th>שולח</th><th>מיילים</th></tr>
      {sender_rows}
    </table>
  </div>
</body>
</html>"""

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"📊 דשבורד עודכן: {path}")
    return path


# ================= SAVE =================
def save_email(gmail_id: str, sender: str, subject: str, category: str):
    cursor.execute(
        "INSERT OR IGNORE INTO emails (gmail_id, sender, subject, category) VALUES (?, ?, ?, ?)",
        (gmail_id, sender, subject, category),
    )
    conn.commit()


def already_processed(gmail_id: str) -> bool:
    cursor.execute("SELECT 1 FROM emails WHERE gmail_id = ?", (gmail_id,))
    return cursor.fetchone() is not None


# ================= MAIN =================
def run():
    print("🔗 מתחבר ל-Gmail...")
    service = get_service()

    # ארכיב מיילים ישנים
    archive_old_emails(service)

    print("📥 שולף מיילים חדשים...")
    all_messages = get_inbox_messages(service)
    new_messages = [m for m in all_messages if not already_processed(m["id"])]
    print(f"📬 חדשים לעיבוד: {len(new_messages)}\n")

    stats = {k: 0 for k in LABELS}
    urgent_msgs = []

    for i, msg in enumerate(new_messages, 1):
        msg_id = msg["id"]
        try:
            email_data = get_message_detail(service, msg_id)
        except Exception as e:
            print(f"  ❌ שגיאה: {e}")
            continue

        subject  = decode_subject(email_data.get("Subject", ""))
        sender   = str(email_data.get("From", "(לא ידוע)"))
        body     = extract_body(email_data)
        category = classify_email(subject, sender, body)
        label    = LABELS.get(category, "General")
        urgent   = is_urgent(subject, body) or category in URGENT_CATEGORIES

        print(f"[{i}/{len(new_messages)}] {subject[:55]}")
        print(f"   ➜ {label}{'  ⭐ דחוף' if urgent else ''}")

        apply_label(service, msg_id, label)

        if urgent:
            star_message(service, msg_id)
            urgent_msgs.append(f"⭐ {label}: {subject[:50]}")

        save_email(msg_id, sender, subject, category)
        stats[category] = stats.get(category, 0) + 1

        if category == "spam":
            service.users().messages().trash(userId="me", id=msg_id).execute()

    # Telegram — התראות על דחופים
    if urgent_msgs:
        msg = "🚨 מיילים דחופים:\n" + "\n".join(urgent_msgs[:10])
        send_telegram(msg)

    # סיכום יומי
    if sum(stats.values()) > 0:
        send_daily_summary(service, stats)

    # דשבורד
    generate_dashboard()

    print("\n✅ סיום! סיכום:")
    for cat, count in stats.items():
        if count:
            print(f"   {LABELS[cat]}: {count}")


if __name__ == "__main__":
    run()
