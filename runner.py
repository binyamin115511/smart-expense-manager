import time
import traceback
from email_bot import run

INTERVAL = 30 * 60  # 30 דקות

print("🤖 בוט מיילים מופעל — רץ כל 30 דקות")

while True:
    try:
        run()
    except Exception:
        traceback.print_exc()
    print(f"💤 ממתין 30 דקות...\n")
    time.sleep(INTERVAL)
