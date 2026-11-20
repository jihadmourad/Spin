# Rassif Spin & Win

Spin-the-wheel promotion for Rassif. Black-and-white design per the Rassif brandbook.

## What it does

1. **Customer** enters name and phone, then spins the wheel.
2. The **server** picks the prize using the percentages set in the admin (the browser never decides the outcome).
3. The customer sees the prize, then must **leave a Google review** (button opens the review page) and confirm.
4. Each phone number can spin **once**. Lebanese numbers are normalised (`70 111 222`, `070111222`, `+961 70 111 222` all count as one number).
5. **Admin dashboard** at `/admin`:
   - Entries: name, phone, prize, spin time, whether the review link was clicked and whether the review was confirmed. Search and **Export to Excel (.xlsx)**.
   - Wheel fields: add, rename, reweight (%), reorder, enable/disable, delete.
   - Links: Instagram, Facebook, Google review.
   - Users: three admin accounts; each can change their own password.

## Run locally

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`).

```bash
npm install
ADMIN_USERS='jm:first-password,salma:second-password,Rassif:third-password' npm run seed:admins
npm start          # http://localhost:3000  (admin: /admin)
npm test
```

`seed:admins` creates or updates exactly the accounts you pass in `ADMIN_USERS`, as `username:password` pairs separated by commas (a JSON array also works). Passwords in the simple format must not contain commas. Passwords are never written to the repository and are stored hashed (scrypt). Run it again whenever you want to reset a password.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/spin.db` | SQLite file. Put it on a persistent disk in production |
| `NODE_ENV` | — | Set to `production` to send the admin cookie with `Secure` (HTTPS only) |

## Notes and limits

- **Review verification:** Google does not tell us whether a review was posted. The "I left a review" button is trust-based and is recorded as a click plus a confirmation.
- **Wheel placeholder:** the six prizes and their percentages are placeholders. Set the real ones in *خانات العجلة*; the percentages should total 100%.
- **Logo:** `public/assets/logo-black.png` and `logo-white.png` were cut from the brandbook cover logo (no shadow, one colour).
- **Fonts:** Montserrat and Rubik are loaded from Google Fonts.
