# Clearing a crew tablet or phone before go-live

**Do this on every device that has opened the portal before.** It takes about two
minutes per device. A device that skips it is the one thing that can put pilot
records into the live system.

## Why — the short version

The web address is not changing, so a device that has used the portal before
still holds a copy of the old app and any patient forms it never managed to
send. Clearing the device throws both away and makes it fetch everything fresh.

Two things go wrong on a device that is not cleared:

1. **It runs old software.** It keeps serving the version it downloaded weeks
   ago, including printing faults on the PDF that have since been fixed. Simply
   opening the app does not update it.
2. **It can upload old practice forms into the live system**, where they are
   indistinguishable from real patient records. The system refuses foreign
   records automatically — but only for forms queued after 29 July 2026, and
   these devices were last used on 23 July.

## Before you clear a device — check for unsent work

Clearing **permanently deletes** anything the device has not yet sent.

Open the app while it has signal and look at the sync indicator. If it shows
anything unsent, wait for it to finish and reach zero before clearing. If it
never clears, do **not** wipe that device — set it aside and flag it, because
something on it has not reached the server.

For practice/pilot forms this does not matter and you can clear regardless. If
you are unsure whether a form is real, treat it as real.

---

## Android — Chrome

1. Open **Settings** (the phone's settings, not Chrome's).
2. **Apps** → **Chrome** → **Storage & cache**.
3. Tap **Manage space** → **Clear site data** — or, in Chrome itself:
   **⋮** → **Settings** → **Site settings** → **All sites** →
   `portal.emsmca.co.za` → **Delete data**.
4. Confirm.

## Android — installed app (the icon on the home screen)

1. Clear the site data as above (the installed app shares Chrome's storage).
2. **Uninstall** the portal icon by long-pressing it → **Uninstall**.
3. Reinstall it after step 2 of the verification below.

## iPhone / iPad — Safari

1. **Settings** → **Apps** → **Safari** → **Advanced** → **Website Data**.
2. Search for `emsmca`.
3. Swipe left on `portal.emsmca.co.za` → **Delete**.

If the portal was added to the Home Screen, delete that icon too and re-add it
afterwards.

## Any device — the quick alternative

If the menus above are hard to find, this achieves the same thing:

- Chrome: **⋮** → **Delete browsing data** → **Advanced** → time range
  **All time** → tick **Cookies and site data** *and* **Cached images and
  files** → **Delete data**.
- Safari: **Settings** → **Apps** → **Safari** → **Clear History and Website
  Data**.

This clears other sites too, which is usually fine on a work device.

---

## Verify it worked — do not skip this

1. Open `https://portal.emsmca.co.za` (type it, or use the saved bookmark).
2. **The app must ask for the company password again.**

That prompt is the proof. The company password unlock is stored in the same
place as everything else being cleared, so if the app goes straight to the crew
list, **the device was not cleared** — go back and repeat, using the quick
alternative above.

3. Confirm the sync indicator shows nothing outstanding.

> **Never reach the portal by typing an IP address**, even if someone offers one
> as a workaround. It will show a certificate warning, and a crew trained to tap
> through that warning will tap through a real one.

---

## Timing

Clear devices **before** the changeover, not after. A device that is opened
after the changeover but before it is cleared is exactly the case this is meant
to prevent.

After clearing, the device may sit unused until the shift — that is fine.
Nothing expires.

---

## Tick list

Give this to whoever holds the devices. A device is not done until the middle
column is ticked, because that is the only part that proves anything.

| Device (crew / callsign) | Asked for the company password after clearing? | Cleared by | Time |
|---|---|---|---|
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

---

## If something looks wrong on the day

- **App asks for the company password and nobody knows it** — it is set per
  company in Client Settings and can be reset there. Crews cannot start a shift
  without it.
- **A crew's name is missing from the list** — the device unlocked but the crew
  record has not been created yet. That is a setup step, not a device fault.
- **A form will not send** — leave it on the device. It is kept, not lost, and
  it will send when the connection recovers. Do not clear that device.
