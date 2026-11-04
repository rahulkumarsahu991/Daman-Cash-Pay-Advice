# Daman Group — Cash Pay Advices

A simple one-page website to record **cash paid to drivers** with the **receipt photo**,
and to check a driver's **payment history**. Works on any phone, tablet or computer.

- **New Payment** tab: Vehicle Number, Driver ID, Driver Name, Mobile Number, Amount, Remark,
  Receipt Photo, Uploaded By → **Submit**. A driver who was paid before: name + mobile fill in by themselves.
- **Payment History** tab: type a driver ID or name → total paid, number of payments and every payment
  with its receipt photo (tap the photo to see it big).
- Every payment is saved in a **Google Sheet** (tab `Payments`) and the photo in **Google Drive**
  → `Daman Cash Pay Advices / <DRIVER ID> - <Name> /`. Each payment gets a number: `CPA00001`, `CPA00002`, …

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The website |
| `config.js` | **Paste your Apps Script URL here** |
| `Code.gs` | Google Apps Script (saves to Sheet + Drive) — paste into Apps Script, **do not publish** |
| `mock-api.js` | Demo mode only (while `APPS_SCRIPT_URL` is empty) |
| `logo.webp`, `icon-*.png`, `manifest.webmanifest` | Logo and phone home-screen icon |

## Go live (one time)

1. Create a new Google Sheet, e.g. **Daman Cash Pay Advices**.
2. In the Sheet: **Extensions → Apps Script**. Delete the sample code, paste all of `Code.gs`, **Save**.
3. (Recommended) set `ACCESS_PIN: '1234'` at the top of Code.gs — staff type it once per phone.
4. Select the function **setup** → **▶ Run** → allow the permissions.
5. **Deploy → New deployment → Web app** — Execute as: **Me**, Who has access: **Anyone** → **Deploy**.
6. Copy the **Web app URL** (ends with `/exec`) into `config.js` → `APPS_SCRIPT_URL: "…/exec"`.

After changing Code.gs later: **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy**.

When hosting the website (Vercel / GitHub Pages), upload everything **except `Code.gs`** (it holds your PIN).
